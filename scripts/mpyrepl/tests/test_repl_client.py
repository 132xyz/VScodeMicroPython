from __future__ import annotations

import io
import os
import queue
import sys
import threading
import time
import unittest
from unittest import mock


SCRIPTS_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

from mpyrepl import bootstrap

bootstrap.configure_import_path()

from mpyrepl.clients import repl as repl_client
from mpyrepl.manager.protocol import encode_json_line
from prompt_toolkit.key_binding import KeyPress
from prompt_toolkit.completion import CompleteEvent
from prompt_toolkit.document import Document
from prompt_toolkit.keys import Keys
from mpyrepl.repl.session import PROMPT_SOFT_RESET


class FakeSocket:
    def __init__(self) -> None:
        self.sent: list[bytes] = []
        self.closed = False
        self.timeouts: list[float | None] = []

    def settimeout(self, timeout: float | None) -> None:
        self.timeouts.append(timeout)

    def sendall(self, data: bytes) -> None:
        self.sent.append(data)

    def makefile(self, mode: str):
        return io.BytesIO()

    def close(self) -> None:
        self.closed = True


class BlockingReader:
    def __init__(self) -> None:
        self.lines: queue.Queue[bytes] = queue.Queue()
        self.closed = False

    def feed(self, line: str | bytes) -> None:
        self.lines.put(line.encode("utf-8") if isinstance(line, str) else line)

    def readline(self) -> bytes:
        return self.lines.get(timeout=2)

    def close(self) -> None:
        self.closed = True
        self.lines.put(b"")


class FakePromptSession:
    def __init__(self, values) -> None:
        self.values = list(values)
        self.default_buffer = mock.Mock()
        self.default_buffer.load_history_if_not_yet_loaded = mock.Mock()

    def prompt(self, *args, **kwargs):
        value = self.values.pop(0)
        if isinstance(value, BaseException):
            raise value
        return value


class FakeInput:
    def __init__(self, key_batches=None) -> None:
        self.key_batches = list(key_batches or [])
        self.closed = False
        self.raw_entries = 0

    def raw_mode(self):
        input_obj = self

        class _RawMode:
            def __enter__(self):
                input_obj.raw_entries += 1

            def __exit__(self, exc_type, exc, tb):
                return None

        return _RawMode()

    def read_keys(self):
        if self.key_batches:
            return self.key_batches.pop(0)
        return []

    def close(self) -> None:
        self.closed = True


class FakeManagerClient:
    instances: list["FakeManagerClient"] = []

    def __init__(self, host: str, port: int, token: str) -> None:
        self.host = host
        self.port = port
        self.token = token
        self.calls: list[tuple[str, dict]] = []
        self.closed = False
        FakeManagerClient.instances.append(self)

    def call(self, method: str, params=None):
        self.calls.append((method, params or {}))
        if method == "manager.status":
            return {"state": "ready"}
        if method == "repl.exec":
            return {"stdout": "ok", "stderr": ""}
        if method == "repl.complete":
            return [
                {
                    "text": "textarea",
                    "startPosition": -1,
                    "display": "textarea",
                    "meta": "stub class",
                }
            ]
        return True

    def close(self) -> None:
        self.closed = True


class StderrThenOkManagerClient(FakeManagerClient):
    def call(self, method: str, params=None):
        if method == "repl.exec" and (params or {}).get("source") == "bad()":
            self.calls.append((method, params or {}))
            return {"stdout": "", "stderr": "Traceback\r\n"}
        return super().call(method, params)


class ExecKeyboardInterruptManagerClient(FakeManagerClient):
    def call(self, method: str, params=None):
        self.calls.append((method, params or {}))
        if method == "manager.status":
            return {"state": "ready"}
        if method == "repl.exec":
            raise KeyboardInterrupt()
        return True


class TransportLostManagerClient(FakeManagerClient):
    def call(self, method: str, params=None):
        self.calls.append((method, params or {}))
        if method == "manager.status":
            return {"state": "ready"}
        if method == "repl.exec":
            raise repl_client.ManagerRequestError("transport_lost", "serial connection lost")
        return True


class ControlTransportLostManagerClient(FakeManagerClient):
    fail_method = ""

    def call(self, method: str, params=None):
        self.calls.append((method, params or {}))
        if method == "manager.status":
            return {"state": "ready"}
        if method == self.fail_method:
            raise repl_client.ManagerRequestError("transport_lost", "serial connection lost")
        return True


