from __future__ import annotations

import base64
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
if CURRENT_DIR not in sys.path:
    sys.path.insert(0, CURRENT_DIR)

from fs_ops import (
    DEFAULT_CHUNK_SIZE,
    JSON_MARKER,
    DeviceFsClient,
    FsOperationError,
    _join_device_path,
    _normalize_device_path,
    _parent_paths,
    _parse_json_result,
    response_payload,
    run_fs_operation,
    list_serial_ports,
)
from models import ExecResult


class FakeTransport:
    def __init__(self, responses):
        self.responses = list(responses)
        self.commands = []
        self.timeouts = []

    def exec_raw(self, command: str, timeout: float):
        self.commands.append(command)
        self.timeouts.append(timeout)
        if not self.responses:
            raise AssertionError("unexpected exec_raw call")
        response = self.responses.pop(0)
        if isinstance(response, ExecResult):
            return response
        return ExecResult(stdout=_json_stdout(response), stderr=b"")


def _json_stdout(data, ok: bool = True, error: str = "") -> bytes:
    payload = {"ok": ok, "data": data} if ok else {"ok": False, "error": error}
    return (JSON_MARKER + json.dumps(payload) + "\n").encode("utf-8")


class FsOpsTests(unittest.TestCase):
    def test_path_helpers_normalize_join_and_parent_paths(self) -> None:
        self.assertEqual(_normalize_device_path(""), "/")
        self.assertEqual(_normalize_device_path(":\\lib\\main.py"), "/lib/main.py")
        self.assertEqual(_normalize_device_path("lib/main.py"), "/lib/main.py")
        self.assertEqual(_join_device_path("/", "main.py"), "/main.py")
        self.assertEqual(_join_device_path("/lib", "drivers/sh.py"), "/lib/drivers/sh.py")
        self.assertEqual(_parent_paths("/lib/drivers/main.py"), ["/lib", "/lib/drivers"])
        self.assertEqual(_parent_paths("/main.py"), [])

    def test_parse_json_result_validates_marker_and_payload(self) -> None:
        self.assertEqual(_parse_json_result(b"noise\n" + _json_stdout({"x": 1})), {"ok": True, "data": {"x": 1}})
        with self.assertRaisesRegex(FsOperationError, "response marker"):
            _parse_json_result(b"no marker")
        with self.assertRaisesRegex(FsOperationError, "invalid device JSON"):
            _parse_json_result((JSON_MARKER + "{bad").encode("utf-8"))
        with self.assertRaisesRegex(FsOperationError, "not an object"):
            _parse_json_result((JSON_MARKER + "[]").encode("utf-8"))

    def test_execute_success_device_error_and_stderr(self) -> None:
        client = DeviceFsClient(FakeTransport([{"ok": 1}]), timeout=2.5)
        self.assertEqual(client.execute("data = 1"), {"ok": 1})

        with self.assertRaisesRegex(FsOperationError, "boom"):
            DeviceFsClient(FakeTransport([ExecResult(stdout=_json_stdout(None, ok=False, error="boom"), stderr=b"")])).execute("data = 1")

        with self.assertRaisesRegex(FsOperationError, "stderr text"):
            DeviceFsClient(FakeTransport([ExecResult(stdout=b"", stderr=b"stderr text")])).execute("data = 1")

    def test_stat_listdir_tree_and_exec_json(self) -> None:
        transport = FakeTransport(
            [
                {"exists": True, "mode": 0x4000, "size": 12, "mtime": 7, "is_dir": True},
                [{"name": "main.py", "is_dir": False, "size": 4, "mtime": 1, "mode": 0}],
                [{"path": "/", "is_dir": True, "size": 0, "mtime": 0, "mode": 0x4000}],
                ExecResult(stdout=b"out", stderr=b"err"),
            ]
        )
        client = DeviceFsClient(transport, timeout=3.0)

        self.assertTrue(client.stat("lib")["is_dir"])
        self.assertEqual(client.listdir("/")[0]["name"], "main.py")
        self.assertEqual(client.tree("/")[0]["path"], "/")
        self.assertEqual(client.exec_json("print('x')"), {"stdout": "out", "stderr": "err"})
        self.assertIn('path = "/lib"', transport.commands[0])
        self.assertIn("os.listdir(root)", transport.commands[1])
        self.assertIn("def add(path):", transport.commands[2])
        self.assertEqual(transport.timeouts, [3.0, 3.0, 3.0, 3.0])

    def test_mutating_operations_generate_expected_device_code(self) -> None:
        transport = FakeTransport([True, True, True, True, True, True])
        client = DeviceFsClient(transport)

        client.mkdir("/lib/drivers", parents=True)
        client.remove("/lib/old.py", recursive=False)
        client.rename("/lib/a.py", "/lib/b.py")

        joined = "\n".join(transport.commands)
        self.assertIn('path = "/lib"', joined)
        self.assertIn("recursive = False", joined)
        self.assertIn('src = "/lib/a.py"', joined)
        self.assertIn('dst = "/lib/b.py"', joined)

    def test_write_file_uploads_base64_chunks_and_finishes_atomically(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            source = Path(tmp_dir) / "data.bin"
            source.write_bytes(b"abcdef")
            transport = FakeTransport([True, True, 3, 3, True])
            client = DeviceFsClient(transport)

            client.write_file(str(source), "/lib/data.bin", chunk_size=3)

        joined = "\n".join(transport.commands)
        self.assertIn('path = "/lib/data.bin.mpyupload"', joined)
        self.assertIn(base64.b64encode(b"abc").decode("ascii"), joined)
        self.assertIn(base64.b64encode(b"def").decode("ascii"), joined)
        self.assertIn("os.rename(tmp, target)", joined)

    def test_read_file_downloads_chunks_to_local_temp_then_replaces(self) -> None:
        encoded = base64.b64encode(b"hello").decode("ascii")
        with tempfile.TemporaryDirectory() as tmp_dir:
            target = Path(tmp_dir) / "out.bin"
            transport = FakeTransport(
                [
                    {"exists": True, "mode": 0, "size": 5, "mtime": 0, "is_dir": False},
                    encoded,
                ]
            )
            client = DeviceFsClient(transport)

            client.read_file("/remote.bin", str(target), chunk_size=16)
            self.assertEqual(target.read_bytes(), b"hello")
            self.assertFalse(target.with_name("out.bin.mpydownload").exists())

    def test_read_file_missing_raises_not_found(self) -> None:
        client = DeviceFsClient(FakeTransport([None]))
        with self.assertRaisesRegex(FsOperationError, "file not found"):
            client.read_file("/missing.py", "unused.py")

    def test_run_fs_operation_dispatches_and_rejects_unsupported(self) -> None:
        client = mock.Mock()
        client.stat.return_value = {"exists": True}
        client.listdir.return_value = []
        client.tree.return_value = []
        client.exec_json.return_value = {"stdout": "", "stderr": ""}

        self.assertEqual(run_fs_operation(client, "stat", {"path": "/a"}), {"exists": True})
        self.assertEqual(run_fs_operation(client, "listdir", {"path": "/"}), [])
        self.assertEqual(run_fs_operation(client, "tree", {"root": "/"}), [])
        self.assertTrue(run_fs_operation(client, "mkdir", {"path": "/d", "parents": False}))
        self.assertTrue(run_fs_operation(client, "remove", {"path": "/d", "recursive": False}))
        self.assertTrue(run_fs_operation(client, "rename", {"src": "/a", "dst": "/b"}))
        self.assertTrue(run_fs_operation(client, "write_file", {"local_path": "a", "path": "/a"}))
        self.assertTrue(run_fs_operation(client, "read_file", {"path": "/a", "local_path": "a"}))
        self.assertEqual(run_fs_operation(client, "exec", {"source": "print(1)"}), {"stdout": "", "stderr": ""})
        with self.assertRaisesRegex(FsOperationError, "unsupported"):
            run_fs_operation(client, "bad", {})

    def test_list_serial_ports_and_response_payload(self) -> None:
        fake_port = mock.Mock(device="COM7", description="USB Serial", manufacturer="")
        with mock.patch("serial.tools.list_ports.comports", return_value=[fake_port]):
            self.assertEqual(list_serial_ports(), [{"port": "COM7", "name": "USB Serial"}])

        self.assertEqual(response_payload("r1", True, data={"x": 1}), {"request_id": "r1", "ok": True, "data": {"x": 1}})
        self.assertEqual(
            response_payload("r2", False, error="bad", code="bad_code"),
            {"request_id": "r2", "ok": False, "error": "bad", "code": "bad_code"},
        )

    def test_default_chunk_size_is_positive(self) -> None:
        self.assertGreater(DEFAULT_CHUNK_SIZE, 0)


if __name__ == "__main__":
    unittest.main()
