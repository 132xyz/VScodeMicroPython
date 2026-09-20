"""Incremental framing for internal replies mixed with console output."""

from __future__ import annotations

import secrets
from typing import Callable


MAX_FRAME_BYTES = 4 * 1024 * 1024


def new_nonce() -> str:
    return secrets.token_hex(12)


def frame_prefix(nonce: str) -> bytes:
    return ("\x1eMPY:" + nonce + ":").encode("ascii")


def encode_frame(nonce: str, payload: bytes) -> bytes:
    return frame_prefix(nonce) + str(len(payload)).encode("ascii") + b":" + payload + b"\x1f"


def emitter_source(nonce: str, name: str = "__mpy_emit") -> str:
    """Device-side emitter; the length counts encoded bytes, not characters."""
    return (
        "def %s(payload):\n" % name
        + "    import sys\n"
        + "    data = payload.encode('utf-8')\n"
        + "    sys.stdout.write(%r + str(len(data)) + ':' + payload + '\\x1f')\n"
        % frame_prefix(nonce).decode("ascii")
    )


class ResponseStream:
    """Remove only validated, request-specific frames; preserve all other bytes."""

    def __init__(self, nonce: str, frame: Callable[[bytes], None], console: Callable[[bytes], None]) -> None:
        self.prefix = frame_prefix(nonce)
        self.frame = frame
        self.console = console
        self.pending = b""
        self.error = ""

    def feed(self, data: bytes) -> None:
        self.pending += data
        while self.pending:
            start = self.pending.find(self.prefix)
            if start < 0:
                keep = min(len(self.pending), len(self.prefix) - 1)
                while keep and not self.prefix.startswith(self.pending[-keep:]):
                    keep -= 1
                emit = len(self.pending) - keep
                if emit:
                    self.console(self.pending[:emit])
                    self.pending = self.pending[emit:]
                return
            if start:
                self.console(self.pending[:start])
                self.pending = self.pending[start:]
            header_end = self.pending.find(b":", len(self.prefix))
            if header_end < 0:
                if len(self.pending) > len(self.prefix) + 10:
                    self._invalid()
                    continue
                return
            header = self.pending[len(self.prefix):header_end]
            if not header.isdigit() or len(header) > 8 or int(header) > MAX_FRAME_BYTES:
                self._invalid()
                continue
            end = header_end + 1 + int(header)
            if len(self.pending) <= end:
                return
            if self.pending[end:end + 1] != b"\x1f":
                self._invalid()
                continue
            payload = self.pending[header_end + 1:end]
            self.pending = self.pending[end + 1:]
            self.frame(payload)

    def _invalid(self) -> None:
        self.error = "internal response frame is malformed or interleaved"
        # No character guessing: preserve the unclassified bytes for the console.
        self.console(self.pending[:1])
        self.pending = self.pending[1:]

    def finish(self) -> None:
        if self.pending:
            if self.pending.startswith(self.prefix):
                self.error = "internal response frame is incomplete"
            self.console(self.pending)
            self.pending = b""