class ExecWaitsForCtrlCManagerClient(FakeManagerClient):
    interrupt_event = threading.Event()

    def call(self, method: str, params=None):
        self.calls.append((method, params or {}))
        if method == "manager.status":
            return {"state": "ready"}
        if method == "device.interrupt":
            self.interrupt_event.set()
            return True
        if method == "repl.exec":
            if not self.interrupt_event.wait(timeout=2):
                raise RuntimeError("exec was not interrupted")
            return {"stdout": "", "stderr": ""}
        return True


class ReplClientTests(unittest.TestCase):
    def test_parse_endpoint_validates_host_port(self) -> None:
        self.assertEqual(repl_client.parse_endpoint("127.0.0.1:1234"), ("127.0.0.1", 1234))
        with self.assertRaises(ValueError):
            repl_client.parse_endpoint("missing-port")

    def test_parse_run_file_command_accepts_json_paths(self) -> None:
        self.assertEqual(
            repl_client.parse_run_file_command(':mpy-run-file "C:\\\\项目\\\\demo file.py"'),
            "C:\\项目\\demo file.py",
        )
        self.assertIsNone(repl_client.parse_run_file_command("print(1)"))
        with self.assertRaisesRegex(ValueError, "JSON string"):
            repl_client.parse_run_file_command(":mpy-run-file not-json")

    def test_run_file_labels_accept_windows_and_posix_paths(self) -> None:
        self.assertEqual(repl_client._file_label("C:\\project\\demo.py"), "demo.py")
        self.assertEqual(repl_client._file_label("/workspace/project/demo.py"), "demo.py")

    def test_manager_client_call_handles_events_and_response(self) -> None:
        client = repl_client.ManagerClient("127.0.0.1", 1, "tok")
        fake_socket = FakeSocket()
        client._socket = fake_socket
        client._reader = io.BytesIO(
            (
                encode_json_line({"event": "stdout", "payload": {"text": "hello"}})
                + encode_json_line({"event": "stderr", "payload": {"text": "warn"}})
                + encode_json_line({"id": "1", "ok": True, "result": {"done": True}})
            ).encode("utf-8")
        )

        stdout = io.StringIO()
        stderr = io.StringIO()
        with mock.patch.object(sys, "stdout", stdout), mock.patch.object(sys, "stderr", stderr):
            result = client.call("manager.ping")
        client.close()

        self.assertEqual(result, {"done": True})
        self.assertIn("hello", stdout.getvalue())
        self.assertIn("warn", stderr.getvalue())
        self.assertIn(b'"method":"manager.ping"', fake_socket.sent[0])
        self.assertTrue(fake_socket.closed)

    def test_manager_client_forwards_events_while_no_request_is_active(self) -> None:
        client = repl_client.ManagerClient("127.0.0.1", 1, "tok")
        fake_socket = FakeSocket()
        reader = BlockingReader()
        client._socket = fake_socket
        client._reader = reader
        reader.feed(encode_json_line({"id": "1", "ok": True, "result": {"state": "ready"}}))

        stdout = io.StringIO()
        with mock.patch.object(sys, "stdout", stdout):
            self.assertEqual(client.call("manager.status"), {"state": "ready"})
            reader.feed(encode_json_line({"event": "stdout", "payload": {"text": "background now\n"}}))
            deadline = time.monotonic() + 1.0
            while "background now" not in stdout.getvalue() and time.monotonic() < deadline:
                time.sleep(0.01)

        client.close()

        self.assertIn("background now", stdout.getvalue())
        self.assertTrue(reader.closed)

    def test_manager_client_disconnect_wakes_blocked_request(self) -> None:
        client = repl_client.ManagerClient("127.0.0.1", 1, "tok")
        fake_socket = FakeSocket()
        reader = BlockingReader()
        client._socket = fake_socket
        client._reader = reader
        errors: list[Exception] = []

        def call_status() -> None:
            try:
                client.call("manager.status")
            except Exception as exc:
                errors.append(exc)

        caller = threading.Thread(target=call_status)
        caller.start()
        deadline = time.monotonic() + 1.0
        while not fake_socket.sent and time.monotonic() < deadline:
            time.sleep(0.01)
        reader.feed(b"")
        caller.join(timeout=1.0)
        client.close()

        self.assertFalse(caller.is_alive())
        self.assertEqual(len(errors), 1)
        self.assertIn("connection closed", str(errors[0]))

    def test_manager_client_call_raises_rpc_error_and_closed_connection(self) -> None:
        client = repl_client.ManagerClient("127.0.0.1", 1, "tok")
        client._socket = FakeSocket()
        client._reader = io.BytesIO(
            encode_json_line(
                {"id": "1", "ok": False, "error": {"code": "device", "message": "failed"}}
            ).encode("utf-8")
        )
        with self.assertRaisesRegex(repl_client.ManagerRequestError, "failed") as raised:
            client.call("manager.ping")
        self.assertEqual(raised.exception.code, "device")

        client._reader = io.BytesIO(b"")
        with self.assertRaisesRegex(RuntimeError, "connection closed"):
            client.call("manager.ping")

    def test_manager_client_connect_and_status_closing_event(self) -> None:
        fake_socket = FakeSocket()
        fake_socket.makefile = mock.Mock(
            return_value=io.BytesIO(
                (
                    encode_json_line({"event": "status", "payload": {"state": "closing"}})
                    + encode_json_line({"event": "ignored", "payload": {}})
                    + encode_json_line({"id": "1", "ok": True, "result": True})
                ).encode("utf-8")
            )
        )
        with mock.patch("mpyrepl.clients.repl.socket.create_connection", return_value=fake_socket):
            client = repl_client.ManagerClient("127.0.0.1", 1, "tok")
            stderr = io.StringIO()
            with mock.patch.object(sys, "stderr", stderr):
                self.assertTrue(client.call("manager.ping"))
            client.close()

        self.assertIn("manager is closing", stderr.getvalue())
        self.assertEqual(fake_socket.timeouts, [None])

    def test_read_message_without_connection_raises(self) -> None:
        client = repl_client.ManagerClient("127.0.0.1", 1, "tok")
        with self.assertRaisesRegex(RuntimeError, "not connected"):
            client._read_message()

    def test_run_repl_client_executes_soft_reset_interrupt_and_exit(self) -> None:
        FakeManagerClient.instances.clear()
        prompt = FakePromptSession([KeyboardInterrupt(), PROMPT_SOFT_RESET, "print(1)", ":exit"])

        with mock.patch.object(repl_client, "ManagerClient", FakeManagerClient), mock.patch.object(
            repl_client, "build_prompt_session", return_value=prompt
        ) as build_prompt_session:
            code = repl_client.run_repl_client("127.0.0.1:5000", "tok")

        client = FakeManagerClient.instances[0]
        self.assertEqual(code, 0)
        self.assertTrue(client.closed)
        self.assertIn(("device.interrupt", {}), client.calls)
        self.assertIn(("device.softReset", {}), client.calls)
        self.assertIn(("repl.exec", {"source": "print(1)"}), client.calls)
        self.assertTrue(build_prompt_session.call_args.kwargs["complete_while_typing"])
        self.assertIsInstance(build_prompt_session.call_args.kwargs["completer"], repl_client.ManagerCompleter)

    def test_run_repl_client_keeps_prompt_after_device_stderr(self) -> None:
        FakeManagerClient.instances.clear()
        prompt = FakePromptSession(["bad()", "print(2)", ":exit"])

        with mock.patch.object(repl_client, "ManagerClient", StderrThenOkManagerClient), mock.patch.object(
            repl_client, "build_prompt_session", return_value=prompt
        ):
            code = repl_client.run_repl_client("127.0.0.1:5000", "tok")

        client = FakeManagerClient.instances[0]
        self.assertEqual(code, 0)
        self.assertIn(("repl.exec", {"source": "bad()"}), client.calls)
        self.assertIn(("repl.exec", {"source": "print(2)"}), client.calls)
        self.assertTrue(client.closed)

    def test_run_repl_client_exits_after_transport_loss(self) -> None:
        FakeManagerClient.instances.clear()
        prompt = FakePromptSession(["print(1)", "print(2)"])
        stderr = io.StringIO()

        with mock.patch.object(repl_client, "ManagerClient", TransportLostManagerClient), mock.patch.object(
            repl_client, "build_prompt_session", return_value=prompt
        ), mock.patch.object(sys, "stderr", stderr):
            code = repl_client.run_repl_client("127.0.0.1:5000", "tok")

        client = FakeManagerClient.instances[0]
        exec_calls = [call for call in client.calls if call[0] == "repl.exec"]
        self.assertEqual(code, repl_client.EXIT_TRANSPORT_LOST)
        self.assertEqual(exec_calls, [("repl.exec", {"source": "print(1)"})])
        self.assertTrue(client.closed)
        self.assertIn("REPL client is closing", stderr.getvalue())

    def test_control_transport_loss_returns_diagnostic_exit_code(self) -> None:
        cases = (
            ("device.interrupt", [KeyboardInterrupt()]),
            ("device.softReset", [PROMPT_SOFT_RESET]),
        )
        for method, prompt_values in cases:
            with self.subTest(method=method):
                FakeManagerClient.instances.clear()
                ControlTransportLostManagerClient.fail_method = method
                prompt = FakePromptSession(prompt_values)
                stderr = io.StringIO()

                with mock.patch.object(
                    repl_client,
                    "ManagerClient",
                    ControlTransportLostManagerClient,
                ), mock.patch.object(
                    repl_client,
                    "build_prompt_session",
                    return_value=prompt,
                ), mock.patch.object(sys, "stderr", stderr):
                    code = repl_client.run_repl_client("127.0.0.1:5000", "tok")

                self.assertEqual(code, repl_client.EXIT_TRANSPORT_LOST)
                self.assertIn("REPL client is closing", stderr.getvalue())

    def test_run_repl_client_executes_local_file_verbatim(self) -> None:
        FakeManagerClient.instances.clear()
        file_path = "C:\\项目\\demo file.py"
        command = repl_client.RUN_FILE_PREFIX + '"C:\\\\项目\\\\demo file.py"'
        prompt = FakePromptSession([command, ":exit"])
        stderr = io.StringIO()

        with mock.patch.object(repl_client, "ManagerClient", FakeManagerClient), mock.patch.object(
            repl_client, "build_prompt_session", return_value=prompt
        ), mock.patch("builtins.open", mock.mock_open(read_data="1\nvalue = 2\n")) as open_file, mock.patch.object(
            sys, "stderr", stderr
        ):
            code = repl_client.run_repl_client("127.0.0.1:5000", "tok")

        client = FakeManagerClient.instances[0]
        self.assertEqual(code, 0)
        open_file.assert_called_once_with(file_path, "r", encoding="utf-8-sig")
        self.assertIn(
            (
                "repl.exec",
                {"source": "1\nvalue = 2\n", "instrument": False, "label": "demo file.py"},
            ),
            client.calls,
        )
        self.assertIn("running demo file.py", stderr.getvalue())
        self.assertIn("finished demo file.py", stderr.getvalue())

    def test_run_repl_client_reports_local_file_read_errors(self) -> None:
        FakeManagerClient.instances.clear()
        prompt = FakePromptSession([':mpy-run-file "C:/missing.py"', ":exit"])
        stderr = io.StringIO()

        with mock.patch.object(repl_client, "ManagerClient", FakeManagerClient), mock.patch.object(
            repl_client, "build_prompt_session", return_value=prompt
        ), mock.patch("builtins.open", side_effect=OSError("missing")), mock.patch.object(sys, "stderr", stderr):
            code = repl_client.run_repl_client("127.0.0.1:5000", "tok")

        client = FakeManagerClient.instances[0]
        self.assertEqual(code, 0)
        self.assertFalse(any(method == "repl.exec" for method, _ in client.calls))
        self.assertIn("failed to read missing.py", stderr.getvalue())

    def test_run_repl_client_ctrl_c_during_exec_sends_out_of_band_interrupt(self) -> None:
        FakeManagerClient.instances.clear()
        prompt = FakePromptSession(["time.sleep(99)", ":exit"])
        stderr = io.StringIO()

        with mock.patch.object(repl_client, "ManagerClient", ExecKeyboardInterruptManagerClient), mock.patch.object(
            repl_client, "build_prompt_session", return_value=prompt
        ), mock.patch.object(sys, "stderr", stderr):
            code = repl_client.run_repl_client("127.0.0.1:5000", "tok")

        main_client = FakeManagerClient.instances[0]
        interrupt_client = FakeManagerClient.instances[1]
        self.assertEqual(code, 0)
        self.assertIn(("repl.exec", {"source": "time.sleep(99)"}), main_client.calls)
        self.assertIn(("device.interrupt", {}), interrupt_client.calls)
        self.assertTrue(interrupt_client.closed)
        self.assertTrue(main_client.closed)
        self.assertIn("interrupt sent", stderr.getvalue())

    def test_run_repl_client_stdin_ctrl_c_interrupts_blocking_exec_wait(self) -> None:
        FakeManagerClient.instances.clear()
        ExecWaitsForCtrlCManagerClient.interrupt_event = threading.Event()
        prompt = FakePromptSession(["time.sleep(99)", ":exit"])
        input_obj = FakeInput([[KeyPress(Keys.ControlC, repl_client.CTRL_C)]])
        stderr = io.StringIO()

        with mock.patch.object(repl_client, "ManagerClient", ExecWaitsForCtrlCManagerClient), mock.patch.object(
            repl_client, "build_prompt_session", return_value=prompt
        ), mock.patch.object(repl_client, "create_input", return_value=input_obj), mock.patch.object(sys, "stderr", stderr):
            code = repl_client.run_repl_client("127.0.0.1:5000", "tok")

        main_client = FakeManagerClient.instances[0]
        interrupt_client = FakeManagerClient.instances[1]
        self.assertEqual(code, 0)
        self.assertIn(("repl.exec", {"source": "time.sleep(99)"}), main_client.calls)
        self.assertIn(("device.interrupt", {}), interrupt_client.calls)
        self.assertIn("interrupt sent", stderr.getvalue())
        self.assertGreaterEqual(input_obj.raw_entries, 1)
        self.assertTrue(input_obj.closed)

    def test_main_reports_unhandled_client_crashes(self) -> None:
        stderr = io.StringIO()
        with mock.patch.object(
            sys,
            "argv",
            ["repl_client.py", "--endpoint", "127.0.0.1:5000", "--token", "tok"],
        ), mock.patch.object(
            repl_client,
            "run_repl_client",
            side_effect=RuntimeError("boom"),
        ), mock.patch.object(sys, "stderr", stderr):
            self.assertEqual(repl_client.main(), 1)

        self.assertIn("REPL client crashed", stderr.getvalue())
        self.assertIn("RuntimeError: boom", stderr.getvalue())

    def test_manager_completer_calls_repl_complete(self) -> None:
        FakeManagerClient.instances.clear()
        client = FakeManagerClient("127.0.0.1", 5000, "tok")
        completer = repl_client.ManagerCompleter(client)
        document = Document("lv.t", cursor_position=4)

        completions = list(completer.get_completions(document, CompleteEvent(completion_requested=True)))

        self.assertTrue(completer.has_completion_target(document))
        self.assertEqual(completions[0].text, "textarea")
        self.assertEqual(completions[0].start_position, -1)
        self.assertIn(
            (
                "repl.complete",
                {"text": "lv.t", "cursor": 4, "requested": True},
            ),
            client.calls,
        )

    def test_main_uses_parser(self) -> None:
        FakeManagerClient.instances.clear()
        prompt = FakePromptSession([":exit"])
        with mock.patch.object(sys, "argv", ["repl_client.py", "--endpoint", "127.0.0.1:5000", "--token", "tok"]), mock.patch.object(
            repl_client, "ManagerClient", FakeManagerClient
        ), mock.patch.object(repl_client, "build_prompt_session", return_value=prompt):
            self.assertEqual(repl_client.main(), 0)

    def test_build_parser_requires_endpoint_and_token(self) -> None:
        parser = repl_client.build_parser()
        args = parser.parse_args(["--endpoint", "127.0.0.1:1", "--token", "tok"])
        self.assertEqual(args.endpoint, "127.0.0.1:1")
        self.assertEqual(args.token, "tok")

    def test_report_manager_error_distinguishes_transport_loss(self) -> None:
        stderr = io.StringIO()
        with mock.patch.object(sys, "stderr", stderr):
            repl_client._report_manager_error(
                repl_client.ManagerRequestError("transport_lost", "serial connection lost")
            )
            repl_client._report_manager_error(
                repl_client.ManagerRequestError("device", "boom")
            )

        self.assertIn("REPL client is closing", stderr.getvalue())
        self.assertIn("manager request failed: boom", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
