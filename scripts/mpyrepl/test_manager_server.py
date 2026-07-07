from __future__ import annotations

import asyncio
import json
import os
import sys
import unittest
from io import StringIO
from unittest import mock


CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
if CURRENT_DIR not in sys.path:
    sys.path.insert(0, CURRENT_DIR)

import bootstrap

bootstrap.configure_import_path()

from manager_protocol import READY_MARKER, encode_json_line
from manager_server import ManagerServer, _fs_payload, _optional_float, _optional_int, run_manager_async
from models import ReplConfig


class FakeSession:
    def __init__(self) -> None:
        self.opened = False
        self.closed = False
        self.cancelled = False
        self.interrupted = False
        self.reset = False
        self.executed = ""
        self.fs_calls: list[tuple[str, dict]] = []

    async def open(self) -> None:
        self.opened = True

    async def close(self) -> None:
        self.closed = True

    def status(self) -> dict:
        return {"state": "ready", "busy": False, "operation": ""}

    async def cancel(self) -> bool:
        self.cancelled = True
        return True

    async def interrupt(self) -> bool:
        self.interrupted = True
        return True

    async def soft_reset(self) -> bool:
        self.reset = True
        return True

    async def execute(self, source: str, follow_timeout=None) -> dict:
        self.executed = source
        return {"stdout": source, "stderr": ""}

    async def complete(self, text: str, cursor=None, requested=True) -> list[dict]:
        return [{"text": text, "startPosition": 0, "display": text, "meta": "fake"}]

    def clear_runtime_cache(self) -> bool:
        return True

    async def fs_operation(self, op: str, payload: dict):
        self.fs_calls.append((op, payload))
        return {"op": op, "path": payload.get("path")}


