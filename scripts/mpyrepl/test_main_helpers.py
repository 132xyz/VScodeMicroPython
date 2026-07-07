from __future__ import annotations

import importlib.util
import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from models import ExecResult, ReplConfig
from transport import TransportError


def load_main_module():
    module_path = Path(__file__).with_name("__main__.py")
    spec = importlib.util.spec_from_file_location("mpyrepl_entry", module_path)
    module = importlib.util.module_from_spec(spec)
    assert spec is not None
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


mpyrepl_main = load_main_module()


class FakeLoop:
    def __init__(self) -> None:
        self.callbacks = []

    def call_soon_threadsafe(self, callback) -> None:
        self.callbacks.append(callback)


class FakeGate:
    def __init__(self) -> None:
        self.operations = []

    async def run(self, operation, func, *args):
        self.operations.append(operation)
        return func(*args)


class FakeSymbols:
    def __init__(self) -> None:
        self.clear_calls = 0
        self.recorded = []

    def clear(self) -> None:
        self.clear_calls += 1

    def record_successful_source(self, source: str) -> None:
        self.recorded.append(source)
        return SimpleNamespace(
            rebound_roots=set(),
            mutated_roots=set(),
            clear_runtime_cache=False,
        )


class FakeCompleter:
    def __init__(self) -> None:
        self.clear_runtime_cache_calls = 0
        self.invalidate_runtime_cache_calls = []

    def clear_runtime_cache(self) -> None:
        self.clear_runtime_cache_calls += 1

    def invalidate_runtime_cache(self, **kwargs) -> None:
        self.invalidate_runtime_cache_calls.append(kwargs)


class FakePromptSession:
    def __init__(self, responses) -> None:
        self._responses = list(responses)
        self.default_buffer = mock.Mock()
        self.app = SimpleNamespace(is_running=False, loop=None)

    async def prompt_async(self, *args, **kwargs):
        if "pre_run" in kwargs and kwargs["pre_run"] is not None:
            kwargs["pre_run"]()
        value = self._responses.pop(0)
        if isinstance(value, BaseException):
            raise value
        return value


class FakeRuntimeCompleter(FakeCompleter):
    instances = []

    def __init__(
        self,
        session_symbols,
        stub_root: str = "",
        completion_roots=None,
        dotted_provider=None,
    ) -> None:
        super().__init__()
        self.session_symbols = session_symbols
        self.stub_root = stub_root
        self.completion_roots = completion_roots
        self.dotted_provider = dotted_provider
        FakeRuntimeCompleter.instances.append(self)


class FakeContextTransport:
    instances = []

    def __init__(self, config) -> None:
        self.config = config
        self._config = config
        self.open_calls = 0
        self.close_calls = 0
        self.interrupt_calls = 0
        self.enter_raw_repl_calls = []
        self.exit_raw_repl_calls = 0
        self.soft_reset_calls = 0
        FakeContextTransport.instances.append(self)

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback) -> None:
        return None

    def open(self) -> None:
        self.open_calls += 1

    def close(self) -> None:
        self.close_calls += 1

    def enter_raw_repl(self, soft_reset: bool) -> None:
        self.enter_raw_repl_calls.append(soft_reset)

    def exit_raw_repl(self) -> None:
        self.exit_raw_repl_calls += 1

    def soft_reset(self, output_consumer=None) -> None:
        self.soft_reset_calls += 1
        if output_consumer is not None:
            payload = "中OK".encode("utf-8")
            output_consumer(payload[:1])
            output_consumer(payload[1:])

    def interrupt(self) -> None:
        self.interrupt_calls += 1


class FailingEncodingStream:
    def __init__(self) -> None:
        self.buffer = io.BytesIO()
        self.encoding = "cp1252"
        self.flush_calls = 0

    def write(self, text: str) -> int:
        text.encode(self.encoding)
        return len(text)

    def flush(self) -> None:
        self.flush_calls += 1


class NoBufferEncodingStream:
    def __init__(self) -> None:
        self.encoding = "cp1252"
        self.values = []
        self.flush_calls = 0

    def write(self, text: str) -> int:
        text.encode(self.encoding)
        self.values.append(text)
        return len(text)

    def flush(self) -> None:
        self.flush_calls += 1


