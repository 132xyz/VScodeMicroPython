from __future__ import annotations

import asyncio
import json
import os
import sys
import tempfile
import unittest
from io import StringIO
from pathlib import Path
from unittest import mock


SCRIPTS_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

from mpyrepl import bootstrap

bootstrap.configure_import_path()

from mpyrepl.manager.protocol import READY_MARKER, RpcMethodError, encode_json_line
from mpyrepl.manager.server import ManagerServer, _fs_payload, _optional_float, _optional_int, run_manager_async
from mpyrepl.runtime.models import ReplConfig


class FakeSession:
    def __init__(self) -> None:
        self.opened = False
        self.closed = False
        self.cancelled = False
        self.interrupted = False
        self.connected_port = ""
        self.connected_baudrate = 0
        self.disconnected = False
        self.reconnect_timeout = 0.0
        self.reset = False
        self.reset_timeout = None
        self.executed = ""
        self.execute_instrument = True
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

    async def reconnect(self, timeout: float) -> dict:
        self.reconnect_timeout = timeout
        return self.status()

    async def connect(self, port: str, baudrate: int | None, timeout: float) -> dict:
        self.connected_port = port
        self.connected_baudrate = baudrate or 0
        self.reconnect_timeout = timeout
        return self.status()

    async def disconnect(self) -> dict:
        self.disconnected = True
        return {**self.status(), "state": "stopped"}

    async def soft_reset(self, operation_timeout=None) -> bool:
        self.reset = True
        self.reset_timeout = operation_timeout
        return True

    async def execute(self, source: str, follow_timeout=None, instrument=True) -> dict:
        self.executed = source
        self.execute_instrument = instrument
        return {"stdout": source, "stderr": ""}

    async def complete(self, text: str, cursor=None, requested=True) -> list[dict]:
        return [{"text": text, "startPosition": 0, "display": text, "meta": "fake"}]

    def clear_runtime_cache(self) -> bool:
        return True

    async def fs_operation(self, op: str, payload: dict):
        self.fs_calls.append((op, payload))
        return {"op": op, "path": payload.get("path")}


