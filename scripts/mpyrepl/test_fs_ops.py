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
    DOWNLOAD_END_MARKER,
    DOWNLOAD_ERROR_MARKER,
    DOWNLOAD_START_MARKER,
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

    def exec_raw(self, command: str, timeout: float, stdout_consumer=None, stderr_consumer=None):
        self.commands.append(command)
        self.timeouts.append(timeout)
        if not self.responses:
            raise AssertionError("unexpected exec_raw call")
        response = self.responses.pop(0)
        if isinstance(response, ExecResult):
            if stdout_consumer is not None and response.stdout:
                stdout_consumer(response.stdout)
            if stderr_consumer is not None and response.stderr:
                stderr_consumer(response.stderr)
            return response
        result = ExecResult(stdout=_json_stdout(response), stderr=b"")
        if stdout_consumer is not None:
            stdout_consumer(result.stdout)
        return result


class FakeStreamingTransport(FakeTransport):
    def __init__(self, responses, follow_responses=None, short_write: bool = False):
        super().__init__(responses)
        self.follow_responses = list(follow_responses or [])
        self.short_write = short_write
        self.no_follow_commands = []
        self.writes = []
        self.flushes = 0
        self.interrupts = 0

    def exec_raw_no_follow(self, command: bytes):
        self.no_follow_commands.append(command)

    def write_bytes(self, data: bytes) -> int:
        self.writes.append(data)
        if self.short_write:
            return max(0, len(data) - 1)
        return len(data)

    def flush_output(self) -> None:
        self.flushes += 1

    def follow(self, timeout: float):
        self.timeouts.append(timeout)
        if not self.follow_responses:
            raise AssertionError("unexpected follow call")
        return self.follow_responses.pop(0)

    def interrupt(self) -> None:
        self.interrupts += 1


def _json_stdout(data, ok: bool = True, error: str = "") -> bytes:
    payload = {"ok": ok, "data": data} if ok else {"ok": False, "error": error}
    return (JSON_MARKER + json.dumps(payload) + "\n").encode("utf-8")


def _download_stdout(data: bytes, *, size: int | None = None) -> bytes:
    total = len(data) if size is None else size
    return b"".join(
        [
            (DOWNLOAD_START_MARKER + json.dumps({"size": total}) + "\n").encode("ascii"),
            base64.b64encode(data) + b"\n",
            (DOWNLOAD_END_MARKER + json.dumps({"bytes": len(data)}) + "\n").encode("ascii"),
        ]
    )


