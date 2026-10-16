"""Disposable network-namespace fixture; never changes host interfaces or routes."""

import argparse
import base64
import contextlib
import json
import socket
import socketserver
import ssl
import struct
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class FixtureServer(ThreadingHTTPServer):
    # The lifecycle gate intentionally holds more than 64 simultaneous sockets.
    # A tiny listen backlog would test SYN retries rather than the NWS cache.
    request_queue_size = 256


def add_public_loopback():
    """Assign a public-classified IP only to this disposable container's loopback."""
    address = socket.inet_aton("8.8.8.8")
    body = (
        struct.pack("BBBBI", socket.AF_INET, 32, 0, 254, socket.if_nametoindex("lo"))
        + struct.pack("HH", 8, 1)
        + address
        + struct.pack("HH", 8, 2)
        + address
    )
    with socket.socket(
        socket.AF_NETLINK, socket.SOCK_RAW, socket.NETLINK_ROUTE
    ) as netlink:
        netlink.send(struct.pack("IHHII", 16 + len(body), 20, 0x605, 1, 0) + body)
        error = struct.unpack_from("i", netlink.recv(65536), 16)[0]
        if error:
            raise RuntimeError(f"Isolated interface setup failed: {error}")


class Peer:
    def __init__(self):
        self.lock = threading.Lock()
        self.reset({})

    def reset(self, case):
        with self.lock:
            if hasattr(self, "release"):
                self.release.set()
            self.release = threading.Event()
            self.generation = getattr(self, "generation", 0) + 1
            self.case = case
            self.calls, self.dns, self.sni = [], [], []
            self.resolutions = 0
            self.held = self.disconnected = 0

    def dns_handler(self):
        peer = self

        class DNS(socketserver.BaseRequestHandler):
            def handle(self):
                packet, connection = self.request
                offset, labels = 12, []
                while packet[offset]:
                    length = packet[offset]
                    labels.append(
                        packet[offset + 1 : offset + 1 + length].decode("ascii")
                    )
                    offset += 1 + length
                offset += 1
                kind, _ = struct.unpack_from("!HH", packet, offset)
                question = packet[12 : offset + 4]
                with peer.lock:
                    if kind == 1:
                        peer.resolutions += 1
                    plans = peer.case.get("dns", [["8.8.8.8"]])
                    answers = plans[min(max(peer.resolutions - 1, 0), len(plans) - 1)]
                    peer.dns.append(
                        {"host": ".".join(labels), "kind": kind, "answers": answers}
                    )
                records = []
                for address in answers:
                    version = 28 if ":" in address else 1
                    if version == kind:
                        raw = socket.inet_pton(
                            socket.AF_INET6 if version == 28 else socket.AF_INET,
                            address,
                        )
                        records.append(
                            b"\xc0\x0c"
                            + struct.pack("!HHIH", kind, 1, 0, len(raw))
                            + raw
                        )
                flags = 0x8180 if answers else 0x8183
                response = (
                    packet[:2]
                    + struct.pack("!HHHHH", flags, 1, len(records), 0, 0)
                    + question
                    + b"".join(records)
                )
                connection.sendto(response, self.client_address)

        return DNS

    def handler(self, control=False):
        peer = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *_):
                pass

            def reply(self, value):
                raw = json.dumps(value).encode()
                self.send_response_only(200)
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def do_POST(self):
                if not control:
                    body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                    self.respond({"method": "POST", "body": body.decode("utf-8")})
                    return
                if control and self.path == "/release":
                    self.rfile.read(int(self.headers.get("Content-Length", "0")))
                    peer.release.set()
                    self.reply({})
                    return
                if not control or self.path != "/reset":
                    self.send_error(404)
                    return
                peer.reset(
                    json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                )
                self.reply({})

            def do_GET(self):
                if control:
                    with peer.lock:
                        value = {
                            "calls": peer.calls,
                            "dns": peer.dns,
                            "sni": peer.sni,
                            "held": peer.held,
                            "disconnected": peer.disconnected,
                        }
                    self.reply(value)
                    return
                self.respond()

            def respond(self, extra=None):
                with peer.lock:
                    peer.calls.append(
                        {
                            "path": self.path,
                            "headers": {
                                key: self.headers.get(key)
                                for key in [
                                    "host",
                                    "cookie",
                                    "authorization",
                                    "accept-encoding",
                                    "accept",
                                    "user-agent",
                                ]
                            },
                            **(extra or {}),
                        }
                    )
                    if extra:
                        peer.calls[-1]["headers"]["content-type"] = self.headers.get(
                            "content-type"
                        )
                    if peer.case.get("expected_tls_version"):
                        peer.calls[-1]["tls_version"] = self.connection.version()
                    response = peer.case.get("responses", {}).get(self.path, {})
                    hold = response.get("hold", peer.case.get("hold", False))
                    generation, release = peer.generation, peer.release
                    if hold:
                        peer.held += 1
                if hold:
                    old_timeout = self.connection.gettimeout()
                    self.connection.settimeout(0.025)
                    while not release.is_set():
                        try:
                            disconnected = not self.connection.recv(1)
                        except TimeoutError:
                            continue
                        except (ConnectionError, OSError):
                            disconnected = True
                        if disconnected:
                            with peer.lock:
                                if peer.generation == generation:
                                    peer.disconnected += 1
                            self.close_connection = True
                            return
                    self.connection.settimeout(old_timeout)
                body = (
                    base64.b64decode(response["body"])
                    if "body" in response
                    else b'{"weather":"synthetic"}'
                )
                self.send_response_only(response.get("status", 200))
                headers = response.get("headers", {})
                for key, value in headers.items():
                    self.send_header(key, value)
                chunked = response.get("chunked", False)
                if chunked:
                    self.send_header("Transfer-Encoding", "chunked")
                elif "Content-Length" not in headers:
                    self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.flush()
                time.sleep(response.get("delay", 0))
                try:
                    if chunked:
                        for offset in range(0, len(body), 256):
                            chunk = body[offset : offset + 256]
                            self.wfile.write(
                                f"{len(chunk):x}\r\n".encode() + chunk + b"\r\n"
                            )
                            self.wfile.flush()
                        self.wfile.write(b"0\r\n\r\n")
                    else:
                        self.wfile.write(body)
                    self.wfile.flush()
                except (OSError, ConnectionError):
                    pass
                if response.get("close"):
                    self.close_connection = True

        return Handler


