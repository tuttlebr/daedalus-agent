import importlib.util
from pathlib import Path

RUNNER_PATH = (
    Path(__file__).resolve().parents[2]
    / "helm"
    / "daedalus"
    / "files"
    / "autonomous-agent-runner.py"
)


def load_runner_module():
    spec = importlib.util.spec_from_file_location(
        "autonomous_agent_runner", RUNNER_PATH
    )
    module = importlib.util.module_from_spec(spec)
    assert spec is not None and spec.loader is not None
    spec.loader.exec_module(module)
    return module


class TestAutonomousAgentRunnerAsyncPinning:
    def test_resolve_async_backend_bases_uses_headless_service_ips(self, monkeypatch):
        module = load_runner_module()

        monkeypatch.setattr(module, "IS_ASYNC_WORKFLOW", True)
        monkeypatch.setenv("KUBERNETES_SERVICE_HOST", "10.0.0.1")
        monkeypatch.setattr(module.random, "shuffle", lambda items: None)
        monkeypatch.setattr(
            module.socket,
            "getaddrinfo",
            lambda host, port, type=None: [  # noqa: ARG005
                (0, 0, 0, "", ("10.0.2.61", port)),
                (0, 0, 0, "", ("10.0.3.154", port)),
                (0, 0, 0, "", ("10.0.2.61", port)),
            ],
        )

        bases = module._resolve_async_backend_bases(
            "http://daedalus-backend-default.daedalus.svc.cluster.local:8000"
        )

        assert bases == [
            "http://10.0.2.61:8000",
            "http://10.0.3.154:8000",
        ]

    def test_call_backend_async_pins_submit_and_poll_to_same_backend_base(
        self, monkeypatch
    ):
        module = load_runner_module()
        monkeypatch.setattr(module, "BACKEND_API_PATH", "/v1/workflow/async")

        post_urls = []
        get_urls = []

        class Response:
            def __init__(self, payload, status_code=200):
                self._payload = payload
                self.status_code = status_code

            def raise_for_status(self):
                if self.status_code >= 400:
                    raise module.requests.exceptions.HTTPError("boom")

            def json(self):
                return self._payload

        monkeypatch.setattr(
            module,
            "_resolve_async_backend_bases",
            lambda base_url: [  # noqa: ARG005
                "http://10.0.2.61:8000",
                "http://10.0.3.154:8000",
            ],
        )
        monkeypatch.setattr(module.uuid, "uuid4", lambda: "job-123")
        monkeypatch.setattr(module.time, "sleep", lambda _: None)

        monotonic_values = iter([0, 1])
        monkeypatch.setattr(module.time, "monotonic", lambda: next(monotonic_values))

        def fake_post(url, json, timeout):  # noqa: ARG001
            post_urls.append(url)
            return Response({"status": "submitted"})

        def fake_get(url, timeout):  # noqa: ARG001
            get_urls.append(url)
            return Response({"status": "success", "output": {"value": "done"}})

        monkeypatch.setattr(module.requests, "post", fake_post)
        monkeypatch.setattr(module.requests, "get", fake_get)

        result = module._call_backend_async([{"role": "user", "content": "hi"}])

        assert result == "done"
        assert post_urls == ["http://10.0.2.61:8000/v1/workflow/async"]
        assert get_urls == ["http://10.0.2.61:8000/v1/workflow/async/job/job-123"]