class ManagerServerTests(unittest.IsolatedAsyncioTestCase):
    async def test_cancelling_request_task_does_not_release_a_running_serial_worker(self) -> None:
        session=FakeSession(); server=ManagerServer("tok"); await server.start(session)
        started, release = asyncio.Event(), asyncio.Event()
        async def operation():
            started.set(); await release.wait(); return True
        request=asyncio.create_task(server._run_serial_operation("fs.listdir", {}, operation))
        await started.wait(); request.cancel(); await asyncio.sleep(0)
        self.assertTrue(server._operation_lock.locked())
        release.set()
        with self.assertRaises(asyncio.CancelledError): await request
        self.assertFalse(server._operation_lock.locked())
        await server.close()

    async def test_stdout_events_precede_result_on_the_same_socket(self) -> None:
        server=ManagerServer("tok")
        class OutputSession(FakeSession):
            async def execute(self, *args):
                server.emit_event("stdout", {"text": "["})
                server.emit_event("stdout", {"text": "2031616, null]\r\n"})
                return {"stdout": "[2031616, null]\r\n", "stderr": ""}
        await server.start(OutputSession())
        reader,writer=await asyncio.open_connection(server.host,server.port)
        await reader.readline()
        writer.write(encode_json_line({"id":"run","token":"tok","method":"repl.exec","params":{"source":"pass"}}).encode())
        await writer.drain()
        try:
            values=[json.loads(await asyncio.wait_for(reader.readline(),1)) for _ in range(3)]
            self.assertEqual([value.get("event") for value in values], ["stdout", "stdout", None])
            self.assertEqual(values[1]["payload"]["sequence"], values[0]["payload"]["sequence"] + 1)
            self.assertEqual(values[2]["id"], "run")
        finally:
            await _close_test_writer(writer); await server.close()

    async def test_queued_request_cancel_and_status_use_same_connection_without_interrupting_owner(self) -> None:
        class BusySession(FakeSession):
            def __init__(self):
                super().__init__()
                self.started = asyncio.Event()
                self.release = asyncio.Event()
            async def execute(self, *args):
                self.started.set()
                await self.release.wait()
                return {"stdout": "", "stderr": ""}
        session = BusySession(); server = ManagerServer("tok")
        await server.start(session)
        first = asyncio.create_task(server._dispatch("repl.exec", {"source": "owner"}, "owner"))
        await session.started.wait()
        reader, writer = await asyncio.open_connection(server.host, server.port)
        await reader.readline()
        try:
            for ident, method, params in [
                ("queued", "fs.listdir", {"path": "/sd"}),
                ("status", "manager.status", {}),
                ("cancel", "request.cancel", {"requestId": "queued"}),
            ]:
                writer.write(encode_json_line({"id": ident, "token": "tok", "method": method, "params": params}).encode())
            await writer.drain()
            replies = {}
            for _ in range(3):
                item = json.loads(await asyncio.wait_for(reader.readline(), 1.0))
                replies[item["id"]] = item
            self.assertTrue(replies["status"]["ok"])
            self.assertTrue(replies["cancel"]["result"]["cancelled"])
            self.assertEqual(replies["queued"]["error"]["code"], "cancelled")
            self.assertFalse(session.cancelled)
            session.release.set(); await first
            self.assertEqual(session.fs_calls, [])
        finally:
            session.release.set(); await first
            await _close_test_writer(writer); await server.close()

    async def test_cancel_cannot_target_another_connections_request(self) -> None:
        from mpyrepl.manager.server import PendingOperation
        session = FakeSession(); server = ManagerServer("tok")
        await server.start(session)
        owner, other = object(), object()
        context = PendingOperation(owner, "same-id", "repl.exec", "running")
        server._requests[(owner, "same-id")] = context
        try:
            result = await server._dispatch("request.cancel", {"requestId": "same-id"}, "cancel", other)
            self.assertFalse(result["cancelled"])
            self.assertFalse(session.cancelled)
            self.assertFalse(context.cancelled.is_set())
        finally:
            await server.close()

    async def test_running_cancel_keeps_operation_lock_until_interrupt_is_sent(self) -> None:
        from mpyrepl.manager.server import PendingOperation
        class InterruptSession(FakeSession):
            def __init__(self):
                super().__init__()
                self.started = asyncio.Event(); self.interrupt_started = asyncio.Event()
                self.release_exec = asyncio.Event(); self.release_interrupt = asyncio.Event()
            async def execute(self, *args):
                self.started.set(); await self.release_exec.wait()
                return {"stdout": "", "stderr": ""}
            async def cancel(self):
                self.interrupt_started.set(); await self.release_interrupt.wait()
                return True
        session = InterruptSession(); server = ManagerServer("tok"); await server.start(session)
        owner = object(); context = PendingOperation(owner, "run", "repl.exec")
        server._requests[(owner, "run")] = context
        async def run():
            server._contexts[asyncio.current_task()] = context
            return await server._dispatch("repl.exec", {"source": "pass"}, "run", owner)
        executing = asyncio.create_task(run()); await session.started.wait()
        cancelling = asyncio.create_task(server._dispatch("request.cancel", {"requestId": "run"}, "cancel", owner))
        await session.interrupt_started.wait(); session.release_exec.set()
        await asyncio.sleep(0)
        self.assertTrue(server._operation_lock.locked())
        self.assertFalse(executing.done())
        session.release_interrupt.set(); await cancelling; await executing
        self.assertFalse(server._operation_lock.locked())
        await server.close()

    async def test_server_dispatches_requests_and_shutdown(self) -> None:
        session = FakeSession()
        server = ManagerServer("tok")
        await server.start(session)  # type: ignore[arg-type]
        reader, writer = await asyncio.open_connection(server.host, server.port)

        status_event = json.loads((await reader.readline()).decode("utf-8"))
        self.assertEqual(status_event["event"], "status")
        self.assertEqual(status_event["payload"]["clientCount"], 1)

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
        self.assertTrue(session.closed)
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

        self.assertEqual(
            await server._dispatch("manager.status", {}, "1"),
            {
                **session.status(),
                "clientCount": 0,
                "extensionClientCount": 0,
                "replClientCount": 0,
                "agentClientCount": 0,
                "queuedOperationCount": 0,
                "protocolVersion": 1,
            },
        )
        self.assertTrue(await server._dispatch("manager.cancel", {}, "2"))
        self.assertTrue(await server._dispatch("device.interrupt", {}, "3"))
        device_statuses: list[dict] = []
        server.set_device_status_callback(device_statuses.append)
        connect_status = await server._dispatch(
            "device.connect",
            {"port": "COM22", "baudrate": 230400, "connectTimeoutMs": 2500},
            "4",
        )
        self.assertEqual(connect_status["state"], "ready")
        disconnected_status = await server._dispatch("device.disconnect", {}, "5")
        self.assertEqual(disconnected_status["state"], "stopped")
        reconnect_status = await server._dispatch("device.reconnect", {"reconnectTimeoutMs": 1250}, "6")
        self.assertEqual(reconnect_status["state"], "ready")
        self.assertTrue(await server._dispatch("device.softReset", {}, "7"))
        self.assertEqual((await server._dispatch("repl.complete", {"text": "abc", "cursor": 1}, "8"))[0]["text"], "abc")
        self.assertTrue(await server._dispatch("repl.clearRuntimeCache", {}, "9"))
        self.assertEqual((await server._dispatch("fs.listdir", {"path": "/"}, "10"))["op"], "listdir")
        self.assertEqual((await server._dispatch("fs.rename", {"src": "/a", "dst": "/b"}, "11"))["op"], "rename")
        self.assertEqual((await server._dispatch("fs.readFile", {"devicePath": "/a", "localPath": "a"}, "12"))["op"], "read_file")
        self.assertEqual((await server._dispatch("fs.writeFile", {"devicePath": "/a", "localPath": "a"}, "13"))["op"], "write_file")
        self.assertEqual((await server._dispatch("fs.exec", {"source": "print(1)"}, "14"))["op"], "exec")
        self.assertTrue(session.cancelled)
        self.assertTrue(session.interrupted)
        self.assertEqual(session.connected_port, "COM22")
        self.assertEqual(session.connected_baudrate, 230400)
        self.assertTrue(session.disconnected)
        self.assertEqual(session.reconnect_timeout, 1.25)
        self.assertTrue(session.reset)
        self.assertIsNone(session.reset_timeout)
        self.assertEqual(len(device_statuses), 2)
        await server.close()

    async def test_hello_registers_client_roles(self) -> None:
        session = FakeSession()
        server = ManagerServer("tok")
        await server.start(session)  # type: ignore[arg-type]
        reader, writer = await asyncio.open_connection(server.host, server.port)
        await reader.readline()

        writer.write(
            encode_json_line(
                {"id": "hello", "token": "tok", "method": "manager.hello", "params": {"role": "agent"}}
            ).encode("utf-8")
        )
        await writer.drain()
        hello = json.loads((await reader.readline()).decode("utf-8"))

        self.assertEqual(hello["result"]["protocolVersion"], 1)
        self.assertEqual(hello["result"]["role"], "agent")
        self.assertIn("device-connect", hello["result"]["capabilities"])
        self.assertIn("device-disconnect", hello["result"]["capabilities"])
        self.assertEqual(hello["result"]["status"]["agentClientCount"], 1)
        await _close_test_writer(writer)
        await server.close()

    async def test_serial_operation_queue_times_out_without_later_execution(self) -> None:
        class BlockingSession(FakeSession):
            def __init__(self) -> None:
                super().__init__()
                self.started = asyncio.Event()
                self.release = asyncio.Event()
                self.sources: list[str] = []

            async def execute(self, source: str, follow_timeout=None, instrument=True) -> dict:
                self.sources.append(source)
                self.started.set()
                await self.release.wait()
                return {"stdout": source, "stderr": ""}

        session = BlockingSession()
        server = ManagerServer("tok")
        await server.start(session)  # type: ignore[arg-type]
        first = asyncio.create_task(server._dispatch("repl.exec", {"source": "first"}, "first"))
        await session.started.wait()

        with self.assertRaisesRegex(RuntimeError, "timed out") as raised:
            await server._dispatch(
                "repl.exec",
                {"source": "second", "queuePolicy": "wait", "queueTimeoutMs": 10},
                "second",
            )
        self.assertEqual(getattr(raised.exception, "code", ""), "queue_timeout")
        session.release.set()
        await first
        await asyncio.sleep(0)
        self.assertEqual(session.sources, ["first"])
        await server.close()

    async def test_soft_reset_passes_protocol_deadline(self) -> None:
        session = FakeSession()
        server = ManagerServer("tok")
        await server.start(session)  # type: ignore[arg-type]
        try:
            self.assertTrue(await server._dispatch("device.softReset", {"softResetTimeoutMs": 1234.5}, "reset"))
            self.assertEqual(session.reset_timeout, 1.2345)
        finally:
            await server.close()

    async def test_soft_reset_rejects_invalid_deadline_before_device_operation(self) -> None:
        session = FakeSession()
        server = ManagerServer("tok")
        await server.start(session)  # type: ignore[arg-type]
        try:
            for value in (0, -1, True, "1000", [], float("inf"), float("nan"), 10 ** 400):
                with self.subTest(value=value), self.assertRaises(RpcMethodError) as raised:
                    await server._dispatch("device.softReset", {"softResetTimeoutMs": value}, "reset")
                self.assertEqual(raised.exception.code, "invalid_params")
                self.assertFalse(session.reset)
        finally:
            await server.close()

    async def test_serial_operation_can_reject_busy_manager(self) -> None:
        class BlockingResetSession(FakeSession):
            def __init__(self) -> None:
                super().__init__()
                self.started = asyncio.Event()
                self.release = asyncio.Event()

            async def soft_reset(self, operation_timeout=None) -> bool:
                self.started.set()
                await self.release.wait()
                return True

        session = BlockingResetSession()
        server = ManagerServer("tok")
        await server.start(session)  # type: ignore[arg-type]
        first = asyncio.create_task(server._dispatch("device.softReset", {}, "first"))
        await session.started.wait()
        with self.assertRaisesRegex(RuntimeError, "busy") as raised:
            await server._dispatch(
                "repl.exec",
                {"source": "later", "queuePolicy": "reject"},
                "second",
            )
        self.assertEqual(getattr(raised.exception, "code", ""), "busy")
        session.release.set()
        await first
        await server.close()

    async def test_zero_queue_timeout_runs_immediately_when_idle(self) -> None:
        session = FakeSession()
        server = ManagerServer("tok")
        await server.start(session)  # type: ignore[arg-type]

        result = await server._dispatch(
            "repl.exec",
            {"source": "now", "queueTimeoutMs": 0},
            "now",
        )

        self.assertEqual(result["stdout"], "now")
        await server.close()

    async def test_disconnected_queued_client_does_not_execute_later(self) -> None:
        class BlockingSession(FakeSession):
            def __init__(self) -> None:
                super().__init__()
                self.started = asyncio.Event()
                self.release = asyncio.Event()
                self.sources: list[str] = []

            async def execute(self, source: str, follow_timeout=None, instrument=True) -> dict:
                self.sources.append(source)
                if source == "first":
                    self.started.set()
                    await self.release.wait()
                return {"stdout": source, "stderr": ""}

        session = BlockingSession()
        server = ManagerServer("tok")
        await server.start(session)  # type: ignore[arg-type]
        first = asyncio.create_task(server._dispatch("repl.exec", {"source": "first"}, "first"))
        await session.started.wait()

        reader, writer = await asyncio.open_connection(server.host, server.port)
        await reader.readline()
        writer.write(
            encode_json_line(
                {
                    "id": "queued",
                    "token": "tok",
                    "method": "repl.exec",
                    "params": {"source": "later", "queueTimeoutMs": 10000},
                }
            ).encode("utf-8")
        )
        await writer.drain()
        await asyncio.sleep(0.05)
        await _close_test_writer(writer)
        await asyncio.sleep(0.1)
        session.release.set()
        await first
        await asyncio.sleep(0.05)

        self.assertEqual(session.sources, ["first"])
        await server.close()

    async def test_dispatch_runs_files_without_interactive_instrumentation(self) -> None:
        session = FakeSession()
        server = ManagerServer("tok")
        await server.start(session)  # type: ignore[arg-type]
        server.emit_event = mock.Mock()

        result = await server._dispatch(
            "repl.exec",
            {"source": "1\nvalue = 2", "instrument": False, "label": "main.py"},
            "run-1",
        )

        self.assertEqual(result["stdout"], "1\nvalue = 2")
        self.assertFalse(session.execute_instrument)
        self.assertEqual(
            server.emit_event.call_args_list,
            [
                mock.call("execution", {"phase": "started", "label": "main.py"}),
                mock.call("execution", {"phase": "finished", "label": "main.py"}),
            ],
        )
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
        with mock.patch("mpyrepl.manager.server.ManagerServer", ShutdownServer), mock.patch(
            "mpyrepl.manager.server.ManagerSession",
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

    async def test_run_manager_async_publishes_and_cleans_descriptor(self) -> None:
        class ShutdownServer(ManagerServer):
            async def serve_until_shutdown(self) -> int:
                await self.close()
                return 0

        class FakeManagerSession(FakeSession):
            def __init__(self, *args, **kwargs) -> None:
                super().__init__()

        publisher = mock.Mock()
        with tempfile.TemporaryDirectory() as temp_dir:
            session_file = str(Path(temp_dir) / "serial-manager.json")
            with mock.patch("mpyrepl.manager.server.ManagerServer", ShutdownServer), mock.patch(
                "mpyrepl.manager.server.ManagerSession",
                FakeManagerSession,
            ), mock.patch(
                "mpyrepl.manager.server.ManagerDescriptorPublisher",
                return_value=publisher,
            ) as publisher_factory:
                result = await run_manager_async(
                    ReplConfig(port="COM5", baudrate=115200),
                    token="tok",
                    session_file=session_file,
                    owner_version="0.4.34",
                    script_path=__file__,
                    ready_stream=StringIO(),
                )

        self.assertEqual(result, 0)
        descriptor = publisher_factory.call_args.args[1]
        self.assertEqual(descriptor.device, "COM5")
        self.assertEqual(descriptor.extensionVersion, "0.4.34")
        publisher.publish.assert_called_once()
        publisher.close.assert_called_once()

    async def test_connect_rpc_rejects_non_positive_timeout(self) -> None:
        server = ManagerServer("tok")
        await server.start(FakeSession())  # type: ignore[arg-type]

        with self.assertRaises(RpcMethodError) as raised:
            await server._dispatch(
                "device.connect",
                {"port": "COM5", "connectTimeoutMs": 0},
                "connect",
            )

        self.assertEqual(raised.exception.code, "invalid_params")
        await server.close()

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