def serve(root, bridge=None):
    add_public_loopback()
    peer = Peer()
    dns = socketserver.ThreadingUDPServer(("127.0.0.1", 53), peer.dns_handler())
    plain = FixtureServer(("8.8.8.8", 80), peer.handler())
    secure = FixtureServer(("8.8.8.8", 443), peer.handler())
    secure12 = FixtureServer(("8.8.8.8", 444), peer.handler())
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(root / "server.crt", root / "server.key")
    profiles = {}
    for certificate in root.glob("server-*.crt"):
        profile = certificate.stem.removeprefix("server-")
        selected = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        selected.load_cert_chain(certificate, root / "server.key")
        profiles[profile] = selected

    def server_name(connection, name, _context):
        with peer.lock:
            peer.sni.append(name)
            profile = peer.case.get("tls_profile")
        if profile:
            connection.context = profiles[profile]

    context.set_servername_callback(server_name)
    secure.socket = context.wrap_socket(secure.socket, server_side=True)
    context12 = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context12.maximum_version = ssl.TLSVersion.TLSv1_2
    context12.load_cert_chain(root / "server.crt", root / "server.key")
    context12.set_servername_callback(server_name)
    secure12.socket = context12.wrap_socket(secure12.socket, server_side=True)
    # This process has no external network. Control remains inside its namespace.
    control = FixtureServer(("127.0.0.1", 9090), peer.handler(control=True))
    for server in [dns, plain, secure, secure12]:
        server.daemon_threads = True
        threading.Thread(target=server.serve_forever, daemon=True).start()
    with contextlib.ExitStack() as stack:
        if bridge:
            from public_http_namespace import inside_namespace

            inside_namespace(stack, bridge.parent, json.loads(bridge.read_text()))
        control.serve_forever()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--bridge", type=Path)
    args = parser.parse_args()
    serve(args.root, args.bridge)
