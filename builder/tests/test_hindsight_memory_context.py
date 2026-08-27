import asyncio

import nat_helpers.hindsight_memory_context as context


def run(coro):
    return asyncio.run(coro)


class FakeBootstrapClient:
    def __init__(self):
        self.config_updates = []
        self.created_pages = []
        self.config_reads = 0

    async def get_bank_config(self, **_kwargs):
        self.config_reads += 1
        return {"overrides": {"retain_mission": "operator custom mission"}}

    async def update_bank_config(self, **kwargs):
        self.config_updates.append(kwargs["updates"])
        return {"overrides": kwargs["updates"]}

    async def knowledge_tree(self, **_kwargs):
        return [
            {
                "kind": "page",
                "name": "Daedalus — User Profile & Preferences",
                "children": [],
            }
        ]

    async def create_knowledge_page(self, **kwargs):
        self.created_pages.append(kwargs)
        return {"page_id": f"kp-{len(self.created_pages)}"}


def test_bootstrap_applies_only_missing_overrides_and_missing_pages(monkeypatch):
    client = FakeBootstrapClient()
    context._process_bootstrap_cache.clear()
    context._process_bootstrap_locks.clear()

    async def unavailable_redis():
        raise RuntimeError("redis unavailable")

    monkeypatch.setattr(context, "_redis_client", unavailable_redis)
    run(context.ensure_bank_initialized(client, "alice"))
    run(context.ensure_bank_initialized(client, "alice"))

    assert client.config_reads == 1
    assert len(client.config_updates) == 1
    assert "retain_mission" not in client.config_updates[0]
    assert client.config_updates[0]["enable_observations"] is True
    assert client.config_updates[0]["enable_auto_consolidation"] is True
    assert [item["name"] for item in client.created_pages] == [
        "Daedalus — Active Projects, Decisions & Blockers",
        "Daedalus — Reusable Procedures & Constraints",
    ]
    assert all("tags" not in item for item in client.created_pages)


def test_memory_defense_uses_only_hindsight_supported_actions():
    actions = {rule["action"] for rule in context._MEMORY_DEFENSE["rules"]}

    assert actions <= {"allow", "block", "redact"}
    prompt_injection = next(
        rule
        for rule in context._MEMORY_DEFENSE["rules"]
        if rule["on"] == "prompt_injection"
    )
    assert prompt_injection["action"] == "block"


class FakeContextClient:
    def __init__(self):
        self.recall_queries = []

    async def recall(self, **kwargs):
        self.recall_queries.append(kwargs["query"])
        return [{"text": "An exact remembered fact", "type": "world"}]


def test_layered_context_uses_pages_first_and_raw_recall_for_past_lookup(monkeypatch):
    client = FakeContextClient()

    async def initialized(*_args, **_kwargs):
        return None

    async def brief(*_args, **_kwargs):
        return "Stable user preference"

    async def pages(*_args, **_kwargs):
        return [{"name": "Profile", "body": "The user prefers concise answers."}]

    monkeypatch.setattr(context, "ensure_bank_initialized", initialized)
    monkeypatch.setattr(context, "_session_brief", brief)
    monkeypatch.setattr(context, "_relevant_pages", pages)

    first = run(
        context.build_automatic_memory_context(
            client,
            user_id="alice",
            conversation_id="conversation-1",
            query="Help with this project",
        )
    )
    assert "Stable user preference" in first
    assert "The user prefers concise answers" in first
    assert client.recall_queries == []

    second = run(
        context.build_automatic_memory_context(
            client,
            user_id="alice",
            conversation_id="conversation-1",
            query="What exactly did I decide last time?",
        )
    )
    assert "An exact remembered fact" in second
    assert client.recall_queries == ["What exactly did I decide last time?"]


def test_context_free_greeting_skips_memory_io(monkeypatch):
    client = FakeContextClient()
    calls = []

    async def unexpected(*_args, **_kwargs):
        calls.append(True)
        raise AssertionError("context-free chat must not call memory services")

    monkeypatch.setattr(context, "ensure_bank_initialized", unexpected)
    monkeypatch.setattr(context, "_session_brief", unexpected)
    monkeypatch.setattr(context, "_relevant_pages", unexpected)

    result = run(
        context.build_automatic_memory_context(
            client,
            user_id="alice",
            conversation_id="conversation-1",
            query="Hey!",
        )
    )

    assert result == ""
    assert calls == []
    assert client.recall_queries == []


def test_session_brief_reflects_only_for_explicit_synthesis(monkeypatch):
    class FakeRedis:
        def __init__(self):
            self.values = {}

        async def get(self, key):
            return self.values.get(key)

        async def set(self, key, value, **_kwargs):
            self.values[key] = value
            return True

        async def delete(self, key):
            self.values.pop(key, None)

    class FakeClient:
        def __init__(self):
            self.queries = []

        async def reflect(self, **kwargs):
            self.queries.append(kwargs["query"])
            return "Synthesized memory brief"

    redis = FakeRedis()
    client = FakeClient()

    async def fake_redis_client():
        return redis

    async def closed(_redis):
        return None

    monkeypatch.setattr(context, "_redis_client", fake_redis_client)
    monkeypatch.setattr(context, "close_redis_client", closed)

    routine = run(
        context._session_brief(
            client,
            user_id="alice",
            conversation_id="routine-conversation",
            query="Help me plan this project",
        )
    )
    synthesized = run(
        context._session_brief(
            client,
            user_id="alice",
            conversation_id="synthesis-conversation",
            query="Summarize my memory",
        )
    )

    assert routine == ""
    assert synthesized == "Synthesized memory brief"
    assert len(client.queries) == 1


def test_clear_user_memory_caches_removes_bootstrap_and_all_user_sessions(monkeypatch):
    deleted = []
    patterns = []

    class FakeRedis:
        async def scan_iter(self, *, match, count):
            patterns.append((match, count))
            yield f"{match[:-1]}conversation"

        async def delete(self, *keys):
            deleted.extend(keys)

    async def fake_redis_client():
        return FakeRedis()

    async def closed(_redis):
        return None

    monkeypatch.setattr(context, "_redis_client", fake_redis_client)
    monkeypatch.setattr(context, "close_redis_client", closed)
    bootstrap_cache_id = context._bootstrap_cache_id("alice")
    context._process_bootstrap_cache[bootstrap_cache_id] = 123.0

    run(context.clear_user_memory_caches("alice"))

    assert bootstrap_cache_id not in context._process_bootstrap_cache
    assert len(patterns) == 2
    assert patterns[0][0].startswith("daedalus:memory:session:v1:")
    assert patterns[1][0].startswith("daedalus:memory:session-lock:v1:")
    assert deleted[0] == f"daedalus:memory:bootstrap:{bootstrap_cache_id}"
    assert len(deleted) == 3