class MainHelperTests(unittest.TestCase):
    def setUp(self) -> None:
        FakeContextTransport.instances.clear()
        FakeRuntimeCompleter.instances.clear()

    def test_serial_operation_gate_tracks_current_operation(self) -> None:
        gate = mpyrepl_main.SerialOperationGate()

        def work(value):
            self.assertTrue(gate.busy)
            self.assertEqual(gate.current_operation, "demo")
            return value + 1

        self.assertEqual(gate.run_blocking("demo", work, 4), 5)
        self.assertFalse(gate.busy)
        self.assertEqual(gate.current_operation, "")

    def test_try_run_blocking_returns_none_when_busy(self) -> None:
        gate = mpyrepl_main.SerialOperationGate()
        gate._lock.acquire()
        try:
            self.assertIsNone(gate.try_run_blocking("demo", lambda: 1))
        finally:
            gate._lock.release()

        self.assertEqual(gate.try_run_blocking("demo", lambda value: value + 2, 3), 5)
        self.assertEqual(gate.current_operation, "")

    def test_serial_operation_gate_async_run_returns_result(self) -> None:
        async def run_gate() -> int:
            gate = mpyrepl_main.SerialOperationGate()
            return await gate.run("async-demo", lambda value: value + 1, 4)

        self.assertEqual(__import__("asyncio").run(run_gate()), 5)

    def test_repl_input_buffer_remembers_document_and_consumes_trimmed_source(self) -> None:
        input_buffer = mpyrepl_main.ReplInputBuffer()
        self.assertEqual(input_buffer.prompt_text(), ">>> ")
        self.assertFalse(input_buffer.has_pending_input())
        self.assertEqual(input_buffer.prompt_default(), "")

        input_buffer.remember("print(1)\n")
        document = input_buffer.prompt_default()
        self.assertEqual(document.text, "print(1)\n")
        self.assertEqual(document.cursor_position, len("print(1)\n"))
        self.assertTrue(input_buffer.has_pending_input())
        self.assertEqual(input_buffer.consume_source("print(1)\n\n"), "print(1)")
        self.assertFalse(input_buffer.has_pending_input())

    def test_write_stream_chunk_falls_back_when_stream_encoding_cannot_encode_unicode(self) -> None:
        stream = FailingEncodingStream()
        decoder = mpyrepl_main.Utf8StreamDecoder()

        mpyrepl_main.write_stream_chunk(stream, decoder, "中OK".encode("utf-8"))

        self.assertEqual(stream.buffer.getvalue(), "中OK".encode("utf-8"))
        self.assertEqual(stream.flush_calls, 1)

        no_buffer_stream = NoBufferEncodingStream()
        mpyrepl_main.write_text(no_buffer_stream, "中OK")
        self.assertEqual(no_buffer_stream.values, ["?OK"])
        self.assertEqual(no_buffer_stream.flush_calls, 1)

        flush_stream = io.StringIO()
        decoder = mpyrepl_main.Utf8StreamDecoder()
        decoder.feed("中".encode("utf-8")[:1])
        mpyrepl_main.flush_decoder(flush_stream, decoder)
        self.assertEqual(flush_stream.getvalue(), "\ufffd")

    def test_install_sigint_forwarder_forwards_and_restores_handler(self) -> None:
        transport = mock.Mock()
        stderr_stream = io.StringIO()
        handlers = []
        previous_handler = object()

        with mock.patch.object(mpyrepl_main.signal, "getsignal", return_value=previous_handler):
            with mock.patch.object(mpyrepl_main.signal, "signal", side_effect=lambda *_args: handlers.append(_args)):
                with mock.patch.object(mpyrepl_main.sys, "stderr", stderr_stream):
                    restore = mpyrepl_main.install_sigint_forwarder(transport)
                    handler = handlers[-1][1]
                    handler(None, None)
                    restore()

        transport.interrupt.assert_called_once_with()
        self.assertIn("forwarded Ctrl-C", stderr_stream.getvalue())
        self.assertIs(handlers[-1][1], previous_handler)

        failing_transport = mock.Mock()
        failing_transport.interrupt.side_effect = RuntimeError("boom")
        stderr_stream = io.StringIO()
        handlers = []
        with mock.patch.object(mpyrepl_main.signal, "getsignal", return_value=previous_handler):
            with mock.patch.object(mpyrepl_main.signal, "signal", side_effect=lambda *_args: handlers.append(_args)):
                with mock.patch.object(mpyrepl_main.sys, "stderr", stderr_stream):
                    mpyrepl_main.install_sigint_forwarder(failing_transport)
                    handlers[-1][1](None, None)

        self.assertIn("failed to forward Ctrl-C", stderr_stream.getvalue())

    def test_request_prompt_exit_exits_running_prompt(self) -> None:
        loop = FakeLoop()
        app = SimpleNamespace(is_running=True, loop=loop)
        session = SimpleNamespace(app=app)
        app.exit = mock.Mock()

        mpyrepl_main.request_prompt_exit(session)
        self.assertEqual(len(loop.callbacks), 1)
        loop.callbacks[0]()
        app.exit.assert_called_once_with(result=mpyrepl_main.PROMPT_CONTROL_EXIT)

        idle_session = SimpleNamespace(app=SimpleNamespace(is_running=False, loop=None))
        mpyrepl_main.request_prompt_exit(idle_session)

    def test_ensure_python_version_rejects_older_runtime(self) -> None:
        with mock.patch.object(mpyrepl_main.sys, "version_info", (3, 8, 0)):
            with self.assertRaises(RuntimeError):
                mpyrepl_main.ensure_python_version()

    def test_ensure_helper_loaded_validates_stderr(self) -> None:
        transport = mock.Mock()
        transport.exec_raw.return_value = ExecResult(stdout=b"", stderr=b"")

        with mock.patch.object(mpyrepl_main, "build_helper_source", return_value="helper") as build_helper:
            mpyrepl_main.ensure_helper_loaded(transport, 1.5, "0.4.22")
        build_helper.assert_called_once_with("0.4.22")
        transport.exec_raw.assert_called_once_with("helper", timeout=1.5)

        broken_transport = mock.Mock()
        broken_transport.exec_raw.return_value = ExecResult(stdout=b"", stderr=b"boom")
        with self.assertRaises(TransportError):
            mpyrepl_main.ensure_helper_loaded(broken_transport, 1.5)

    def test_execute_once_instruments_source_and_streams_output(self) -> None:
        transport = mock.Mock()
        transport.exec_raw.side_effect = lambda command, timeout, stdout_consumer, stderr_consumer: (
            stdout_consumer("ok".encode("utf-8")),
            stderr_consumer("!".encode("utf-8")),
            ExecResult(stdout=b"ok", stderr=b"!"),
        )[-1]

        stdout_stream = io.StringIO()
        stderr_stream = io.StringIO()
        with mock.patch.object(mpyrepl_main, "instrument_source", return_value="wrapped"):
            with mock.patch.object(mpyrepl_main.sys, "stdout", stdout_stream):
                with mock.patch.object(mpyrepl_main.sys, "stderr", stderr_stream):
                    result = mpyrepl_main.execute_once(
                        transport,
                        "print(1)",
                        2.0,
                        mpyrepl_main.Utf8StreamDecoder(),
                        mpyrepl_main.Utf8StreamDecoder(),
                    )

        self.assertEqual(result, ExecResult(stdout=b"ok", stderr=b"!"))
        self.assertEqual(stdout_stream.getvalue(), "ok")
        self.assertEqual(stderr_stream.getvalue(), "!")

    def test_run_prompt_once_handles_exit_soft_reset_and_exec(self) -> None:
        config = ReplConfig(port="COM4")
        session = mock.Mock()
        session.default_buffer = mock.Mock()

        with mock.patch.object(mpyrepl_main, "build_prompt_session", return_value=session):
            session.prompt.return_value = mpyrepl_main.PROMPT_EXIT
            self.assertEqual(mpyrepl_main.run_prompt_once(config, 1.0), 0)

            session.prompt.return_value = mpyrepl_main.PROMPT_SOFT_RESET
            with mock.patch.object(mpyrepl_main, "run_soft_reset", return_value=11) as run_soft_reset:
                self.assertEqual(mpyrepl_main.run_prompt_once(config, 1.0), 11)
                run_soft_reset.assert_called_once_with(config)

            session.prompt.return_value = "print(1)"
            with mock.patch.object(mpyrepl_main, "run_exec", return_value=12) as run_exec:
                self.assertEqual(mpyrepl_main.run_prompt_once(config, 1.0), 12)
                run_exec.assert_called_once_with(config, "print(1)", 1.0)

    def test_run_exec_uses_transport_context_and_returns_status(self) -> None:
        config = ReplConfig(port="COM4", soft_reset_on_connect=True)
        restore_sigint = mock.Mock()

        with mock.patch.object(mpyrepl_main, "SerialReplTransport", FakeContextTransport):
            with mock.patch.object(mpyrepl_main, "ensure_helper_loaded") as ensure_helper_loaded:
                with mock.patch.object(
                    mpyrepl_main,
                    "install_sigint_forwarder",
                    return_value=restore_sigint,
                ):
                    with mock.patch.object(
                        mpyrepl_main,
                        "execute_once",
                        return_value=ExecResult(stdout=b"", stderr=b""),
                    ):
                        self.assertEqual(mpyrepl_main.run_exec(config, "print(1)", 1.5), 0)

        transport = FakeContextTransport.instances[-1]
        self.assertEqual(transport.enter_raw_repl_calls, [True])
        self.assertEqual(transport.exit_raw_repl_calls, 1)
        ensure_helper_loaded.assert_called_once_with(transport, 1.5)
        restore_sigint.assert_called_once_with()

    def test_run_soft_reset_streams_boot_output(self) -> None:
        config = ReplConfig(port="COM4")
        stdout_stream = io.StringIO()

        with mock.patch.object(mpyrepl_main, "SerialReplTransport", FakeContextTransport):
            with mock.patch.object(mpyrepl_main.sys, "stdout", stdout_stream):
                self.assertEqual(mpyrepl_main.run_soft_reset(config), 0)

        transport = FakeContextTransport.instances[-1]
        self.assertEqual(transport.enter_raw_repl_calls, [False])
        self.assertEqual(transport.soft_reset_calls, 1)
        self.assertEqual(transport.exit_raw_repl_calls, 1)
        self.assertEqual(
            stdout_stream.getvalue(),
            '中OK{"request_id": "", "ok": true, "data": true}\n',
        )

    def test_run_interrupt_uses_transport_context_and_emits_json(self) -> None:
        config = ReplConfig(port="COM4")
        stdout_stream = io.StringIO()

        with mock.patch.object(mpyrepl_main, "SerialReplTransport", FakeContextTransport):
            with mock.patch.object(mpyrepl_main.sys, "stdout", stdout_stream):
                self.assertEqual(mpyrepl_main.run_interrupt(config), 0)

        transport = FakeContextTransport.instances[-1]
        self.assertEqual(transport.interrupt_calls, 1)
        self.assertEqual(json.loads(stdout_stream.getvalue()), {"request_id": "", "ok": True, "data": True})

    def test_recover_after_interrupted_execution_realigns_or_reports_failure(self) -> None:
        transport = mock.Mock()

        mpyrepl_main.recover_after_interrupted_execution(transport, 1.0)

        transport.clear_interrupt_request.assert_called_once_with()
        transport.drain_input.assert_called_once_with(max_duration=0.2)
        transport.enter_raw_repl.assert_called_once_with(soft_reset=False, operation_timeout=1.0)

        broken_transport = mock.Mock()
        broken_transport.enter_raw_repl.side_effect = RuntimeError("still lost")
        stderr_stream = io.StringIO()

        with mock.patch.object(mpyrepl_main.sys, "stderr", stderr_stream):
            mpyrepl_main.recover_after_interrupted_execution(broken_transport, 1.0)

        broken_transport.clear_interrupt_request.assert_called_once_with()
        broken_transport.drain_input.assert_called_once_with(max_duration=0.2)
        broken_transport.enter_raw_repl.assert_called_once_with(soft_reset=False, operation_timeout=1.0)
        self.assertIn("interrupt recovery failed: still lost", stderr_stream.getvalue())

    def test_run_ports_emits_success_and_error_payloads(self) -> None:
        stdout_stream = io.StringIO()

        with mock.patch.object(mpyrepl_main, "list_serial_ports", return_value=[{"port": "COM7"}]):
            with mock.patch.object(mpyrepl_main.sys, "stdout", stdout_stream):
                self.assertEqual(mpyrepl_main.run_ports(), 0)

        self.assertEqual(
            json.loads(stdout_stream.getvalue()),
            {"request_id": "", "ok": True, "data": [{"port": "COM7"}]},
        )

        stdout_stream = io.StringIO()
        with mock.patch.object(mpyrepl_main, "list_serial_ports", side_effect=RuntimeError("scan failed")):
            with mock.patch.object(mpyrepl_main.sys, "stdout", stdout_stream):
                self.assertEqual(mpyrepl_main.run_ports(), 1)

        payload = json.loads(stdout_stream.getvalue())
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["code"], "error")
        self.assertIn("scan failed", payload["error"])

    def test_run_fs_cli_uses_custom_transport_and_maps_errors(self) -> None:
        config = ReplConfig(port="COM4", soft_reset_on_connect=True)
        args = SimpleNamespace(
            op="stat",
            path="/main.py",
            src="",
            dst="",
            local_path="",
            source="",
            no_recursive=False,
        )
        stdout_stream = io.StringIO()

        with mock.patch.object(mpyrepl_main, "SerialReplTransport", FakeContextTransport):
            with mock.patch.object(mpyrepl_main, "DeviceFsClient") as device_fs_client:
                with mock.patch.object(mpyrepl_main, "run_fs_operation", return_value={"exists": True}):
                    with mock.patch.object(mpyrepl_main.sys, "stdout", stdout_stream):
                        self.assertEqual(mpyrepl_main.run_fs_cli(config, args), 0)

        transport = FakeContextTransport.instances[-1]
        self.assertEqual(transport.open_calls, 1)
        self.assertEqual(transport.enter_raw_repl_calls, [True])
        self.assertEqual(transport.exit_raw_repl_calls, 1)
        self.assertEqual(transport.close_calls, 1)
        device_fs_client.assert_called_once_with(transport, timeout=config.operation_timeout)
        self.assertEqual(json.loads(stdout_stream.getvalue())["data"], {"exists": True})

        for error, expected_code in (
            (mpyrepl_main.FsOperationError("missing", "missing"), "missing"),
            (RuntimeError("boom"), "error"),
        ):
            stdout_stream = io.StringIO()
            with mock.patch.object(mpyrepl_main, "SerialReplTransport", FakeContextTransport):
                with mock.patch.object(mpyrepl_main, "DeviceFsClient"):
                    with mock.patch.object(mpyrepl_main, "run_fs_operation", side_effect=error):
                        with mock.patch.object(mpyrepl_main.sys, "stdout", stdout_stream):
                            self.assertEqual(mpyrepl_main.run_fs_cli(config, args), 1)
            payload = json.loads(stdout_stream.getvalue())
            self.assertFalse(payload["ok"])
            self.assertEqual(payload["code"], expected_code)

    def test_run_fs_cli_write_file_progress_adds_callback(self) -> None:
        config = ReplConfig(port="COM4")
        args = SimpleNamespace(
            op="write_file",
            path="/main.py",
            src="",
            dst="",
            local_path="main.py",
            source="",
            no_recursive=False,
            progress=True,
        )
        captured_payload = {}

        def fake_run_fs_operation(_client, _op, payload):
            captured_payload.update(payload)
            payload["progress_callback"]({"bytes": 1, "total": 2})
            return True

        stdout_stream = io.StringIO()
        with mock.patch.object(mpyrepl_main, "SerialReplTransport", FakeContextTransport):
            with mock.patch.object(mpyrepl_main, "DeviceFsClient"):
                with mock.patch.object(mpyrepl_main, "run_fs_operation", side_effect=fake_run_fs_operation):
                    with mock.patch.object(mpyrepl_main.sys, "stdout", stdout_stream):
                        self.assertEqual(mpyrepl_main.run_fs_cli(config, args), 0)

        self.assertTrue(callable(captured_payload["progress_callback"]))
        stdout_lines = [line for line in stdout_stream.getvalue().splitlines() if line]
        self.assertTrue(stdout_lines[0].startswith(mpyrepl_main.PROGRESS_MARKER))
        self.assertTrue(stdout_lines[-1].startswith("{"))

    def test_run_session_probe_returns_error_when_any_block_fails(self) -> None:
        config = ReplConfig(port="COM4")

        with mock.patch.object(mpyrepl_main, "SerialReplTransport", FakeContextTransport):
            with mock.patch.object(mpyrepl_main, "ensure_helper_loaded"):
                with mock.patch.object(
                    mpyrepl_main,
                    "execute_once",
                    side_effect=[
                        ExecResult(stdout=b"", stderr=b""),
                        ExecResult(stdout=b"", stderr=b"boom"),
                    ],
                ):
                    self.assertEqual(
                        mpyrepl_main.run_session_probe(config, "a = 1", "a", 1.0),
                        1,
                    )

        transport = FakeContextTransport.instances[-1]
        self.assertEqual(transport.enter_raw_repl_calls, [False])
        self.assertEqual(transport.exit_raw_repl_calls, 1)

        with mock.patch.object(mpyrepl_main, "SerialReplTransport", FakeContextTransport):
            with mock.patch.object(mpyrepl_main, "ensure_helper_loaded"):
                with mock.patch.object(
                    mpyrepl_main,
                    "execute_once",
                    return_value=ExecResult(stdout=b"", stderr=b""),
                ):
                    self.assertEqual(
                        mpyrepl_main.run_session_probe(config, "a = 1", "a", 1.0),
                        0,
                    )

    def test_main_dispatches_exec_and_maps_errors_to_exit_codes(self) -> None:
        args = SimpleNamespace(
            command="exec",
            port="COM4",
            baudrate=115200,
            read_timeout=0.1,
            operation_timeout=10.0,
            soft_reset_on_connect=False,
            code="print(1)",
            follow_timeout=1.5,
        )

        with mock.patch.object(mpyrepl_main, "ensure_python_version"):
            with mock.patch.object(mpyrepl_main, "parse_args", return_value=args):
                with mock.patch.object(mpyrepl_main, "run_exec", return_value=7) as run_exec:
                    self.assertEqual(mpyrepl_main.main(), 7)

        self.assertTrue(hasattr(load_main_module(), "run_async_repl"))

        config = run_exec.call_args.args[0]
        self.assertEqual(config.port, "COM4")
        self.assertEqual(config.baudrate, 115200)
        self.assertFalse(config.soft_reset_on_connect)
        self.assertEqual(run_exec.call_args.args[1:], ("print(1)", 1.5))

        stderr_stream = io.StringIO()
        with mock.patch.object(mpyrepl_main, "ensure_python_version"):
            with mock.patch.object(mpyrepl_main, "parse_args", return_value=args):
                with mock.patch.object(
                    mpyrepl_main,
                    "run_exec",
                    side_effect=TransportError("transport boom"),
                ):
                    with mock.patch.object(mpyrepl_main.sys, "stderr", stderr_stream):
                        self.assertEqual(mpyrepl_main.main(), 2)
        self.assertIn("transport boom", stderr_stream.getvalue())

        stderr_stream = io.StringIO()
        with mock.patch.object(mpyrepl_main, "ensure_python_version"):
            with mock.patch.object(mpyrepl_main, "parse_args", return_value=args):
                with mock.patch.object(
                    mpyrepl_main,
                    "run_exec",
                    side_effect=RuntimeError("runtime boom"),
                ):
                    with mock.patch.object(mpyrepl_main.sys, "stderr", stderr_stream):
                        self.assertEqual(mpyrepl_main.main(), 3)
        self.assertIn("runtime boom", stderr_stream.getvalue())

    def test_main_dispatches_other_commands(self) -> None:
        base_args = dict(
            port="COM4",
            baudrate=115200,
            read_timeout=0.1,
            operation_timeout=10.0,
            soft_reset_on_connect=False,
            follow_timeout=1.5,
            code="print(1)",
            first="a = 1",
            second="a",
            control_file="control.json",
            stub_root="stubs",
            completion_roots=["mpy", "mpy/lib"],
            dir_query_timeout=2.0,
            helper_version="0.4.22",
        )

        dispatch_cases = [
            ("session-probe", "run_session_probe", 21),
            ("prompt-once", "run_prompt_once", 22),
            ("soft-reset", "run_soft_reset", 23),
        ]
        for command, function_name, status in dispatch_cases:
            args = SimpleNamespace(command=command, **base_args)
            with mock.patch.object(mpyrepl_main, "ensure_python_version"):
                with mock.patch.object(mpyrepl_main, "parse_args", return_value=args):
                    with mock.patch.object(mpyrepl_main, function_name, return_value=status):
                        self.assertEqual(mpyrepl_main.main(), status)

        args = SimpleNamespace(command="async-repl", **base_args)
        with mock.patch.object(mpyrepl_main, "ensure_python_version"):
            with mock.patch.object(mpyrepl_main, "parse_args", return_value=args):
                with mock.patch.object(
                    mpyrepl_main,
                    "run_async_repl",
                    new=mock.Mock(return_value=mock.sentinel.repl_coro),
                ) as run_async_repl:
                    with mock.patch.object(mpyrepl_main.asyncio, "run", return_value=24) as asyncio_run:
                        self.assertEqual(mpyrepl_main.main(), 24)
        run_async_repl.assert_called_once()
        asyncio_run.assert_called_once_with(mock.sentinel.repl_coro)

        args = SimpleNamespace(command="unknown", **base_args)
        with mock.patch.object(mpyrepl_main, "ensure_python_version"):
            with mock.patch.object(mpyrepl_main, "parse_args", return_value=args):
                with self.assertRaisesRegex(ValueError, "unsupported command"):
                    mpyrepl_main.main()

        for command, function_name, status in (
            ("interrupt", "run_interrupt", 25),
            ("fs", "run_fs_cli", 26),
        ):
            args = SimpleNamespace(command=command, **base_args)
            with mock.patch.object(mpyrepl_main, "ensure_python_version"):
                with mock.patch.object(mpyrepl_main, "parse_args", return_value=args):
                    with mock.patch.object(mpyrepl_main, function_name, return_value=status):
                        self.assertEqual(mpyrepl_main.main(), status)

        args = SimpleNamespace(command="ports", port="", baudrate=115200)
        with mock.patch.object(mpyrepl_main, "ensure_python_version"):
            with mock.patch.object(mpyrepl_main, "parse_args", return_value=args):
                with mock.patch.object(mpyrepl_main, "run_ports", return_value=27):
                    self.assertEqual(mpyrepl_main.main(), 27)