class ManagerServerTests(unittest.IsolatedAsyncioTestCase):
    async def test_server_dispatches_requests_and_shutdown(self) -> None:
        session = FakeSession()
        server = ManagerServer("tok")
        await server.start(session)  # type: ignore[arg-type]
        reader, writer = await asyncio.open_connection(server.host, server.port)

        status_event = json.loads((await reader.readline()).decode("utf-8"))
        self.assertEqual(status_event["event"], "status")

        writer.write(encode_json_line({"id": "1", "token": "tok", "method": "manager.ping"}).encode("utf-8"))
        await writer.drain()
        ping = json.loads((await reader.readline()).decode("utf-8"))
        self.assertTrue(ping["result"]["pong"])

        writer.write(
            encode_json_line(
                {"id": "2", "token": "tok", "method": "repl.exec", "params": {"source": "print(1)"}}
            ).encode("utf-8")
        )
        await writer.drain()
        exec_response = json.loads((await reader.readline()).decode("utf-8"))
        self.assertEqual(exec_response["result"]["stdout"], "print(1)")

        writer.write(
            encode_json_line(
                {"id": "3", "token": "bad", "method": "manager.status", "params": {}}
            ).encode("utf-8")
        )
        await writer.drain()
        auth_response = json.loads((await reader.readline()).decode("utf-8"))
        self.assertFalse(auth_response["ok"])
        self.assertEqual(auth_response["error"]["code"], "auth")

        writer.write(
            encode_json_line(
                {"id": "4", "token": "tok", "method": "manager.shutdown", "params": {}}
            ).encode("utf-8")
        )
        await writer.drain()
        shutdown = json.loads((await reader.readline()).decode("utf-8"))
        self.assertTrue(shutdown["result"]["closing"])
        await server.serve_until_shutdown()
        await _close_test_writer(writer)

        self.assertTrue(session.opened)
        self.assertTrue(session.closed)
        self.assertEqual(session.executed, "print(1)")

    async def test_server_reports_unsupported_method(self) -> None:
        session = FakeSession()
        server = ManagerServer("tok")
        await server.start(session)  # type: ignore[arg-type]
        reader, writer = await asyncio.open_connection(server.host, server.port)
        await reader.readline()

        writer.write(
            encode_json_line(
                {"id": "1", "token": "tok", "method": "unknown.method", "params": {}}
            ).encode("utf-8")
        )
        await writer.drain()
        response = json.loads((await reader.readline()).decode("utf-8"))
        await _close_test_writer(writer)
        await server.close()

        self.assertFalse(response["ok"])
        self.assertEqual(response["error"]["code"], "unsupported")

    async def test_handle_line_reports_malformed_json_and_emit_event(self) -> None:
        session = FakeSession()
        server = ManagerServer("tok")
        await server.start(session)  # type: ignore[arg-type]
        reader, writer = await asyncio.open_connection(server.host, server.port)
        await reader.readline()

        writer.write(b"{bad\n")
        await writer.drain()
        malformed = json.loads((await reader.readline()).decode("utf-8"))
        self.assertFalse(malformed["ok"])
        self.assertEqual(malformed["error"]["code"], "protocol")

        server.emit_event("status", {"state": "ready"})
        emitted = json.loads((await reader.readline()).decode("utf-8"))
        self.assertEqual(emitted["event"], "status")

        await _close_test_writer(writer)
        await server.close()

    async def test_close_without_start_and_emit_without_loop_are_safe(self) -> None:
        server = ManagerServer("tok")
        server.emit_event("status", {"state": "ready"})
        await server.close()

    async def test_dispatch_covers_side_methods_completion_and_fs(self) -> None:
        session = FakeSession()
        server = ManagerServer("tok")
        await server.start(session)  # type: ignore[arg-type]

        self.assertEqual(await server._dispatch("manager.status", {}, "1"), session.status())
        self.assertTrue(await server._dispatch("manager.cancel", {}, "2"))
        self.assertTrue(await server._dispatch("device.interrupt", {}, "3"))
        self.assertTrue(await server._dispatch("device.softReset", {}, "4"))
        self.assertEqual((await server._dispatch("repl.complete", {"text": "abc", "cursor": 1}, "5"))[0]["text"], "abc")
        self.assertTrue(await server._dispatch("repl.clearRuntimeCache", {}, "6"))
        self.assertEqual((await server._dispatch("fs.listdir", {"path": "/"}, "7"))["op"], "listdir")
        self.assertEqual((await server._dispatch("fs.rename", {"src": "/a", "dst": "/b"}, "8"))["op"], "rename")
        self.assertEqual((await server._dispatch("fs.readFile", {"devicePath": "/a", "localPath": "a"}, "9"))["op"], "read_file")
        self.assertEqual((await server._dispatch("fs.writeFile", {"devicePath": "/a", "localPath": "a"}, "10"))["op"], "write_file")
        self.assertEqual((await server._dispatch("fs.exec", {"source": "print(1)"}, "11"))["op"], "exec")
        self.assertTrue(session.cancelled)
        self.assertTrue(session.interrupted)
        self.assertTrue(session.reset)
        await server.close()

    async def test_run_manager_async_emits_ready_line_with_fake_session(self) -> None:
        class ShutdownServer(ManagerServer):
            async def serve_until_shutdown(self) -> int:
                await self.close()
                return 0

        class FakeManagerSession(FakeSession):
            kwargs = {}

            def __init__(self, *args, **kwargs) -> None:
                FakeManagerSession.kwargs = kwargs
                super().__init__()

        output = StringIO()
        with mock.patch("manager_server.ManagerServer", ShutdownServer), mock.patch(
            "manager_server.ManagerSession",
            FakeManagerSession,
        ):
            result = await run_manager_async(
                ReplConfig(port="COM21", baudrate=115200),
                token="tok",
                helper_version="0.4.22",
                ready_stream=output,
            )

        self.assertEqual(result, 0)
        self.assertEqual(FakeManagerSession.kwargs["helper_version"], "0.4.22")
        self.assertIn(READY_MARKER, output.getvalue())
        self.assertIn('"token":"tok"', output.getvalue())

    def test_fs_payload_accepts_camel_case_paths(self) -> None:
        payload = _fs_payload(
            "fs.writeFile",
            {"devicePath": "/main.py", "localPath": "main.py"},
            "req-1",
        )

        self.assertEqual(payload["path"], "/main.py")
        self.assertEqual(payload["local_path"], "main.py")
        self.assertEqual(payload["request_id"], "req-1")
        self.assertEqual(_fs_payload("fs.remove", {"path": "/x", "recursive": False}, "r")["recursive"], False)
        self.assertEqual(_fs_payload("fs.mkdir", {"path": "/x", "parents": False}, "r")["parents"], False)
        self.assertEqual(_fs_payload("fs.exec", {"source": "x=1"}, "r")["source"], "x=1")
        self.assertEqual(_optional_float(1), 1.0)
        self.assertIsNone(_optional_float("1"))
        self.assertEqual(_optional_int(2), 2)
        self.assertIsNone(_optional_int("2"))


async def _close_test_writer(writer: asyncio.StreamWriter) -> None:
    try:
        writer.close()
        await asyncio.wait_for(writer.wait_closed(), timeout=1.0)
    except Exception:
        pass


if __name__ == "__main__":
    unittest.main()
