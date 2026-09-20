"""Ordered console rendering with a prompt-owned unfinished line."""

from __future__ import annotations

import asyncio
import threading
from prompt_toolkit.application import get_app_or_none
from prompt_toolkit.application.run_in_terminal import run_in_terminal


class ConsoleLines:
    """Interpret CR/LF across events without forwarding a naked CR to the UI."""

    def __init__(self) -> None:
        self._chars: list[str] = []
        self.cursor = 0
        self.pending_cr = False

    @property
    def tail(self) -> str:
        return "".join(self._chars)

    def feed(self, text: str) -> str:
        complete: list[str] = []
        for char in text:
            if char == "\n":
                complete.append(self.tail + "\n")
                self._chars.clear()
                self.cursor = 0
                self.pending_cr = False
                continue
            if self.pending_cr:
                self.cursor = 0
                self.pending_cr = False
            if char == "\r":
                self.pending_cr = True
                continue
            if char == "\b":
                self.cursor = max(0, self.cursor - 1)
                continue
            if char == "\x1b":
                char = "?"
            if self.cursor < len(self._chars):
                self._chars[self.cursor] = char
            else:
                self._chars.append(char)
            self.cursor += 1
            # Bound a newline-free record without discarding any characters.
            if len(self._chars) >= 65536:
                complete.append(self.tail + "\n")
                self._chars.clear()
                self.cursor = 0
        return "".join(complete)


class LiveOutput:
    """Keep all rendering on one event loop throughout the REPL lifetime."""

    def __init__(self, output) -> None:
        self.output = output
        self.loop = asyncio.get_running_loop()
        self.lines = ConsoleLines()
        self.queue: asyncio.Queue[str | None] = asyncio.Queue()
        self.editing = False
        self.plain_open = False
        self.closed = False
        self._size = 0
        self._size_lock = threading.Lock()
        self._overflow = False
        self.worker = asyncio.create_task(self._run())

    def feed(self, text: str) -> None:
        if text and not self.closed:
            with self._size_lock:
                if self._size + len(text) > 1024 * 1024:
                    if self._overflow:
                        return
                    self._overflow = True
                    text = "\n[mpyrepl] local output queue overflow; some output was not displayed\n"
                self._size += len(text)
            self.loop.call_soon_threadsafe(self.queue.put_nowait, text)

    def write(self, text: str) -> int:
        self.feed(text)
        return len(text)

    def flush(self) -> None:
        # A stream flush must not commit an unfinished line while editing.
        pass

    def message(self):
        app = get_app_or_none()
        tail = self.lines.tail if self.editing and app is not None and not app.is_done else ""
        return [("", tail + "\n" if tail else ""), ("", ">>> ")]

    def _write(self, text: str) -> None:
        self.output.enable_autowrap()
        self.output.write(text)
        self.output.flush()

    async def _run(self) -> None:
        while True:
            text = await self.queue.get()
            try:
                if text is None:
                    return
                if self.editing:
                    complete = self.lines.feed(text)
                    if complete:
                        await run_in_terminal(lambda: self._write(complete))
                    app = get_app_or_none()
                    if app is not None:
                        app.invalidate()
                else:
                    self._write(text)
                    self.plain_open = not text.endswith("\n")
            finally:
                if text is not None:
                    with self._size_lock:
                        self._size = max(0, self._size - len(text))
                        if self._size == 0:
                            self._overflow = False
                self.queue.task_done()

    async def drain(self) -> None:
        await asyncio.sleep(0)
        if self.worker.done():
            self.worker.result()
            return
        joined = asyncio.create_task(self.queue.join())
        try:
            done, _ = await asyncio.wait({joined, self.worker}, return_when=asyncio.FIRST_COMPLETED)
            if self.worker in done:
                self.worker.result()
        finally:
            if not joined.done():
                joined.cancel()
                try:
                    await joined
                except asyncio.CancelledError:
                    pass

    async def begin_prompt(self) -> None:
        await self.drain()
        if self.plain_open:
            self._write("\n")
            self.plain_open = False
        self.editing = True

    async def end_prompt(self) -> None:
        await self.drain()
        self.editing = False
        if self.lines.tail:
            self._write(self.lines.tail)
            self.plain_open = True
        self.lines = ConsoleLines()

    async def close(self) -> None:
        await self.end_prompt()
        self.closed = True
        await self.queue.put(None)
        await self.worker
