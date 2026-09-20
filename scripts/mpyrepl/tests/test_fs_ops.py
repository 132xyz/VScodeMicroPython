from __future__ import annotations

import base64
import builtins
import json
import re
import hashlib
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock


SCRIPTS_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

from mpyrepl.runtime.filesystem import (
    DEFAULT_CHUNK_SIZE,
    DOWNLOAD_END_MARKER,
    DOWNLOAD_ERROR_MARKER,
    DOWNLOAD_START_MARKER,
    DOWNLOAD_DATA_MARKER,
    JSON_MARKER,
    DeviceFsClient,
    FsOperationError,
    _join_device_path,
    _normalize_device_path,
    _parent_paths,
    _parse_json_result,
    _wrap_device_code,
    response_payload,
    run_fs_operation,
    list_serial_ports,
)
from mpyrepl.runtime.models import ExecResult
from mpyrepl.runtime.response_stream import encode_frame


def _wire_response(command: str, result: ExecResult) -> ExecResult:
    nonce = re.search(r"MPY:([0-9a-f]{24}):", command)
    if nonce is None:
        return result
    lines = result.stdout.splitlines(keepends=True)
    payload = b""
    block_index = 0
    for line in lines:
        line = line.rstrip(b"\r\n")
        if line.startswith(JSON_MARKER.encode()):
            line = line[len(JSON_MARKER):].rstrip(b"\r\n")
        elif DOWNLOAD_DATA_MARKER in command and not line.startswith(b"__MPYFS_"):
            try:
                size = len(base64.b64decode(line, validate=True))
            except Exception:
                size = 0
            line = (DOWNLOAD_DATA_MARKER + json.dumps({"index": block_index, "size": size, "data": line.decode('ascii')})).encode()
            block_index += 1
        payload += encode_frame(nonce.group(1), line)
    return ExecResult(stdout=payload, stderr=result.stderr)


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
            response = _wire_response(command, response)
            if stdout_consumer is not None and response.stdout:
                stdout_consumer(response.stdout)
            if stderr_consumer is not None and response.stderr:
                stderr_consumer(response.stderr)
            return response
        result = _wire_response(command, ExecResult(stdout=_json_stdout(response), stderr=b""))
        if stdout_consumer is not None:
            stdout_consumer(result.stdout)
        return result


class FragmentedTransport(FakeTransport):
    def __init__(self, responses, read_size: int):
        super().__init__(responses)
        self.read_size = read_size

    def exec_raw(self, command: str, timeout: float, stdout_consumer=None, stderr_consumer=None):
        result = super().exec_raw(command, timeout, stderr_consumer=stderr_consumer)
        if stdout_consumer is not None:
            for start in range(0, len(result.stdout), self.read_size):
                stdout_consumer(result.stdout[start : start + self.read_size])
        return result


class MirroredBinaryStdout:
    """Model stream retries after a mirror short-writes an already-sent chunk."""

    def __init__(self, primary: bytearray, mirror_capacity: int):
        self.primary = primary
        self.mirror_capacity = mirror_capacity

    def write(self, data: bytes) -> int:
        total = len(data)
        while data:
            self.primary.extend(data)
            data = data[self.mirror_capacity :]
        return total


