from __future__ import annotations

import io
import os
import sys
import unittest
from unittest import mock


CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
if CURRENT_DIR not in sys.path:
    sys.path.insert(0, CURRENT_DIR)

import bootstrap

bootstrap.configure_import_path()

import repl_client
from manager_protocol import encode_json_line
from prompt_toolkit.completion import CompleteEvent
from prompt_toolkit.document import Document
from session import PROMPT_SOFT_RESET


class FakeSocket:
    def __init__(self) -> None:
        self.sent: list[bytes] = []
        self.closed = False

    def sendall(self, data: bytes) -> None:
        self.sent.append(data)

    def makefile(self, mode: str):
        return io.BytesIO()

    def close(self) -> None:
        self.closed = True


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


class ReplClientTests(unittest.TestCase):
    def test_parse_endpoint_validates_host_port(self) -> None:
        self.assertEqual(repl_client.parse_endpoint("127.0.0.1:1234"), ("127.0.0.1", 1234))
        with self.assertRaises(ValueError):
            repl_client.parse_endpoint("missing-port")

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

    def test_manager_client_call_raises_rpc_error_and_closed_connection(self) -> None:
        client = repl_client.ManagerClient("127.0.0.1", 1, "tok")
        client._socket = FakeSocket()
        client._reader = io.BytesIO(
            encode_json_line(
                {"id": "1", "ok": False, "error": {"message": "failed"}}
            ).encode("utf-8")
        )
        with self.assertRaisesRegex(RuntimeError, "failed"):
            client.call("manager.ping")

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
        with mock.patch("repl_client.socket.create_connection", return_value=fake_socket):
            client = repl_client.ManagerClient("127.0.0.1", 1, "tok")
            stderr = io.StringIO()
            with mock.patch.object(sys, "stderr", stderr):
                self.assertTrue(client.call("manager.ping"))
            client.close()

        self.assertIn("manager is closing", stderr.getvalue())

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


if __name__ == "__main__":
    unittest.main()
