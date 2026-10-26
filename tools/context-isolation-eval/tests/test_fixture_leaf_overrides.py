"""Frozen source eligibility never becomes real-web access or a fake verdict."""

import importlib.util
import sys
import types
import unittest
from dataclasses import dataclass
from pathlib import Path
from unittest import mock

SPEC = importlib.util.spec_from_file_location(
    "evaluation_leaf_overrides",
    Path(__file__).resolve().parents[1] / "fixture_leaf_overrides.py",
)
overrides = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(overrides)
SOURCE = "https://example.org/frozen/source"
PEER = "http://127.0.0.1:32145"


@dataclass
class FetchResult:
    status: str
    content: str | None = None
    error: str | None = None


class FixtureHttpError(Exception):
    pass


class SourceClient:
    def __init__(self, *, fail=False):
        self.options = []
        self.calls = []
        self.fail = fail

    def AsyncClient(self, **options):
        self.options.append(options)
        owner = self

        class Client:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *_):
                return False

            async def get(self, url, **fields):
                owner.calls.append({"url": url, **fields})
                if owner.fail:
                    raise FixtureHttpError("not returned in the tool diagnostic")
                return types.SimpleNamespace(
                    text="Frozen source contradicts a universal speedup.",
                    raise_for_status=lambda: None,
                )

        return Client()


class BoundaryTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.verifier = types.SimpleNamespace(FetchResult=FetchResult)
        self.manifest = overrides.install_verifier_boundaries(
            [SOURCE], PEER, verifier_module=self.verifier
        )

    async def test_exact_frozen_source_uses_only_loopback_without_verdict(self):
        client = SourceClient()
        with mock.patch.dict(
            sys.modules,
            {"httpx": types.SimpleNamespace(AsyncClient=client.AsyncClient)},
        ):
            result = await self.verifier._fetch_source(
                SOURCE, types.SimpleNamespace(fetch_timeout=20)
            )
        self.assertEqual(result.status, "ok")
        self.assertIn("contradicts", result.content)
        self.assertEqual(
            client.calls, [{"url": PEER + "/source", "params": {"url": SOURCE}}]
        )
        self.assertEqual(
            client.options,
            [{"timeout": 20, "trust_env": False, "follow_redirects": False}],
        )
        self.assertFalse(self.verifier._is_placeholder_source(SOURCE))
        self.assertEqual(self.verifier._safe_audit_url(SOURCE), (True, None))
        self.assertFalse(self.manifest["verdict_substitution"])

    async def test_unknown_sources_fail_before_any_client_is_created(self):
        client = SourceClient()
        with mock.patch.dict(
            sys.modules,
            {"httpx": types.SimpleNamespace(AsyncClient=client.AsyncClient)},
        ):
            for url in (
                "https://real.example.invalid/unknown",
                SOURCE + "?private=value",
                SOURCE + "/suffix",
                "http://127.0.0.1/private",
                "https://credential@elsewhere.invalid/",
            ):
                with self.subTest(url=url):
                    self.assertTrue(self.verifier._is_placeholder_source(url))
                    self.assertEqual(
                        self.verifier._safe_audit_url(url),
                        (False, "outside_frozen_source_ledger"),
                    )
                    result = await self.verifier._fetch_source(url, object())
                    self.assertEqual(result.status, "invalid_url")
        self.assertEqual(client.options, [])
        self.assertEqual(client.calls, [])

    async def test_failed_frozen_fetch_returns_gap_and_never_a_verdict(self):
        client = SourceClient(fail=True)
        with mock.patch.dict(
            sys.modules,
            {
                "httpx": types.SimpleNamespace(
                    AsyncClient=client.AsyncClient, HTTPError=FixtureHttpError
                )
            },
        ):
            result = await self.verifier._fetch_source(
                SOURCE, types.SimpleNamespace(fetch_timeout=20)
            )
        self.assertEqual(result.status, "unreachable")
        self.assertIsNone(result.content)
        self.assertEqual(result.error, "Frozen source is unavailable")

    def test_configuration_rejects_external_fixture_origins_and_credentials(self):
        for endpoint in (
            "https://127.0.0.1:3000",
            "http://localhost:3000",
            "http://public.invalid:3000",
            "http://127.0.0.1:3000/path",
            "http://credential@127.0.0.1:3000",
            "http://127.0.0.1",
        ):
            with self.subTest(endpoint=endpoint), self.assertRaises(ValueError):
                overrides.install_verifier_boundaries(
                    [SOURCE], endpoint, verifier_module=self.verifier
                )
        for source in (
            "http://example.org/frozen",
            "https://credential@example.org/a",
            " " + SOURCE,
        ):
            with self.subTest(source=source), self.assertRaises(ValueError):
                overrides.install_verifier_boundaries(
                    [source], PEER, verifier_module=self.verifier
                )


class AttributionTests(unittest.TestCase):
    def test_actual_chat_and_responses_system_prompts_identify_critic(self):
        system = overrides.VERIFIER_SYSTEM_PREFIX + "Actual critic rules follow."
        for request in (
            {"messages": [{"role": "system", "content": system}]},
            {
                "input": [
                    {
                        "role": "developer",
                        "content": [{"type": "input_text", "text": system}],
                    }
                ]
            },
            {"instructions": system, "input": "Check the supplied source."},
        ):
            with self.subTest(request=request):
                self.assertTrue(overrides.is_verifier_model_request(request))

    def test_user_quotes_tool_results_and_arbitrary_marker_fields_do_not_label(self):
        system = overrides.VERIFIER_SYSTEM_PREFIX + "Quoted source text."
        for request in (
            {"messages": [{"role": "user", "content": system}]},
            {"input": [{"type": "function_call_output", "output": system}]},
            {"metadata": {"instructions": system}},
            {"instructions": "The source says: " + system},
            {"input": system},
            None,
        ):
            with self.subTest(request=request):
                self.assertFalse(overrides.is_verifier_model_request(request))


if __name__ == "__main__":
    unittest.main()