class RecordingTextStdout:
    def __init__(self, mirror_capacity: int | None):
        self.primary = bytearray()
        if mirror_capacity is not None:
            self.buffer = MirroredBinaryStdout(self.primary, mirror_capacity)

    def write(self, text: str) -> int:
        self.primary.extend(text.replace("\n", "\r\n").encode("ascii"))
        return len(text)


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

    def follow(self, timeout: float, stdout_consumer=None, stderr_consumer=None):
        self.timeouts.append(timeout)
        if not self.follow_responses:
            raise AssertionError("unexpected follow call")
        result = _wire_response(self.no_follow_commands[-1].decode(), self.follow_responses.pop(0))
        if stdout_consumer:
            stdout_consumer(result.stdout)
        if stderr_consumer:
            stderr_consumer(result.stderr)
        return result

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
            (DOWNLOAD_END_MARKER + json.dumps({"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}) + "\n").encode("ascii"),
        ]
    )


def _download_error_stdout(message: str, *, size: int = 0) -> bytes:
    return b"".join(
        [
            (DOWNLOAD_START_MARKER + json.dumps({"size": size}) + "\n").encode("ascii"),
            (DOWNLOAD_ERROR_MARKER + json.dumps({"error": message}) + "\n").encode("ascii"),
        ]
    )


def _capture_download_sender(source: Path, chunk_size: int, mirror_capacity: int | None) -> bytes:
    stdout = RecordingTextStdout(mirror_capacity)
    fake_sys = SimpleNamespace(stdout=stdout)

    def import_for_sender(name, *args, **kwargs):
        if name == "sys":
            return fake_sys
        return builtins.__import__(name, *args, **kwargs)

    namespace = {"__builtins__": {**vars(builtins), "__import__": import_for_sender}}
    sender = DeviceFsClient(FakeTransport([]))._stdout_base64_sender_code(
        str(source), source.stat().st_size, chunk_size
    )
    exec(sender, namespace)
    return bytes(stdout.primary)


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

    def test_wrapped_device_code_keeps_operation_locals_private(self) -> None:
        namespace: dict[str, object] = {}
        stdout = []

        def fake_print(value):
            stdout.append(value)

        namespace["print"] = fake_print
        exec(_wrap_device_code("items = [1]\ndata = items"), namespace)

        self.assertEqual(stdout, [JSON_MARKER + json.dumps({"ok": True, "data": [1]})])
        self.assertNotIn("items", namespace)
        self.assertNotIn("data", namespace)
        self.assertNotIn("__mpy_fs_op", namespace)
        self.assertNotIn("__mpy_data", namespace)
        self.assertNotIn("__mpy_json", namespace)

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

    def test_download_sender_does_not_repeat_data_when_mirror_short_writes(self) -> None:
        data = (bytes(range(256)) * 16)[:4026]
        with tempfile.TemporaryDirectory() as tmp_dir:
            source = Path(tmp_dir) / "source.bin"
            source.write_bytes(data)
            for chunk_size, capacity in ((4096, 4096), (4096, 2715), (1024, 400)):
                with self.subTest(chunk_size=chunk_size, mirror_capacity=capacity):
                    stream = _capture_download_sender(source, chunk_size, capacity)
                    lines = stream.splitlines()
                    self.assertTrue(lines[0].startswith(DOWNLOAD_START_MARKER.encode("ascii")))
                    self.assertTrue(lines[-1].startswith(DOWNLOAD_END_MARKER.encode("ascii")))
                    expected = [
                        base64.b64encode(data[start : start + chunk_size])
                        for start in range(0, len(data), chunk_size)
                    ]
                    self.assertEqual([len(line) for line in lines[1:-1]], [len(line) for line in expected])
                    self.assertEqual(lines[1:-1], expected)
                    self.assertEqual(b"".join(base64.b64decode(line, validate=True) for line in lines[1:-1]), data)

    def test_download_sender_roundtrips_binary_boundaries_and_fragmented_output(self) -> None:
        sizes = (0, 1, 2, 3, 1024, 3071, 3072, 3073, 4026, 4096, 8192)
        with tempfile.TemporaryDirectory() as tmp_dir:
            source = Path(tmp_dir) / "source.bin"
            target = Path(tmp_dir) / "target.bin"
            for size in sizes:
                data = (bytes(range(256)) * ((size + 255) // 256))[:size]
                source.write_bytes(data)
                for capacity in (None, 4096):
                    stream = _capture_download_sender(source, DEFAULT_CHUNK_SIZE, capacity)
                    for read_size in (1, 7, 4096):
                        with self.subTest(size=size, mirror_capacity=capacity, read_size=read_size):
                            target.write_bytes(b"existing target")
                            events = []
                            transport = FragmentedTransport(
                                [
                                    {"exists": True, "mode": 0, "size": size, "mtime": 0, "is_dir": False},
                                    ExecResult(stdout=stream, stderr=b""),
                                ],
                                read_size,
                            )
                            DeviceFsClient(transport).read_file("/source.bin", str(target), progress=events.append)
                            self.assertEqual(target.read_bytes(), data)
                            self.assertFalse(target.with_name("target.bin.mpydownload").exists())
                            self.assertEqual(len(transport.commands), 2)
                            self.assertEqual(events[-1]["bytes"], size)
                            self.assertTrue(events[-1]["done"])
                            self.assertEqual(sum(bool(event["done"]) for event in events), 1)
                            counts = [event["bytes"] for event in events]
                            self.assertEqual(counts, sorted(counts))
                            self.assertTrue(all(count <= size for count in counts))

    def test_read_file_repeated_or_invalid_tail_preserves_existing_target(self) -> None:
        data = (bytes(range(256)) * 16)[:4026]
        encoded = base64.b64encode(data)
        with tempfile.TemporaryDirectory() as tmp_dir:
            target = Path(tmp_dir) / "target.bin"
            for tail_start, error_code in ((4096, "size_mismatch"), (2715, "bad_response")):
                with self.subTest(tail_start=tail_start):
                    target.write_bytes(b"existing target")
                    stream = _download_stdout(data).replace(
                        DOWNLOAD_END_MARKER.encode("ascii"),
                        encoded[tail_start:] + b"\n" + DOWNLOAD_END_MARKER.encode("ascii"),
                    )
                    transport = FakeTransport(
                        [
                            {"exists": True, "mode": 0, "size": len(data), "mtime": 0, "is_dir": False},
                            ExecResult(stdout=stream, stderr=b""),
                        ]
                    )
                    events = []
                    with self.assertRaises(FsOperationError) as raised:
                        DeviceFsClient(transport).read_file("/source.bin", str(target), progress=events.append)
                    self.assertEqual(raised.exception.code, error_code)
                    self.assertEqual(target.read_bytes(), b"existing target")
                    self.assertFalse(target.with_name("target.bin.mpydownload").exists())
                    self.assertFalse(any(event["done"] for event in events))

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
