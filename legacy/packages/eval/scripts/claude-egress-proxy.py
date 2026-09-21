#!/usr/bin/env python3
"""Minimal CONNECT proxy for the isolated Claude Code benchmark container.

The task container is attached only to an internal Docker network. This proxy
is the sole dual-homed process and permits TLS tunnels only to explicitly
configured model API hosts. It intentionally does not implement plain HTTP
forwarding, DNS forwarding, authentication, or a general-purpose proxy.
"""

from __future__ import annotations

import json
import os
import select
import socket
import socketserver
import sys
import threading


MAX_HEADER_BYTES = 16 * 1024
BUFFER_BYTES = 64 * 1024
AUDIT_PATH = os.environ.get(
    "PAW_CLAUDE_AUDIT_PATH", "/tmp/paw-claude-egress-audit.jsonl"
)
AUDIT_LOCK = threading.Lock()


def allowed_targets() -> set[tuple[str, int]]:
    raw = os.environ.get("PAW_CLAUDE_ALLOWED_CONNECT", "")
    targets: set[tuple[str, int]] = set()
    for value in raw.split(","):
        value = value.strip().lower()
        if not value:
            continue
        host, separator, port_text = value.rpartition(":")
        if not separator or not host or not port_text.isdigit():
            raise ValueError(f"invalid allowed CONNECT target: {value!r}")
        port = int(port_text)
        if port < 1 or port > 65535:
            raise ValueError(f"invalid allowed CONNECT port: {port}")
        targets.add((host.rstrip("."), port))
    if not targets:
        raise ValueError("PAW_CLAUDE_ALLOWED_CONNECT must not be empty")
    return targets


ALLOWED_TARGETS = allowed_targets()


def audit(event: str, **fields: object) -> None:
    line = json.dumps({"event": event, **fields}, sort_keys=True)
    with AUDIT_LOCK:
        with open(AUDIT_PATH, "a", encoding="utf-8") as audit_file:
            audit_file.write(line + "\n")
            audit_file.flush()
        print(line, flush=True)


class ConnectHandler(socketserver.BaseRequestHandler):
    def handle(self) -> None:
        header = bytearray()
        while b"\r\n\r\n" not in header and len(header) < MAX_HEADER_BYTES:
            chunk = self.request.recv(min(4096, MAX_HEADER_BYTES - len(header)))
            if not chunk:
                return
            header.extend(chunk)
        if b"\r\n\r\n" not in header:
            audit("denied", reason="oversized_or_incomplete_header")
            self.request.sendall(b"HTTP/1.1 431 Request Header Fields Too Large\r\n\r\n")
            return

        try:
            request_line = bytes(header).split(b"\r\n", 1)[0].decode("ascii")
            method, authority, _version = request_line.split(" ", 2)
            host, separator, port_text = authority.rpartition(":")
            target = (host.lower().rstrip("."), int(port_text))
        except (UnicodeDecodeError, ValueError):
            audit("denied", reason="malformed_request")
            self.request.sendall(b"HTTP/1.1 400 Bad Request\r\n\r\n")
            return

        if method != "CONNECT" or not separator or target not in ALLOWED_TARGETS:
            audit(
                "denied",
                reason="target_not_allowlisted",
                method=method,
                authority=authority,
            )
            self.request.sendall(b"HTTP/1.1 403 Forbidden\r\n\r\n")
            return

        try:
            upstream = socket.create_connection(target, timeout=15)
        except OSError as error:
            audit("upstream_error", authority=authority, error=type(error).__name__)
            self.request.sendall(b"HTTP/1.1 502 Bad Gateway\r\n\r\n")
            return

        audit("allowed", authority=authority)
        self.request.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        sockets = [self.request, upstream]
        try:
            while True:
                readable, _, exceptional = select.select(sockets, [], sockets, 60)
                if exceptional or not readable:
                    return
                for source in readable:
                    data = source.recv(BUFFER_BYTES)
                    if not data:
                        return
                    destination = upstream if source is self.request else self.request
                    destination.sendall(data)
        finally:
            upstream.close()


class ThreadingProxy(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    port = int(os.environ.get("PAW_CLAUDE_PROXY_PORT", "3128"))
    with ThreadingProxy(("0.0.0.0", port), ConnectHandler) as server:
        audit(
            "ready",
            port=port,
            allowed=[f"{host}:{target_port}" for host, target_port in sorted(ALLOWED_TARGETS)],
        )
        server.serve_forever()
