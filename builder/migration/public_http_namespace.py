"""Join built backends to the isolated public-service fixture using byte relays.

Only disposable Unix sockets cross the network namespace boundary. Model and
Redis services retain their actual HTTP/TLS protocols and loopback listeners;
the public DNS/TLS peer and backend share a networkless container namespace.
"""

import contextlib
import json
import os
import select
import socket
import socketserver
import threading
import time
import uuid
from pathlib import Path


@contextlib.contextmanager
def forward(listen, target):
    class Handler(socketserver.BaseRequestHandler):
        def handle(self):
            family = socket.AF_UNIX if isinstance(target, str) else socket.AF_INET
            try:
                with socket.socket(family, socket.SOCK_STREAM) as upstream:
                    upstream.settimeout(3)
                    upstream.connect(target)
                    upstream.settimeout(None)
                    while True:
                        ready, _, _ = select.select([self.request, upstream], [], [])
                        for source in ready:
                            data = source.recv(65536)
                            if not data:
                                return
                            destination = (
                                upstream if source is self.request else self.request
                            )
                            destination.sendall(data)
            except (OSError, ConnectionError):
                return

    parent = (
        socketserver.UnixStreamServer
        if isinstance(listen, str)
        else socketserver.TCPServer
    )

    class Server(socketserver.ThreadingMixIn, parent):
        allow_reuse_address = True
        daemon_threads = True
        request_queue_size = 128

    server = Server(listen, Handler)
    if isinstance(listen, str):
        owner = Path(listen).parent.stat()
        os.chown(listen, owner.st_uid, owner.st_gid)
        os.chmod(listen, 0o600)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
        if isinstance(listen, str):
            Path(listen).unlink(missing_ok=True)


def inside_namespace(stack, root, ports):
    """Called by the disposable peer, never by a production backend."""
    for name in ports.keys() - {"runtime"}:
        stack.enter_context(
            forward(("127.0.0.1", ports[name]), str(root / f"{name}.sock"))
        )
    stack.enter_context(
        forward(str(root / "runtime.sock"), ("127.0.0.1", ports["runtime"]))
    )
    stack.enter_context(forward(str(root / "control.sock"), ("127.0.0.1", 9090)))


def fixture(python_image, *, minimal, extra_ports=()):
    @contextlib.contextmanager
    def namespace(root, model_port, redis_port, runtime_port):
        import httpx
        from image_check import run
        from public_http_check import PYTHON, ROOT, certificate

        public = root / "public"
        public.mkdir()
        certificate(public)
        (public / "resolv.conf").write_text(
            "nameserver 127.0.0.1\noptions timeout:1 attempts:1\n"
        )
        ports = {"model": model_port, "redis": redis_port, "runtime": runtime_port}
        for index, port in enumerate(sorted(set(extra_ports) - set(ports.values()))):
            ports[f"extra-{index}"] = port
        (root / "namespace.json").write_text(json.dumps(ports))
        name = "daedalus-public-namespace-" + uuid.uuid4().hex[:12]
        with contextlib.ExitStack() as stack:
            for target, port in ports.items():
                if target == "runtime":
                    continue
                stack.enter_context(
                    forward(str(root / f"{target}.sock"), ("127.0.0.1", port))
                )
            try:
                run(
                    "docker",
                    "run",
                    "--detach",
                    "--name",
                    name,
                    "--network",
                    "none",
                    "--cap-add",
                    "NET_ADMIN",
                    "--user",
                    "0",
                    "-v",
                    f"{ROOT / 'migration'}:/migration:ro",
                    "-v",
                    f"{root}:/fixture",
                    "--entrypoint",
                    PYTHON,
                    python_image,
                    "/migration/public_http_peer.py",
                    "--root",
                    "/fixture/public",
                    "--bridge",
                    "/fixture/namespace.json",
                    capture_output=True,
                )
                control = stack.enter_context(
                    httpx.Client(
                        transport=httpx.HTTPTransport(uds=str(root / "control.sock")),
                        base_url="http://fixture",
                        timeout=10,
                        trust_env=False,
                    )
                )
                deadline = time.monotonic() + 15
                while True:
                    try:
                        control.get("/state").raise_for_status()
                        break
                    except httpx.TransportError:
                        if time.monotonic() >= deadline:
                            log = run(
                                "docker", "logs", name, capture_output=True, text=True
                            )
                            raise RuntimeError(
                                "Public namespace failed to start: "
                                + log.stdout
                                + log.stderr
                            ) from None
                        time.sleep(0.05)
                stack.enter_context(
                    forward(("127.0.0.1", runtime_port), str(root / "runtime.sock"))
                )
                mounts = [
                    (public / "resolv.conf", "/etc/resolv.conf"),
                    (public / "roots.pem", "/workspace/runtime-public-ca.pem"),
                ]
                if not minimal:
                    mounts.append(
                        (
                            public / "roots.pem",
                            "/workspace/.venv/lib/python3.12/site-packages/certifi/cacert.pem",
                        )
                    )
                yield {
                    "network": "container:" + name,
                    "mounts": mounts,
                    "control": control,
                }
            finally:
                run("docker", "rm", "--force", name, check=False, capture_output=True)

    return namespace