def _download_error_stdout(message: str, *, size: int = 0) -> bytes:
    return b"".join(
        [
            (DOWNLOAD_START_MARKER + json.dumps({"size": size}) + "\n").encode("ascii"),
            (DOWNLOAD_ERROR_MARKER + json.dumps({"error": message}) + "\n").encode("ascii"),
        ]
    )


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
            transport = FakeTransport([True, True, 3, 3, 6])
            client = DeviceFsClient(transport)

            client.write_file(str(source), "/lib/data.bin", chunk_size=3)

        joined = "\n".join(transport.commands)
        self.assertIn('path = "/lib/data.bin.mpyupload"', joined)
        self.assertIn(base64.b64encode(b"abc").decode("ascii"), joined)
        self.assertIn(base64.b64encode(b"def").decode("ascii"), joined)
        self.assertIn("open(path, 'wb')", joined)
        self.assertIn("f.write(chunk)", joined)
        self.assertNotIn("open(path, 'ab')", joined)
        self.assertIn("f.close()", transport.commands[-1])
        self.assertIn("os.rename(tmp, target)", joined)

    def test_write_file_uses_stdin_base64_stream_when_supported(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            source = Path(tmp_dir) / "data.bin"
            source.write_bytes(b"abcdefg")
            events = []
            transport = FakeStreamingTransport(
                [True],
                [ExecResult(stdout=_json_stdout(7), stderr=b"")],
            )
            client = DeviceFsClient(transport, timeout=4.0)

            client.write_file(str(source), "/data.bin", chunk_size=6, progress=events.append)

        self.assertEqual(b"".join(transport.writes), base64.b64encode(b"abcdefg"))
        self.assertEqual(len(transport.no_follow_commands), 1)
        receiver = transport.no_follow_commands[0].decode("utf-8")
        self.assertIn("sys.stdin", receiver)
        self.assertIn("readinto", receiver)
        self.assertIn("binascii.a2b_base64", receiver)
        self.assertEqual(transport.flushes, 1)
        self.assertEqual([event["bytes"] for event in events], [0, 6, 7, 7])
        self.assertTrue(events[-1]["done"])

    def test_write_file_falls_back_when_stdin_readinto_unavailable(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            source = Path(tmp_dir) / "data.bin"
            source.write_bytes(b"abc")
            transport = FakeStreamingTransport([False, True, 3, 3])
            client = DeviceFsClient(transport)

            client.write_file(str(source), "/data.bin", chunk_size=3)

        self.assertEqual(transport.no_follow_commands, [])
        joined = "\n".join(transport.commands)
        self.assertIn("stream = getattr(sys.stdin, 'buffer', sys.stdin)", joined)
        self.assertIn("binascii.a2b_base64(encoded)", joined)
        self.assertEqual(transport.writes, [])

    def test_write_file_stdin_short_host_write_interrupts_and_cleans_temp(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            source = Path(tmp_dir) / "data.bin"
            source.write_bytes(b"abcdef")
            transport = FakeStreamingTransport(
                [True, True],
                [ExecResult(stdout=b"", stderr=b"")],
                short_write=True,
            )
            client = DeviceFsClient(transport)

            with self.assertRaisesRegex(FsOperationError, "host wrote"):
                client.write_file(str(source), "/data.bin", chunk_size=6)

        self.assertEqual(transport.interrupts, 1)
        self.assertIn("rm(path)", transport.commands[-1])
        self.assertIn("os.remove(p)", transport.commands[-1])

    def test_write_file_stdin_ignores_recovery_and_cleanup_errors(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            source = Path(tmp_dir) / "data.bin"
            source.write_bytes(b"abcdef")
            transport = FakeStreamingTransport([True], short_write=True)
            client = DeviceFsClient(transport)

            with self.assertRaisesRegex(FsOperationError, "host wrote"):
                client.write_file(str(source), "/data.bin", chunk_size=6)

        self.assertEqual(transport.interrupts, 1)

    def test_write_file_stdin_surfaces_device_stderr_and_error(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            source = Path(tmp_dir) / "data.bin"
            source.write_bytes(b"abc")
            stderr_transport = FakeStreamingTransport(
                [True, True],
                [ExecResult(stdout=b"", stderr=b"device stderr")],
            )
            with self.assertRaisesRegex(FsOperationError, "device stderr"):
                DeviceFsClient(stderr_transport).write_file(str(source), "/data.bin", chunk_size=3)
            self.assertIn("os.remove(p)", stderr_transport.commands[-1])

            error_transport = FakeStreamingTransport(
                [True, True],
                [ExecResult(stdout=_json_stdout(None, ok=False, error="device failed"), stderr=b"")],
            )
            with self.assertRaisesRegex(FsOperationError, "device failed"):
                DeviceFsClient(error_transport).write_file(str(source), "/data.bin", chunk_size=3)

    def test_write_file_stdin_probe_failure_falls_back_and_probe_is_cached(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            source = Path(tmp_dir) / "data.bin"
            source.write_bytes(b"abc")
            probe_failure = ExecResult(stdout=_json_stdout(None, ok=False, error="probe failed"), stderr=b"")
            transport = FakeStreamingTransport([probe_failure, True, 3, 3])
            client = DeviceFsClient(transport)

            client.write_file(str(source), "/data.bin", chunk_size=3)

        self.assertEqual(transport.no_follow_commands, [])
        self.assertEqual(transport.writes, [])

        cached_transport = FakeStreamingTransport([True])
        cached_client = DeviceFsClient(cached_transport)
        self.assertTrue(cached_client._supports_stdin_readinto())
        self.assertTrue(cached_client._supports_stdin_readinto())
        self.assertEqual(len(cached_transport.commands), 1)

    def test_write_file_stdin_rejects_final_size_mismatch(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            source = Path(tmp_dir) / "data.bin"
            source.write_bytes(b"abc")
            transport = FakeStreamingTransport(
                [True, True],
                [ExecResult(stdout=_json_stdout(2), stderr=b"")],
            )
            client = DeviceFsClient(transport)

            with self.assertRaisesRegex(FsOperationError, "uploaded size mismatch"):
                client.write_file(str(source), "/data.bin", chunk_size=3)

        self.assertIn('path = "/data.bin"', transport.commands[-1])
        self.assertIn("os.remove(p)", transport.commands[-1])

    def test_write_file_reports_progress_and_cleans_temp_on_failure(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            source = Path(tmp_dir) / "data.bin"
            source.write_bytes(b"abcdef")
            events = []
            transport = FakeTransport(
                [
                    True,
                    True,
                    ExecResult(stdout=_json_stdout(None, ok=False, error="write failed"), stderr=b""),
                    True,
                ]
            )
            client = DeviceFsClient(transport)

            with self.assertRaisesRegex(FsOperationError, "write failed"):
                client.write_file(str(source), "/lib/data.bin", chunk_size=3, progress=events.append)

        self.assertEqual([event["bytes"] for event in events], [0])
        self.assertEqual(events[0]["total"], 6)
        self.assertIn('path = "/lib/data.bin.mpyupload"', transport.commands[-1])
        self.assertIn("f.close()", transport.commands[-1])
        self.assertIn("os.remove(path)", transport.commands[-1])

    def test_write_file_reports_chunk_progress(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            source = Path(tmp_dir) / "data.bin"
            source.write_bytes(b"abcdef")
            events = []
            transport = FakeTransport([True, True, 3, 3, 6])
            client = DeviceFsClient(transport)

            client.write_file(str(source), "/lib/data.bin", chunk_size=3, progress=events.append)

        self.assertEqual([event["bytes"] for event in events], [0, 3, 6, 6])
        self.assertTrue(events[-1]["done"])

    def test_write_file_rejects_short_chunk_write(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            source = Path(tmp_dir) / "data.bin"
            source.write_bytes(b"abc")
            transport = FakeTransport([True, True, 2, True])
            client = DeviceFsClient(transport)

            with self.assertRaisesRegex(FsOperationError, "device wrote 2 of 3 bytes"):
                client.write_file(str(source), "/lib/data.bin", chunk_size=3)

        self.assertIn("os.remove(path)", transport.commands[-1])

    def test_write_file_rejects_final_size_mismatch(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            source = Path(tmp_dir) / "data.bin"
            source.write_bytes(b"abc")
            transport = FakeTransport([True, True, 3, 2, True, True])
            client = DeviceFsClient(transport)

            with self.assertRaisesRegex(FsOperationError, "uploaded size mismatch"):
                client.write_file(str(source), "/lib/data.bin", chunk_size=3)

        self.assertIn("os.remove(p)", transport.commands[-1])

    def test_read_file_downloads_chunks_to_local_temp_then_replaces(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            target = Path(tmp_dir) / "out.bin"
            transport = FakeTransport(
                [
                    {"exists": True, "mode": 0, "size": 5, "mtime": 0, "is_dir": False},
                    ExecResult(stdout=_download_stdout(b"hello"), stderr=b""),
                ]
            )
            client = DeviceFsClient(transport)
            events = []

            client.read_file("/remote.bin", str(target), chunk_size=16, progress=events.append)
            self.assertEqual(target.read_bytes(), b"hello")
            self.assertFalse(target.with_name("out.bin.mpydownload").exists())
            self.assertEqual(
                events,
                [
                    {
                        "op": "read_file",
                        "path": "/remote.bin",
                        "local_path": str(target),
                        "bytes": 0,
                        "total": 5,
                        "done": False,
                    },
                    {
                        "op": "read_file",
                        "path": "/remote.bin",
                        "local_path": str(target),
                        "bytes": 5,
                        "total": 5,
                        "done": False,
                    },
                    {
                        "op": "read_file",
                        "path": "/remote.bin",
                        "local_path": str(target),
                        "bytes": 5,
                        "total": 5,
                        "done": True,
                    },
                ],
            )

    def test_read_file_rejects_size_mismatch_and_removes_temp(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            target = Path(tmp_dir) / "out.bin"
            transport = FakeTransport(
                [
                    {"exists": True, "mode": 0, "size": 5, "mtime": 0, "is_dir": False},
                    ExecResult(stdout=_download_stdout(b"he", size=5), stderr=b""),
                ]
            )
            client = DeviceFsClient(transport)

            with self.assertRaisesRegex(FsOperationError, "downloaded size mismatch"):
                client.read_file("/remote.bin", str(target), chunk_size=16)

            self.assertFalse(target.exists())
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
        self.assertEqual(DEFAULT_CHUNK_SIZE, 4096)


if __name__ == "__main__":
    unittest.main()
