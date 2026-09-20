"""One bounded, ordered socket writer per shared-manager client."""

from __future__ import annotations

import asyncio
import json


class ClientOutput:
    def __init__(self, writer, limit: int = 4 * 1024 * 1024) -> None:
        self.writer = writer
        self.limit = limit
        self.size = 0
        self.queue: asyncio.Queue[bytes | None] = asyncio.Queue()
        self.closed = False
        self.worker = asyncio.create_task(self._run())

    def send(self, data: bytes) -> None:
        if self.closed:
            return
        if self.size + len(data) > self.limit:
            self.closed = True
            try:
                self.writer.write((json.dumps({"event": "output_gap", "payload": {
                    "text": "console output queue overflow; slow client disconnected", "pendingBytes": self.size,
                }}) + "\n").encode("utf-8"))
            except (ConnectionError, OSError, RuntimeError):
                pass
            finally:
                self.writer.close()
                self.worker.cancel()
            return
        self.size += len(data)
        self.queue.put_nowait(data)

    async def _run(self) -> None:
        try:
            # Older asyncio.wait_for can return a completed drain result even
            # when close() cancelled us. Do not wait for another queue item.
            while not self.closed:
                data = await self.queue.get()
                try:
                    if data is None:
                        return
                    self.writer.write(data)
                    await asyncio.wait_for(self.writer.drain(), 5.0)
                    self.size -= len(data)
                finally:
                    self.queue.task_done()
        except (ConnectionError, OSError, RuntimeError, asyncio.TimeoutError):
            self.closed = True
            self.writer.close()

    async def close(self) -> None:
        self.closed = True
        self.worker.cancel()
        try:
            await self.worker
        except asyncio.CancelledError:
            pass
