from __future__ import annotations

import argparse
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


SCRIPTS_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

from mpyrepl.clients import agent as agent_client
from mpyrepl.manager.protocol import encode_json_line


class FakeSocket:
    def __init__(self, response: bytes = b"") -> None:
        self.response = response
        self.sent: list[bytes] = []
        self.timeouts: list[float | None] = []
        self.closed = False

    def settimeout(self, timeout: float | None) -> None:
        self.timeouts.append(timeout)

    def makefile(self, mode: str):
        return io.BytesIO(self.response)

    def sendall(self, data: bytes) -> None:
        self.sent.append(data)

    def close(self) -> None:
        self.closed = True


class FakeClient:
    instances: list["FakeClient"] = []

    def __init__(self, host: str, port: int, token: str, *, progress: bool = False) -> None:
        self.host = host
        self.port = port
        self.token = token
        self.progress = progress
        self.calls: list[tuple[str, dict, float]] = []
        self.closed = False
        FakeClient.instances.append(self)

    def call(self, method: str, params=None, timeout: float = 30.0):
        self.calls.append((method, params or {}, timeout))
        if method == "manager.hello":
            return {"protocolVersion": 1, "managerInstanceId": "instance-1", "role": "agent"}
        if method == "manager.status":
            return {"state": "ready", "busy": False, "queuedOperationCount": 0}
        if method == "repl.exec":
            return {"stdout": "ok\n", "stderr": ""}
        return {"method": method}

    def close(self) -> None:
        self.closed = True


class DeviceErrorClient(FakeClient):
    def call(self, method: str, params=None, timeout: float = 30.0):
        result = super().call(method, params, timeout)
        if method == "repl.exec":
            return {"stdout": "", "stderr": "Traceback\r\n"}
        return result


def write_descriptor(root: Path, **overrides) -> Path:
    path = root / ".mpy-workbench" / "serial-manager.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "schemaVersion": 1,
        "protocolVersion": 1,
        "managerInstanceId": "instance-1",
        "host": "127.0.0.1",
        "port": 12345,
        "token": "secret",
    }
    payload.update(overrides)
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


