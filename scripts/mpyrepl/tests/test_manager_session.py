from __future__ import annotations

import asyncio
import os
import sys
import unittest
from dataclasses import dataclass
from unittest import mock


SCRIPTS_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

from mpyrepl import bootstrap

bootstrap.configure_import_path()

from mpyrepl.manager import session as manager_session_module
from mpyrepl.manager.protocol import RpcMethodError
from mpyrepl.manager.session import ManagerSession
from mpyrepl.runtime.models import ExecResult, ReplConfig
from mpyrepl.runtime.transport import TransportError


@dataclass
class FakeTransport:
    config: ReplConfig

    def __post_init__(self) -> None:
        self.opened = False
        self.closed = False
        self.raw = False
        self.interrupted = False
        self.executed: list[str] = []

    def open(self) -> None:
        self.opened = True

    def close(self) -> None:
        self.closed = True

    def enter_raw_repl(self, soft_reset: bool, operation_timeout=None) -> None:
        self.raw = True

    def exit_raw_repl(self) -> None:
        self.raw = False

    def interrupt(self) -> None:
        self.interrupted = True

    def soft_reset(self, output_consumer=None) -> None:
        if output_consumer:
            output_consumer(b"soft reboot\r\n")

    def probe_connection(self) -> bool:
        return True

    def exec_raw(self, command: str, timeout=None, stdout_consumer=None, stderr_consumer=None) -> ExecResult:
        self.executed.append(command)
        if "__mpy_helper" in command:
            return ExecResult(stdout=b"", stderr=b"")
        stdout = b"ok\r\n"
        if stdout_consumer:
            stdout_consumer(stdout)
        return ExecResult(stdout=stdout, stderr=b"")


class ErrorTransport(FakeTransport):
    def exec_raw(self, command: str, timeout=None, stdout_consumer=None, stderr_consumer=None) -> ExecResult:
        is_helper_load = len(self.executed) == 0
        self.executed.append(command)
        if is_helper_load:
            return ExecResult(stdout=b"", stderr=b"")
        if stderr_consumer:
            stderr_consumer(b"bad\r\n")
        return ExecResult(stdout=b"", stderr=b"bad\r\n")


class OpenErrorTransport(FakeTransport):
    def open(self) -> None:
        raise OSError("port busy")


class HelperErrorTransport(FakeTransport):
    def exec_raw(self, command: str, timeout=None, stdout_consumer=None, stderr_consumer=None) -> ExecResult:
        self.executed.append(command)
        return ExecResult(stdout=b"", stderr=b"helper failed")


class RecoveringTransport(FakeTransport):
    fail_user_exec_once = True

    def exec_raw(self, command: str, timeout=None, stdout_consumer=None, stderr_consumer=None) -> ExecResult:
        self.executed.append(command)
        if len(self.executed) == 1:
            return ExecResult(stdout=b"", stderr=b"")
        if RecoveringTransport.fail_user_exec_once:
            RecoveringTransport.fail_user_exec_once = False
            raise TransportError("ReadFile failed (PermissionError(13, 'device rejected command'))")
        stdout = b"ok\r\n"
        if stdout_consumer:
            stdout_consumer(stdout)
        return ExecResult(stdout=stdout, stderr=b"")


class InterruptErrorTransport(FakeTransport):
    def interrupt(self) -> None:
        raise TransportError("WriteFile failed")


class SoftResetErrorTransport(FakeTransport):
    def soft_reset(self, output_consumer=None) -> None:
        raise TransportError("ReadFile failed")


class ProbeErrorTransport(FakeTransport):
    def probe_connection(self) -> bool:
        raise TransportError("ClearCommError failed")


class IdleOutputTransport(FakeTransport):
    def __post_init__(self) -> None:
        super().__post_init__()
        self.idle_chunks = [b"background ", "输出\r\n".encode("utf-8"), b""]

    def read_idle_output(self) -> bytes:
        return self.idle_chunks.pop(0) if self.idle_chunks else b""


class ManagerSessionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.events: list[tuple[str, dict]] = []
        self.transport: FakeTransport | None = None

        def factory(config: ReplConfig) -> FakeTransport:
            self.transport = FakeTransport(config)
            return self.transport

        self.session = ManagerSession(
            ReplConfig(port="COM21", baudrate=115200),
            helper_version="0.4.22",
            emit_event=lambda event, payload: self.events.append((event, payload)),
            transport_factory=factory,
        )

    async def test_open_execute_interrupt_soft_reset_and_close(self) -> None:
        await self.session.open()
        result = await self.session.execute("value = 1\nprint('ok')")
        interrupted = await self.session.interrupt()
        reset = await self.session.soft_reset()
        status = self.session.status()
        await self.session.close()

        self.assertEqual(result["stdout"], "ok\r\n")
        self.assertTrue(interrupted)
        self.assertTrue(reset)
        self.assertEqual(status["port"], "COM21")
        self.assertEqual(self.session.state, "stopped")
        self.assertIsNotNone(self.transport)
        assert self.transport is not None
        self.assertTrue(self.transport.opened)
        self.assertTrue(self.transport.closed)
        self.assertTrue(self.transport.interrupted)
        self.assertTrue(any(event == "stdout" for event, _ in self.events))
        helper_loads = [command for command in self.transport.executed if "class __mpy_helper" in command]
        self.assertEqual(len(helper_loads), 2)
        self.assertTrue(all("version = '0.4.22'" in command for command in helper_loads))

    async def test_complete_returns_candidates_from_session_symbols(self) -> None:
        await self.session.open()
        await self.session.execute("value = 1")
        completions = await self.session.complete("val", 3, True)
        await self.session.close()

        self.assertTrue(any(item["text"] == "value" for item in completions))

    async def test_execute_can_preserve_file_source_without_repl_instrumentation(self) -> None:
        await self.session.open()
        await self.session.execute("1\nvalue = 2\n", instrument=False)
        await self.session.execute("1")
        await self.session.close()

        assert self.transport is not None
        self.assertIn("1\nvalue = 2", self.transport.executed)
        self.assertIn("__mpy.print_repl_value(1)", self.transport.executed)

    async def test_clear_runtime_cache_is_safe_before_open(self) -> None:
        self.assertTrue(self.session.clear_runtime_cache())
        await self.session.close()

    async def test_operations_before_open_initialize_transport(self) -> None:
        self.assertTrue(await self.session.interrupt())
        self.assertTrue(await self.session.soft_reset())
        self.assertEqual(await self.session.execute(""), {"stdout": "", "stderr": ""})
        await self.session.close()

    async def test_execute_with_stderr_does_not_record_symbols(self) -> None:
        def factory(config: ReplConfig) -> ErrorTransport:
            self.transport = ErrorTransport(config)
            return self.transport

        session = ManagerSession(
            ReplConfig(port="COM21", baudrate=115200),
            emit_event=lambda event, payload: self.events.append((event, payload)),
            transport_factory=factory,
        )
        await session.open()
        result = await session.execute("bad_call()")
        completions = await session.complete("bad", 3, True)
        await session.close()

        self.assertEqual(result["stderr"], "bad\r\n")
        self.assertFalse(any(item["text"] == "bad_call" for item in completions))
        self.assertTrue(any(event == "stderr" for event, _ in self.events))

    async def test_fs_operation_uses_progress_callback_and_maps_errors(self) -> None:
        await self.session.open()

        def fake_run(client, op, payload):
            payload["progress_callback"]({"bytes": 1, "total": 2})
            return {"ok": op}

        with mock.patch("mpyrepl.manager.session.run_fs_operation", side_effect=fake_run):
            result = await self.session.fs_operation(
                "write_file",
                {"request_id": "req-1", "local_path": "a.py", "path": "/a.py"},
            )

        def fake_error(client, op, payload):
            from mpyrepl.runtime.filesystem import FsOperationError

            raise FsOperationError("boom", "device")

        with mock.patch("mpyrepl.manager.session.run_fs_operation", side_effect=fake_error):
            with self.assertRaisesRegex(RpcMethodError, "boom"):
                await self.session.fs_operation("stat", {"path": "/"})

        await self.session.close()
        self.assertEqual(result, {"ok": "write_file"})
        self.assertTrue(any(event == "progress" for event, _ in self.events))

    async def test_open_failure_sets_failed_state_and_closes_transport(self) -> None:
        transport_holder: dict[str, OpenErrorTransport] = {}

        def factory(config: ReplConfig) -> OpenErrorTransport:
            transport = OpenErrorTransport(config)
            transport_holder["transport"] = transport
            return transport

        session = ManagerSession(
            ReplConfig(port="COM21", baudrate=115200),
            emit_event=lambda event, payload: self.events.append((event, payload)),
            transport_factory=factory,
        )
        with self.assertRaisesRegex(OSError, "port busy"):
            await session.open()

        self.assertEqual(session.state, "failed")
        self.assertTrue(transport_holder["transport"].closed)

    async def test_reconnect_retries_until_reenumerated_device_is_ready(self) -> None:
        transports: list[FakeTransport] = []

        def factory(config: ReplConfig) -> FakeTransport:
            transport: FakeTransport
            if len(transports) < 2:
                transport = OpenErrorTransport(config)
            else:
                transport = FakeTransport(config)
            transports.append(transport)
            return transport

        session = ManagerSession(
            ReplConfig(port="COM21", baudrate=115200),
            emit_event=lambda event, payload: self.events.append((event, payload)),
            transport_factory=factory,
        )

        status = await session.reconnect(0.1, retry_interval=0.001)

        self.assertEqual(status["state"], "ready")
        self.assertEqual(len(transports), 3)
        self.assertTrue(transports[0].closed)
        self.assertTrue(transports[1].closed)
        self.assertTrue(transports[2].opened)
        await session.close()

    async def test_connect_switches_port_and_disconnect_keeps_manager_stopped(self) -> None:
        transports: list[FakeTransport] = []

        def factory(config: ReplConfig) -> FakeTransport:
            transport = FakeTransport(config)
            transports.append(transport)
            return transport

        session = ManagerSession(
            ReplConfig(port="COM21", baudrate=115200),
            emit_event=lambda event, payload: self.events.append((event, payload)),
            transport_factory=factory,
        )
        await session.open()

        connected = await session.connect(" COM22 ", 230400, 0.1)
        disconnected = await session.disconnect()

        self.assertEqual(connected["state"], "ready")
        self.assertEqual(connected["port"], "COM22")
        self.assertEqual(connected["baudrate"], 230400)
        self.assertEqual(disconnected["state"], "stopped")
        self.assertEqual(disconnected["port"], "COM22")
        self.assertEqual(len(transports), 2)
        self.assertTrue(transports[0].closed)
        self.assertTrue(transports[1].closed)

    async def test_connect_rejects_invalid_target_parameters(self) -> None:
        with self.assertRaises(RpcMethodError) as empty_port:
            await self.session.connect(" ", 115200, 1.0)
        with self.assertRaises(RpcMethodError) as bad_baudrate:
            await self.session.connect("COM22", 0, 1.0)
        with self.assertRaises(RpcMethodError) as bad_timeout:
            await self.session.connect("COM22", 115200, 0)

        self.assertEqual(empty_port.exception.code, "invalid_params")
        self.assertEqual(bad_baudrate.exception.code, "invalid_params")
        self.assertEqual(bad_timeout.exception.code, "invalid_params")

    async def test_helper_load_failure_sets_failed_state(self) -> None:
        def factory(config: ReplConfig) -> HelperErrorTransport:
            self.transport = HelperErrorTransport(config)
            return self.transport

        session = ManagerSession(
            ReplConfig(port="COM21", baudrate=115200),
            emit_event=lambda event, payload: self.events.append((event, payload)),
            transport_factory=factory,
        )
        with self.assertRaisesRegex(Exception, "failed to inject"):
            await session.open()

        self.assertEqual(session.state, "failed")

    async def test_cancel_uses_interrupt(self) -> None:
        await self.session.open()
        self.assertTrue(await self.session.cancel())
        await self.session.close()

    async def test_transport_error_drops_connection_and_next_execute_reopens(self) -> None:
        RecoveringTransport.fail_user_exec_once = True
        transports: list[RecoveringTransport] = []

        def factory(config: ReplConfig) -> RecoveringTransport:
            transport = RecoveringTransport(config)
            transports.append(transport)
            return transport

        session = ManagerSession(
            ReplConfig(port="COM21", baudrate=115200),
            emit_event=lambda event, payload: self.events.append((event, payload)),
            transport_factory=factory,
        )

        with self.assertRaises(RpcMethodError) as raised:
            await session.execute("1")

        self.assertEqual(raised.exception.code, "transport_lost")
        self.assertEqual(session.state, "stopped")
        self.assertTrue(transports[0].closed)

        result = await session.execute("2")

        self.assertEqual(result["stdout"], "ok\r\n")
        self.assertEqual(len(transports), 2)
        await session.close()

    async def test_interrupt_transport_error_marks_connection_lost(self) -> None:
        transport_holder: dict[str, InterruptErrorTransport] = {}

        def factory(config: ReplConfig) -> InterruptErrorTransport:
            transport = InterruptErrorTransport(config)
            transport_holder["transport"] = transport
            return transport

        session = ManagerSession(
            ReplConfig(port="COM21", baudrate=115200),
            emit_event=lambda event, payload: self.events.append((event, payload)),
            transport_factory=factory,
        )

        with self.assertRaises(RpcMethodError) as raised:
            await session.interrupt()

        self.assertEqual(raised.exception.code, "transport_lost")
        self.assertEqual(session.state, "stopped")
        self.assertTrue(transport_holder["transport"].closed)

    async def test_soft_reset_transport_error_flushes_output_and_marks_lost(self) -> None:
        transport_holder: dict[str, SoftResetErrorTransport] = {}

        def factory(config: ReplConfig) -> SoftResetErrorTransport:
            transport = SoftResetErrorTransport(config)
            transport_holder["transport"] = transport
            return transport

        session = ManagerSession(
            ReplConfig(port="COM21", baudrate=115200),
            emit_event=lambda event, payload: self.events.append((event, payload)),
            transport_factory=factory,
        )

        with self.assertRaises(RpcMethodError) as raised:
            await session.soft_reset()

        self.assertEqual(raised.exception.code, "transport_lost")
        self.assertEqual(session.state, "stopped")
        self.assertTrue(transport_holder["transport"].closed)

    async def test_idle_connection_probe_marks_removed_device_lost(self) -> None:
        transport_holder: dict[str, ProbeErrorTransport] = {}

        def factory(config: ReplConfig) -> ProbeErrorTransport:
            transport = ProbeErrorTransport(config)
            transport_holder["transport"] = transport
            return transport

        session = ManagerSession(
            ReplConfig(port="COM21", baudrate=115200),
            emit_event=lambda event, payload: self.events.append((event, payload)),
            transport_factory=factory,
        )

        with mock.patch.object(manager_session_module, "CONNECTION_PROBE_INTERVAL", 0.01):
            await session.open()
            for _ in range(20):
                if session.state == "stopped":
                    break
                await asyncio.sleep(0.01)

        self.assertEqual(session.state, "stopped")
        self.assertTrue(transport_holder["transport"].closed)
        self.assertTrue(
            any(event == "status" and payload.get("state") == "stopped" for event, payload in self.events)
        )

    async def test_idle_monitor_forwards_background_device_output(self) -> None:
        def factory(config: ReplConfig) -> IdleOutputTransport:
            return IdleOutputTransport(config)

        session = ManagerSession(
            ReplConfig(port="COM21", baudrate=115200),
            emit_event=lambda event, payload: self.events.append((event, payload)),
            transport_factory=factory,
        )
        with mock.patch.object(manager_session_module, "CONNECTION_PROBE_INTERVAL", 0.01):
            await session.open()
            for _ in range(20):
                if any(event == "stdout" and payload.get("background") for event, payload in self.events):
                    break
                await asyncio.sleep(0.01)
            await session.close()

        background = "".join(
            payload.get("text", "")
            for event, payload in self.events
            if event == "stdout" and payload.get("background")
        )
        self.assertIn("background", background)


if __name__ == "__main__":
    unittest.main()