class MainAsyncHelperTests(unittest.IsolatedAsyncioTestCase):
    async def test_apply_pending_action_handles_exit_and_soft_reset(self) -> None:
        gate = FakeGate()
        state = mpyrepl_main.AsyncReplState()
        state.pending_action = "exit"
        self.assertTrue(
            await mpyrepl_main.apply_pending_action(
                transport=mock.Mock(),
                gate=gate,
                state=state,
                session_symbols=FakeSymbols(),
                completer=FakeCompleter(),
                follow_timeout=1.0,
            )
        )
        self.assertEqual(state.pending_action, "")

        gate = FakeGate()
        state = mpyrepl_main.AsyncReplState()
        state.pending_action = "soft-reset"
        session_symbols = FakeSymbols()
        completer = FakeCompleter()
        transport = mock.Mock()

        with mock.patch.object(mpyrepl_main, "ensure_helper_loaded"):
            self.assertFalse(
                await mpyrepl_main.apply_pending_action(
                    transport=transport,
                    gate=gate,
                    state=state,
                    session_symbols=session_symbols,
                    completer=completer,
                    follow_timeout=1.0,
                )
            )

        self.assertEqual(gate.operations, ["soft-reset", "helper-load"])
        self.assertEqual(session_symbols.clear_calls, 1)
        self.assertEqual(completer.clear_runtime_cache_calls, 1)
        self.assertEqual(state.pending_action, "")

    async def test_apply_pending_action_rejects_unknown_command(self) -> None:
        state = mpyrepl_main.AsyncReplState()
        state.pending_action = "bad-command"

        with self.assertRaises(RuntimeError):
            await mpyrepl_main.apply_pending_action(
                transport=mock.Mock(),
                gate=FakeGate(),
                state=state,
                session_symbols=FakeSymbols(),
                completer=FakeCompleter(),
                follow_timeout=1.0,
            )

    async def test_execute_source_block_updates_symbols_after_success(self) -> None:
        gate = FakeGate()
        state = mpyrepl_main.AsyncReplState()
        session_symbols = FakeSymbols()
        completer = FakeCompleter()

        with mock.patch.object(
            mpyrepl_main,
            "execute_once",
            return_value=ExecResult(stdout=b"", stderr=b""),
        ) as execute_once:
            await mpyrepl_main.execute_source_block(
                transport=mock.Mock(),
                gate=gate,
                state=state,
                session_symbols=session_symbols,
                completer=completer,
                source="print('中')\n",
                follow_timeout=1.0,
            )

        self.assertFalse(state.executing)
        self.assertEqual(gate.operations, ["execute"])
        self.assertEqual(session_symbols.recorded, ["print('中')"])
        self.assertEqual(completer.clear_runtime_cache_calls, 0)
        self.assertEqual(
            completer.invalidate_runtime_cache_calls,
            [
                {
                    "rebound_roots": set(),
                    "mutated_roots": set(),
                    "clear_all": False,
                }
            ],
        )
        execute_once.assert_called_once()

    async def test_execute_source_block_recovers_after_user_interrupt_timeout(self) -> None:
        gate = FakeGate()
        state = mpyrepl_main.AsyncReplState()
        session_symbols = FakeSymbols()
        completer = FakeCompleter()
        stderr_stream = io.StringIO()

        with mock.patch.object(
            mpyrepl_main,
            "execute_once",
            side_effect=mpyrepl_main.TransportInterrupted("interrupted"),
        ):
            with mock.patch.object(mpyrepl_main, "recover_after_interrupted_execution") as recover:
                with mock.patch.object(mpyrepl_main.sys, "stderr", stderr_stream):
                    await mpyrepl_main.execute_source_block(
                        transport=mock.Mock(),
                        gate=gate,
                        state=state,
                        session_symbols=session_symbols,
                        completer=completer,
                        source="while True:\n    pass",
                        follow_timeout=None,
                    )

        self.assertFalse(state.executing)
        self.assertEqual(gate.operations, ["execute", "interrupt-recover"])
        self.assertEqual(session_symbols.recorded, [])
        self.assertEqual(completer.clear_runtime_cache_calls, 0)
        recover.assert_called_once()
        self.assertIn("interrupted; recovering raw REPL", stderr_stream.getvalue())

    async def test_watch_control_channel_handles_all_supported_commands(self) -> None:
        requests = iter(
            [
                SimpleNamespace(command="interrupt"),
                SimpleNamespace(command="exec", source="print(2)", label="main.py"),
                SimpleNamespace(command="soft-reset"),
                SimpleNamespace(command="interrupt-reset"),
                SimpleNamespace(command="exit"),
            ]
        )

        class FakeChannel:
            def read_next(self):
                try:
                    return next(requests)
                except StopIteration as exc:
                    raise RuntimeError("stop") from exc

        async def fake_to_thread(func, *args):
            return func(*args)

        async def fake_sleep(_delay):
            return None

        state = mpyrepl_main.AsyncReplState()
        state.executing = True
        state.prompt_active = True
        transport = mock.Mock()

        with mock.patch.object(mpyrepl_main.asyncio, "to_thread", side_effect=fake_to_thread):
            with mock.patch.object(mpyrepl_main.asyncio, "sleep", side_effect=fake_sleep):
                with mock.patch.object(mpyrepl_main, "request_prompt_exit") as request_prompt_exit:
                    with self.assertRaisesRegex(RuntimeError, "stop"):
                        await mpyrepl_main.watch_control_channel(
                            FakeChannel(),
                            state,
                            session=mock.Mock(),
                            transport=transport,
                            gate=mpyrepl_main.SerialOperationGate(),
                            fs_client=mock.Mock(),
                        )

        self.assertEqual(transport.interrupt.call_count, 5)
        self.assertEqual(request_prompt_exit.call_count, 5)
        self.assertEqual(state.pending_exec_source, "print(2)")
        self.assertEqual(state.pending_exec_label, "main.py")
        self.assertEqual(state.pending_action, "exit")

    async def test_handle_fs_control_request_writes_success_busy_and_error_payloads(self) -> None:
        gate = FakeGate()
        state = mpyrepl_main.AsyncReplState()
        fs_client = mock.Mock()
        fs_client.stat.return_value = {"exists": True}

        with tempfile.TemporaryDirectory() as tmp_dir:
            response_file = str(Path(tmp_dir) / "nested" / "response.json")
            request = SimpleNamespace(
                sequence=3,
                request_id="req-3",
                response_file=response_file,
                payload={"op": "stat", "path": "/main.py"},
            )

            await mpyrepl_main.handle_fs_control_request(request, gate, state, fs_client)
            payload = json.loads(Path(response_file).read_text(encoding="utf-8"))

            self.assertEqual(payload["request_id"], "req-3")
            self.assertTrue(payload["ok"])
            self.assertEqual(payload["data"], {"exists": True})
            self.assertEqual(gate.operations, ["fs-stat"])

            state.executing = True
            await mpyrepl_main.handle_fs_control_request(request, gate, state, fs_client)
            busy_payload = json.loads(Path(response_file).read_text(encoding="utf-8"))
            self.assertFalse(busy_payload["ok"])
            self.assertEqual(busy_payload["code"], "busy")
            state.executing = False

            with mock.patch.object(
                mpyrepl_main,
                "run_fs_operation",
                side_effect=mpyrepl_main.FsOperationError("no file", "missing"),
            ):
                await mpyrepl_main.handle_fs_control_request(request, FakeGate(), state, fs_client)
            fs_error_payload = json.loads(Path(response_file).read_text(encoding="utf-8"))
            self.assertFalse(fs_error_payload["ok"])
            self.assertEqual(fs_error_payload["code"], "missing")

            with mock.patch.object(
                mpyrepl_main,
                "run_fs_operation",
                side_effect=RuntimeError("broken"),
            ):
                await mpyrepl_main.handle_fs_control_request(request, FakeGate(), state, fs_client)
            error_payload = json.loads(Path(response_file).read_text(encoding="utf-8"))
            self.assertFalse(error_payload["ok"])
            self.assertEqual(error_payload["code"], "error")

    async def test_handle_fs_control_request_writes_progress_file(self) -> None:
        state = mpyrepl_main.AsyncReplState()

        with tempfile.TemporaryDirectory() as tmp_dir:
            response_file = str(Path(tmp_dir) / "response.json")
            progress_file = str(Path(tmp_dir) / "progress.json")
            request = SimpleNamespace(
                sequence=4,
                request_id="req-4",
                response_file=response_file,
                progress_file=progress_file,
                payload={"op": "write_file", "path": "/main.py", "local_path": "main.py"},
            )

            def fake_run_fs_operation(_client, _op, payload):
                payload["progress_callback"]({"bytes": 4, "total": 8})
                return True

            with mock.patch.object(mpyrepl_main, "run_fs_operation", side_effect=fake_run_fs_operation):
                await mpyrepl_main.handle_fs_control_request(request, FakeGate(), state, mock.Mock())

            progress_payload = json.loads(Path(progress_file).read_text(encoding="utf-8"))
            response_payload = json.loads(Path(response_file).read_text(encoding="utf-8"))

            self.assertEqual(progress_payload, {"bytes": 4, "total": 8})
            self.assertTrue(response_payload["ok"])

    async def test_watch_control_channel_handles_fs_command(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            response_file = str(Path(tmp_dir) / "fs-response.json")
            requests = iter(
                [
                    SimpleNamespace(
                        command="fs",
                        sequence=7,
                        request_id="req-7",
                        response_file=response_file,
                        payload={"op": "stat", "path": "/boot.py"},
                    ),
                ]
            )

            class FakeChannel:
                def read_next(self):
                    try:
                        return next(requests)
                    except StopIteration as exc:
                        raise RuntimeError("stop") from exc

            fs_client = mock.Mock()
            fs_client.stat.return_value = {"exists": False}

            with self.assertRaisesRegex(RuntimeError, "stop"):
                await mpyrepl_main.watch_control_channel(
                    FakeChannel(),
                    mpyrepl_main.AsyncReplState(),
                    session=mock.Mock(),
                    transport=mock.Mock(),
                    gate=FakeGate(),
                    fs_client=fs_client,
                )

            payload = json.loads(Path(response_file).read_text(encoding="utf-8"))
            self.assertTrue(payload["ok"])
            self.assertEqual(payload["request_id"], "req-7")
            self.assertEqual(payload["data"], {"exists": False})

    async def test_run_async_repl_executes_code_and_records_symbols(self) -> None:
        config = ReplConfig(port="COM4")
        prompt_session = FakePromptSession(["print(1)", mpyrepl_main.PROMPT_EXIT])
        symbols = FakeSymbols()
        restore_sigint = mock.Mock()

        async def fake_to_thread(func, *args):
            return func(*args)

        with mock.patch.object(mpyrepl_main, "SerialReplTransport", FakeContextTransport):
            with mock.patch.object(mpyrepl_main, "ReplSessionSymbols", return_value=symbols):
                with mock.patch.object(mpyrepl_main, "ReplCompleter", FakeRuntimeCompleter):
                    with mock.patch.object(mpyrepl_main, "build_prompt_session", return_value=prompt_session):
                        with mock.patch.object(mpyrepl_main, "ensure_helper_loaded") as ensure_helper_loaded:
                            with mock.patch.object(
                                mpyrepl_main,
                                "execute_once",
                                return_value=ExecResult(stdout=b"", stderr=b""),
                            ) as execute_once:
                                with mock.patch.object(
                                    mpyrepl_main,
                                    "install_sigint_forwarder",
                                    return_value=restore_sigint,
                                ):
                                    with mock.patch.object(
                                        mpyrepl_main,
                                        "patch_stdout",
                                        return_value=contextlib.nullcontext(),
                                    ):
                                        with mock.patch.object(
                                            mpyrepl_main.asyncio,
                                            "to_thread",
                                            side_effect=fake_to_thread,
                                        ):
                                            result = await mpyrepl_main.run_async_repl(
                                                config,
                                                1.0,
                                                "",
                                                "stubs",
                                                ["mpy", "mpy/lib"],
                                                2.0,
                                                "0.4.22",
                                            )

        self.assertEqual(result, 0)
        self.assertEqual(FakeRuntimeCompleter.instances[-1].completion_roots, ["mpy", "mpy/lib"])
        self.assertEqual(symbols.recorded, ["print(1)"])
        self.assertEqual(FakeRuntimeCompleter.instances[-1].clear_runtime_cache_calls, 0)
        self.assertEqual(
            FakeRuntimeCompleter.instances[-1].invalidate_runtime_cache_calls,
            [
                {
                    "rebound_roots": set(),
                    "mutated_roots": set(),
                    "clear_all": False,
                }
            ],
        )
        execute_once.assert_called_once()
        self.assertIsNone(execute_once.call_args.args[2])
        transport = FakeContextTransport.instances[-1]
        self.assertEqual(transport.enter_raw_repl_calls, [False])
        self.assertEqual(transport.exit_raw_repl_calls, 1)
        ensure_helper_loaded.assert_called_once_with(transport, 1.0, "0.4.22")
        prompt_session.default_buffer.load_history_if_not_yet_loaded.assert_called()
        restore_sigint.assert_called_once_with()

    async def test_run_async_repl_handles_interrupt_control_exit_and_soft_reset(self) -> None:
        config = ReplConfig(port="COM4")
        prompt_session = FakePromptSession(
            [KeyboardInterrupt(), mpyrepl_main.PROMPT_CONTROL_EXIT, mpyrepl_main.PROMPT_SOFT_RESET, ":q"]
        )
        symbols = FakeSymbols()

        async def fake_to_thread(func, *args):
            return func(*args)

        with mock.patch.object(mpyrepl_main, "SerialReplTransport", FakeContextTransport):
            with mock.patch.object(mpyrepl_main, "ReplSessionSymbols", return_value=symbols):
                with mock.patch.object(mpyrepl_main, "ReplCompleter", FakeRuntimeCompleter):
                    with mock.patch.object(mpyrepl_main, "build_prompt_session", return_value=prompt_session):
                        with mock.patch.object(mpyrepl_main, "ensure_helper_loaded"):
                            with mock.patch.object(mpyrepl_main, "execute_once") as execute_once:
                                with mock.patch.object(
                                    mpyrepl_main,
                                    "install_sigint_forwarder",
                                    return_value=mock.Mock(),
                                ):
                                    with mock.patch.object(
                                        mpyrepl_main,
                                        "patch_stdout",
                                        return_value=contextlib.nullcontext(),
                                    ):
                                        with mock.patch.object(mpyrepl_main.sys, "stdout", io.StringIO()):
                                            with mock.patch.object(
                                                mpyrepl_main.asyncio,
                                                "to_thread",
                                                side_effect=fake_to_thread,
                                            ):
                                                result = await mpyrepl_main.run_async_repl(
                                                    config,
                                                    1.0,
                                                    "",
                                                    "",
                                                    [],
                                                    2.0,
                                                )

        self.assertEqual(result, 0)
        self.assertEqual(symbols.clear_calls, 1)
        self.assertEqual(FakeRuntimeCompleter.instances[-1].clear_runtime_cache_calls, 1)
        execute_once.assert_not_called()
        transport = FakeContextTransport.instances[-1]
        self.assertEqual(transport.soft_reset_calls, 1)


if __name__ == "__main__":
    unittest.main()