class AgentClientTests(unittest.TestCase):
    def setUp(self) -> None:
        FakeClient.instances.clear()

    def test_discovers_descriptor_from_parent_workspace(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            expected = write_descriptor(root)
            nested = root / "mpy" / "lib"
            nested.mkdir(parents=True)

            self.assertEqual(agent_client.discover_session_file(cwd=nested), expected.resolve())
            descriptor = agent_client.load_session_descriptor(expected)
            self.assertEqual(descriptor["port"], 12345)

    def test_stdlib_rpc_client_handles_progress_and_response(self) -> None:
        request_id = "agent-42-1-deadbeef"
        response = (
            encode_json_line({"event": "status", "payload": {"state": "ready"}})
            + encode_json_line({"event": "progress", "payload": {"operationId": "other", "bytes": 1}})
            + encode_json_line({"event": "progress", "payload": {"operationId": request_id, "bytes": 2}})
            + encode_json_line({"id": request_id, "ok": True, "result": {"done": True}})
        ).encode("utf-8")
        fake_socket = FakeSocket(response)
        fake_uuid = mock.Mock(hex="deadbeef12345678")
        stderr = io.StringIO()
        with mock.patch("mpyrepl.clients.agent.socket.create_connection", return_value=fake_socket), mock.patch(
            "mpyrepl.clients.agent.os.getpid", return_value=42
        ), mock.patch("mpyrepl.clients.agent.uuid.uuid4", return_value=fake_uuid), mock.patch.object(sys, "stderr", stderr):
            client = agent_client.AgentManagerClient("127.0.0.1", 12345, "secret", progress=True)
            result = client.call("manager.ping", timeout=2.0)
            client.close()

        self.assertEqual(result, {"done": True})
        self.assertIn(b'"method":"manager.ping"', fake_socket.sent[0])
        self.assertEqual(stderr.getvalue().count('"event": "progress"'), 1)
        self.assertTrue(fake_socket.closed)

    def test_stdlib_rpc_client_raises_structured_manager_error(self) -> None:
        request_id = "agent-42-1-deadbeef"
        response = encode_json_line(
            {"id": request_id, "ok": False, "error": {"code": "busy", "message": "occupied", "details": {"operation": "fs"}}}
        ).encode("utf-8")
        fake_socket = FakeSocket(response)
        fake_uuid = mock.Mock(hex="deadbeef12345678")
        with mock.patch("mpyrepl.clients.agent.socket.create_connection", return_value=fake_socket), mock.patch(
            "mpyrepl.clients.agent.os.getpid", return_value=42
        ), mock.patch("mpyrepl.clients.agent.uuid.uuid4", return_value=fake_uuid):
            client = agent_client.AgentManagerClient("127.0.0.1", 12345, "secret")
            with self.assertRaisesRegex(agent_client.ManagerRequestError, "occupied") as raised:
                client.call("repl.exec")
            client.close()

        self.assertEqual(raised.exception.code, "busy")
        self.assertEqual(raised.exception.details, {"operation": "fs"})

    def test_descriptor_discovery_supports_environment_and_workspace(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            expected = write_descriptor(root).resolve()
            with mock.patch.dict(os.environ, {agent_client.SESSION_ENV: str(expected)}):
                self.assertEqual(agent_client.discover_session_file(), expected)
            with mock.patch.dict(os.environ, {}, clear=True):
                self.assertEqual(agent_client.discover_session_file(workspace=str(root)), expected)

    def test_rejects_non_loopback_and_protocol_mismatch(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            remote = write_descriptor(root, host="192.0.2.1")
            with self.assertRaisesRegex(agent_client.AgentCliError, "loopback"):
                agent_client.load_session_descriptor(remote)
            mismatch = write_descriptor(root, host="127.0.0.1", protocolVersion=99)
            with self.assertRaisesRegex(agent_client.AgentCliError, "protocol"):
                agent_client.load_session_descriptor(mismatch)

    def test_exec_uses_bounded_manager_queue_and_never_serial_port(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            descriptor = write_descriptor(Path(temp_dir))
            args = agent_client.build_agent_parser().parse_args(
                ["--session", str(descriptor), "--queue-timeout", "7", "--timeout", "11", "exec", "--code", "print(1)"]
            )

            exit_code, payload = agent_client.run_agent(args, FakeClient)

        client = FakeClient.instances[0]
        self.assertEqual(exit_code, 0)
        self.assertTrue(payload["ok"])
        self.assertTrue(client.closed)
        self.assertIn(("manager.hello", {"role": "agent"}, 5.0), client.calls)
        exec_call = next(call for call in client.calls if call[0] == "repl.exec")
        self.assertEqual(exec_call[1]["queuePolicy"], "wait")
        self.assertEqual(exec_call[1]["queueTimeoutMs"], 7000)
        self.assertEqual(exec_call[1]["followTimeout"], 11.0)

    def test_file_commands_use_existing_manager_rpc(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            descriptor = write_descriptor(root)
            local_file = root / "main.py"
            local_file.write_text("print(1)", encoding="utf-8")
            args = agent_client.build_agent_parser().parse_args(
                ["--session", str(descriptor), "put", str(local_file), "/sd/main.py"]
            )

            exit_code, _ = agent_client.run_agent(args, FakeClient)

        self.assertEqual(exit_code, 0)
        put_call = next(call for call in FakeClient.instances[0].calls if call[0] == "fs.writeFile")
        self.assertEqual(put_call[1]["devicePath"], "/sd/main.py")
        self.assertEqual(put_call[1]["localPath"], str(local_file.resolve()))

    def test_all_agent_command_mappings(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source_file = root / "demo.py"
            source_file.write_text("value = 1", encoding="utf-8")
            cases = [
                (["status"], "manager.status"),
                (["wait-idle", "--idle-timeout", "1"], "manager.status"),
                (["interrupt"], "device.interrupt"),
                (["soft-reset"], "device.softReset"),
                (["exec-file", str(source_file)], "repl.exec"),
                (["ls", "/sd"], "fs.listdir"),
                (["tree", "/sd"], "fs.tree"),
                (["stat", "/sd/demo.py"], "fs.stat"),
                (["get", "/sd/demo.py", str(root / "download.py")], "fs.readFile"),
                (["mkdir", "/sd/new", "--no-parents"], "fs.mkdir"),
                (["rm", "/sd/old", "--recursive", "--yes"], "fs.remove"),
                (["mv", "/sd/a", "/sd/b"], "fs.rename"),
            ]
            for argv, expected_method in cases:
                with self.subTest(command=argv[0]):
                    client = FakeClient("127.0.0.1", 1, "x")
                    args = agent_client.build_agent_parser().parse_args(argv)
                    agent_client.execute_agent_command(client, args)
                    self.assertEqual(client.calls[-1][0], expected_method)

    def test_exec_device_stderr_is_a_failed_agent_result(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            descriptor = write_descriptor(Path(temp_dir))
            args = agent_client.build_agent_parser().parse_args(
                ["--session", str(descriptor), "exec", "--code", "bad()"]
            )
            exit_code, payload = agent_client.run_agent(args, DeviceErrorClient)

        self.assertEqual(exit_code, agent_client.EXIT_DEVICE)
        self.assertFalse(payload["ok"])
        self.assertIn("Traceback", payload["result"]["stderr"])

    def test_rm_requires_explicit_confirmation(self) -> None:
        args = agent_client.build_agent_parser().parse_args(["rm", "/sd/data"])
        with self.assertRaisesRegex(agent_client.AgentCliError, "--yes"):
            agent_client.execute_agent_command(FakeClient("127.0.0.1", 1, "x"), args)

    def test_main_writes_one_json_result_for_discovery_error(self) -> None:
        output = io.StringIO()
        with mock.patch.object(sys, "stdout", output), mock.patch.dict(os.environ, {}, clear=True), tempfile.TemporaryDirectory() as temp_dir:
            with mock.patch("pathlib.Path.cwd", return_value=Path(temp_dir)):
                exit_code = agent_client.main(["status"])

        lines = output.getvalue().splitlines()
        self.assertEqual(exit_code, agent_client.EXIT_DISCOVERY)
        self.assertEqual(len(lines), 1)
        self.assertFalse(json.loads(lines[0])["ok"])

    def test_rpc_exit_codes_are_stable(self) -> None:
        self.assertEqual(agent_client._exit_for_rpc("busy"), agent_client.EXIT_BUSY)
        self.assertEqual(agent_client._exit_for_rpc("queue_timeout"), agent_client.EXIT_TIMEOUT)
        self.assertEqual(agent_client._exit_for_rpc("transport_lost"), agent_client.EXIT_TRANSPORT)
        self.assertEqual(agent_client._exit_for_rpc("device"), agent_client.EXIT_DEVICE)
        self.assertEqual(agent_client._exit_for_rpc("other"), agent_client.EXIT_RPC)


if __name__ == "__main__":
    unittest.main()
