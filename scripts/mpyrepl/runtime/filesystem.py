"""Device filesystem operations implemented over the raw REPL transport.

:return: None
"""

from __future__ import annotations

import base64
import json
import os
from pathlib import Path
from typing import Any, Callable

from mpyrepl.runtime.transport import SerialReplTransport


JSON_MARKER = "__MPYFS_JSON__"
PROGRESS_MARKER = "__MPYFS_PROGRESS__"
DOWNLOAD_START_MARKER = "__MPYFS_DOWNLOAD_START__"
DOWNLOAD_END_MARKER = "__MPYFS_DOWNLOAD_END__"
DOWNLOAD_ERROR_MARKER = "__MPYFS_DOWNLOAD_ERROR__"
DEFAULT_CHUNK_SIZE = 4096
UPLOAD_HANDLE_VAR = "__mpy_upload_file"
UPLOAD_PATH_VAR = "__mpy_upload_path"
STDIN_UPLOAD_MIN_CHUNK_SIZE = 3


class FsOperationError(RuntimeError):
    """Raised when a device filesystem operation fails."""

    def __init__(self, message: str, code: str = "device_error") -> None:
        """Store a stable error code alongside the message.

        :param message: Human-readable message.
        :param code: Stable error code.
        :return: None
        """
        super().__init__(message)
        self.code = code


def _device_string(value: str) -> str:
    """Return a Python string literal safe for device-side source.

    :param value: Value to embed.
    :return: Python string literal.
    """
    return json.dumps(value)


def _normalize_device_path(path: str) -> str:
    """Normalize a device path to an absolute POSIX-style path.

    :param path: Raw device path.
    :return: Normalized device path.
    """
    value = (path or "/").replace("\\", "/")
    if value.startswith(":"):
        value = value[1:]
    value = "/" + value.strip("/")
    return "/" if value == "/" else value


def _join_device_path(parent: str, name: str) -> str:
    """Join a device parent path and child name.

    :param parent: Parent path.
    :param name: Child name.
    :return: Joined path.
    """
    parent = _normalize_device_path(parent)
    return "/" + name.strip("/") if parent == "/" else parent.rstrip("/") + "/" + name


def _parent_paths(path: str) -> list[str]:
    """Return parent directories from shallow to deep.

    :param path: Device path.
    :return: Parent directory list.
    """
    normalized = _normalize_device_path(path)
    parent = normalized.rsplit("/", 1)[0]
    if not parent or parent == "/":
        return []
    parts = parent.strip("/").split("/")
    return ["/" + "/".join(parts[:index]) for index in range(1, len(parts) + 1)]


def _parse_json_result(stdout: bytes) -> dict[str, Any]:
    """Extract the marked JSON result line from raw stdout bytes.

    :param stdout: Raw stdout bytes.
    :return: Parsed payload.
    """
    text = stdout.decode("utf-8", errors="replace")
    for line in reversed(text.splitlines()):
        if line.startswith(JSON_MARKER):
            try:
                payload = json.loads(line[len(JSON_MARKER) :])
            except json.JSONDecodeError as exc:
                raise FsOperationError("invalid device JSON response: %s" % exc, "bad_json")
            if isinstance(payload, dict):
                return payload
            raise FsOperationError("device JSON response was not an object", "bad_json")
    raise FsOperationError("device response marker not found", "bad_response")


def _wrap_device_code(body: str) -> str:
    """Wrap a device-side body so it always prints one JSON result line.

    :param body: Indented Python statements assigning ``data``.
    :return: Complete source code.
    """
    indented = "\n".join("    " + line if line else "" for line in body.splitlines())
    return (
        "try:\n"
        "    import ujson as __mpy_json\n"
        "except ImportError:\n"
        "    import json as __mpy_json\n"
        "def __mpy_fs_op():\n"
        "    data = None\n"
        f"{indented}\n"
        "    return data\n"
        "try:\n"
        "    __mpy_data = __mpy_fs_op()\n"
        f"    print({JSON_MARKER!r} + __mpy_json.dumps({{'ok': True, 'data': __mpy_data}}))\n"
        "except Exception as exc:\n"
        f"    print({JSON_MARKER!r} + __mpy_json.dumps({{'ok': False, 'error': repr(exc)}}))\n"
        "finally:\n"
        "    try:\n"
        "        del __mpy_fs_op\n"
        "    except NameError:\n"
        "        pass\n"
        "    try:\n"
        "        del __mpy_data\n"
        "    except NameError:\n"
        "        pass\n"
        "    try:\n"
        "        del __mpy_json\n"
        "    except NameError:\n"
        "        pass\n"
    )


class DeviceFsClient:
    """Filesystem RPC client that uses an already-open raw REPL transport.

    :param transport: Active raw REPL transport.
    :param timeout: Follow timeout for short filesystem commands.
    :return: None
    """

    def __init__(self, transport: SerialReplTransport, timeout: float = 10.0) -> None:
        """Store the transport and default command timeout.

        :param transport: Active transport.
        :param timeout: Follow timeout in seconds.
        :return: None
        """
        self._transport = transport
        self._timeout = timeout
        self._stdin_readinto_supported: bool | None = None

    def execute(self, body: str) -> Any:
        """Execute a wrapped device-side operation and return its data.

        :param body: Device-side source body.
        :return: Parsed ``data`` field.
        """
        result = self._transport.exec_raw(_wrap_device_code(body), timeout=self._timeout)
        if result.stderr:
            raise FsOperationError(
                result.stderr.decode("utf-8", errors="replace").strip() or "device stderr",
                "stderr",
            )
        payload = _parse_json_result(result.stdout)
        if not payload.get("ok"):
            raise FsOperationError(str(payload.get("error") or "device operation failed"))
        return payload.get("data")

    def stat(self, path: str) -> dict[str, Any] | None:
        """Return stat information for a device path.

        :param path: Device path.
        :return: Stat dictionary or None when missing.
        """
        device_path = _normalize_device_path(path)
        body = (
            "import os\n"
            f"path = {_device_string(device_path)}\n"
            "try:\n"
            "    st = os.stat(path)\n"
            "    mode = int(st[0])\n"
            "    size = int(st[6]) if len(st) > 6 else 0\n"
            "    mtime = int(st[8]) if len(st) > 8 else 0\n"
            "    data = {'exists': True, 'mode': mode, 'size': size, 'mtime': mtime, 'is_dir': bool(mode & 0x4000), 'is_readonly': not bool(mode & 0x80)}\n"
            "except OSError:\n"
            "    data = None\n"
        )
        return self.execute(body)

    def listdir(self, path: str) -> list[dict[str, Any]]:
        """List direct children of a device directory.

        :param path: Device directory.
        :return: Child entries.
        """
        device_path = _normalize_device_path(path)
        body = (
            "import os\n"
            f"root = {_device_string(device_path)}\n"
            "items = []\n"
            "for name in os.listdir(root):\n"
            "    child = ('/' + name) if root == '/' else (root.rstrip('/') + '/' + name)\n"
            "    try:\n"
            "        st = os.stat(child)\n"
            "        mode = int(st[0])\n"
            "        size = int(st[6]) if len(st) > 6 else 0\n"
            "        mtime = int(st[8]) if len(st) > 8 else 0\n"
            "        is_dir = bool(mode & 0x4000)\n"
            "    except OSError:\n"
            "        mode = 0; size = 0; mtime = 0; is_dir = False\n"
            "    items.append({'name': name, 'is_dir': is_dir, 'size': size, 'mtime': mtime, 'mode': mode})\n"
            "data = items\n"
        )
        data = self.execute(body)
        return data if isinstance(data, list) else []

    def tree(self, root: str) -> list[dict[str, Any]]:
        """Return recursive file stats under a device root.

        :param root: Device root path.
        :return: Recursive entries including directories and files.
        """
        device_root = _normalize_device_path(root)
        body = (
            "import os\n"
            f"root = {_device_string(device_root)}\n"
            "items = []\n"
            "def add(path):\n"
            "    try:\n"
            "        st = os.stat(path)\n"
            "    except OSError:\n"
            "        return\n"
            "    mode = int(st[0])\n"
            "    size = int(st[6]) if len(st) > 6 else 0\n"
            "    mtime = int(st[8]) if len(st) > 8 else 0\n"
            "    is_dir = bool(mode & 0x4000)\n"
            "    items.append({'path': path, 'is_dir': is_dir, 'size': size, 'mtime': mtime, 'mode': mode})\n"
            "    if is_dir:\n"
            "        try:\n"
            "            names = os.listdir(path)\n"
            "        except OSError:\n"
            "            return\n"
            "        for name in names:\n"
            "            child = ('/' + name) if path == '/' else (path.rstrip('/') + '/' + name)\n"
            "            add(child)\n"
            "add(root)\n"
            "data = items\n"
        )
        data = self.execute(body)
        return data if isinstance(data, list) else []

    def mkdir(self, path: str, parents: bool = True) -> None:
        """Create a device directory.

        :param path: Device directory.
        :param parents: Whether to create parent directories.
        :return: None
        """
        device_path = _normalize_device_path(path)
        targets = _parent_paths(device_path) + [device_path] if parents else [device_path]
        for target in targets:
            if target == "/":
                continue
            body = (
                "import os\n"
                f"path = {_device_string(target)}\n"
                "try:\n"
                "    os.mkdir(path)\n"
                "except OSError:\n"
                "    pass\n"
                "data = True\n"
            )
            self.execute(body)

    def remove(self, path: str, recursive: bool = True) -> None:
        """Remove a file or directory.

        :param path: Device path.
        :param recursive: Whether to recursively remove directories.
        :return: None
        """
        device_path = _normalize_device_path(path)
        body = (
            "import os\n"
            f"path = {_device_string(device_path)}\n"
            f"recursive = {bool(recursive)!r}\n"
            "def is_dir(p):\n"
            "    return bool(os.stat(p)[0] & 0x4000)\n"
            "def rm(p):\n"
            "    if is_dir(p):\n"
            "        if not recursive:\n"
            "            os.rmdir(p)\n"
            "            return\n"
            "        for name in os.listdir(p):\n"
            "            child = ('/' + name) if p == '/' else (p.rstrip('/') + '/' + name)\n"
            "            rm(child)\n"
            "        if p != '/':\n"
            "            os.rmdir(p)\n"
            "    else:\n"
            "        os.remove(p)\n"
            "rm(path)\n"
            "data = True\n"
        )
        self.execute(body)

    def rename(self, src: str, dst: str) -> None:
        """Rename a device path.

        :param src: Source device path.
        :param dst: Destination device path.
        :return: None
        """
        src_path = _normalize_device_path(src)
        dst_path = _normalize_device_path(dst)
        for parent in _parent_paths(dst_path):
            self.mkdir(parent, parents=False)
        body = (
            "import os\n"
            f"src = {_device_string(src_path)}\n"
            f"dst = {_device_string(dst_path)}\n"
            "os.rename(src, dst)\n"
            "os.stat(dst)\n"
            "data = True\n"
        )
        self.execute(body)

    def write_file(
        self,
        local_path: str,
        device_path: str,
        *,
        chunk_size: int = DEFAULT_CHUNK_SIZE,
        progress: Callable[[dict[str, Any]], None] | None = None,
    ) -> None:
        """Upload one local file to the device.

        :param local_path: Local source file.
        :param device_path: Device destination path.
        :param chunk_size: Raw bytes per chunk.
        :param progress: Optional callback receiving byte-level upload progress.
        :return: None
        """
        source = Path(local_path)
        total_size = source.stat().st_size
        target = _normalize_device_path(device_path)
        temp_target = target + ".mpyupload"
        for parent in _parent_paths(target):
            self.mkdir(parent, parents=False)

        self._emit_write_progress(progress, source, target, 0, total_size)
        if self._supports_stdin_readinto():
            final_size = self._write_file_stdin_base64(
                source,
                target,
                temp_target,
                total_size,
                chunk_size,
                progress,
            )
        else:
            final_size = self._write_file_base64_chunks(
                source,
                target,
                temp_target,
                total_size,
                chunk_size,
                progress,
            )

        if final_size != total_size:
            try:
                self.remove(target, recursive=False)
            except Exception:
                pass
            raise FsOperationError(
                "uploaded size mismatch for %s: expected %d bytes, got %d bytes"
                % (target, total_size, final_size),
                "size_mismatch",
            )
        self._emit_write_progress(progress, source, target, total_size, total_size, done=True)

    def _write_file_base64_chunks(
        self,
        source: Path,
        target: str,
        temp_target: str,
        total_size: int,
        chunk_size: int,
        progress: Callable[[dict[str, Any]], None] | None,
    ) -> int:
        """Upload a file using the legacy per-chunk raw REPL path."""
        bytes_written = 0
        try:
            self._start_write(temp_target)
            with source.open("rb") as handle:
                while True:
                    chunk = handle.read(chunk_size)
                    if not chunk:
                        break
                    encoded = base64.b64encode(chunk).decode("ascii")
                    written = self._append_write_chunk(temp_target, encoded)
                    if written != len(chunk):
                        raise FsOperationError(
                            "device wrote %d of %d bytes to %s" % (written, len(chunk), target),
                            "short_write",
                        )
                    bytes_written += written
                    self._emit_write_progress(progress, source, target, bytes_written, total_size)
            return self._finish_write(temp_target, target)
        except Exception:
            try:
                self._discard_write_temp(temp_target)
            except Exception:
                pass
            raise

    def _write_file_stdin_base64(
        self,
        source: Path,
        target: str,
        temp_target: str,
        total_size: int,
        chunk_size: int,
        progress: Callable[[dict[str, Any]], None] | None,
    ) -> int:
        """Upload a file through one stdin-reading receiver program.

        The stream is base64 encoded even though stdin is binary-capable. Raw
        binary data can contain Ctrl-C/Ctrl-D bytes, which MicroPython's REPL
        may treat as control input before user code sees them.
        """
        raw_chunk_size = max(STDIN_UPLOAD_MIN_CHUNK_SIZE, int(chunk_size))
        raw_chunk_size -= raw_chunk_size % 3
        raw_chunk_size = max(STDIN_UPLOAD_MIN_CHUNK_SIZE, raw_chunk_size)
        encoded_total = ((int(total_size) + 2) // 3) * 4
        receiver_started = False
        receiver_finished = False
        bytes_sent = 0

        try:
            self._transport.exec_raw_no_follow(
                _wrap_device_code(
                    self._stdin_base64_receiver_code(
                        temp_target,
                        target,
                        total_size,
                        encoded_total,
                        ((raw_chunk_size + 2) // 3) * 4,
                    )
                ).encode("utf-8")
            )
            receiver_started = True
            with source.open("rb") as handle:
                while True:
                    chunk = handle.read(raw_chunk_size)
                    if not chunk:
                        break
                    encoded = base64.b64encode(chunk)
                    written = self._transport.write_bytes(encoded)
                    if written != len(encoded):
                        raise FsOperationError(
                            "host wrote %d of %d encoded bytes for %s"
                            % (written, len(encoded), target),
                            "short_write",
                        )
                    bytes_sent += len(chunk)
                    self._emit_write_progress(progress, source, target, bytes_sent, total_size)
            self._transport.flush_output()
            result = self._transport.follow(self._timeout)
            receiver_finished = True
            if result.stderr:
                raise FsOperationError(
                    result.stderr.decode("utf-8", errors="replace").strip() or "device stderr",
                    "stderr",
                )
            payload = _parse_json_result(result.stdout)
            if not payload.get("ok"):
                raise FsOperationError(str(payload.get("error") or "device operation failed"))
            return int(payload.get("data") or 0)
        except Exception:
            if receiver_started and not receiver_finished:
                try:
                    self._transport.interrupt()
                    self._transport.follow(1.0)
                except Exception:
                    pass
            try:
                self.remove(temp_target, recursive=False)
            except Exception:
                pass
            raise

    def _supports_stdin_readinto(self) -> bool:
        """Return whether this device can receive streamed stdin bytes."""
        if self._stdin_readinto_supported is not None:
            return self._stdin_readinto_supported
        if not hasattr(self._transport, "write_bytes"):
            self._stdin_readinto_supported = False
            return False
        try:
            supported = bool(
                self.execute(
                    "import sys\n"
                    "stream = getattr(sys.stdin, 'buffer', sys.stdin)\n"
                    "data = bool(getattr(stream, 'readinto', None))\n"
                )
            )
        except Exception:
            supported = False
        self._stdin_readinto_supported = supported
        return supported

    def _stdin_base64_receiver_code(
        self,
        temp_path: str,
        target_path: str,
        total_size: int,
        encoded_total: int,
        encoded_chunk_size: int,
    ) -> str:
        """Build device-side code for the stdin base64 upload receiver."""
        return (
            "import binascii, os, sys\n"
            f"tmp = {_device_string(temp_path)}\n"
            f"target = {_device_string(target_path)}\n"
            f"total = {int(total_size)}\n"
            f"encoded_remaining = {int(encoded_total)}\n"
            f"buffer_size = {max(4, int(encoded_chunk_size))}\n"
            "stream = getattr(sys.stdin, 'buffer', sys.stdin)\n"
            "readinto = getattr(stream, 'readinto', None)\n"
            "if readinto is None:\n"
            "    raise OSError('stdin readinto is not available')\n"
            "f = None\n"
            "ok = False\n"
            "written_total = 0\n"
            "pending = bytearray()\n"
            "try:\n"
            "    try:\n"
            "        os.remove(tmp)\n"
            "    except OSError:\n"
            "        pass\n"
            "    f = open(tmp, 'wb')\n"
            "    buf = bytearray(buffer_size)\n"
            "    mv = memoryview(buf)\n"
            "    while encoded_remaining:\n"
            "        want = min(encoded_remaining, buffer_size)\n"
            "        got = readinto(mv[:want])\n"
            "        if got is None:\n"
            "            got = 0\n"
            "        if got <= 0:\n"
            "            raise OSError('stdin upload ended early')\n"
            "        encoded_remaining -= got\n"
            "        pending.extend(mv[:got])\n"
            "        ready = (len(pending) // 4) * 4\n"
            "        if ready:\n"
            "            decoded = binascii.a2b_base64(pending[:ready])\n"
            "            pending = pending[ready:]\n"
            "            if decoded:\n"
            "                offset = 0\n"
            "                while offset < len(decoded):\n"
            "                    count = f.write(decoded[offset:])\n"
            "                    if count is None:\n"
            "                        count = len(decoded) - offset\n"
            "                    if count <= 0:\n"
            "                        raise OSError('file write returned no bytes')\n"
            "                    offset += count\n"
            "                written_total += len(decoded)\n"
            "                if written_total > total:\n"
            "                    raise OSError('decoded more bytes than expected')\n"
            "    if pending:\n"
            "        raise OSError('incomplete base64 upload stream')\n"
            "    if written_total != total:\n"
            "        raise OSError('uploaded size mismatch')\n"
            "    f.close()\n"
            "    f = None\n"
            "    try:\n"
            "        os.remove(target)\n"
            "    except OSError:\n"
            "        pass\n"
            "    os.rename(tmp, target)\n"
            "    st = os.stat(target)\n"
            "    data = int(st[6]) if len(st) > 6 else 0\n"
            "    ok = True\n"
            "finally:\n"
            "    if f is not None:\n"
            "        try:\n"
            "            f.close()\n"
            "        except Exception:\n"
            "            pass\n"
            "    if not ok:\n"
            "        try:\n"
            "            os.remove(tmp)\n"
            "        except OSError:\n"
            "            pass\n"
        )

    def _emit_write_progress(
        self,
        progress: Callable[[dict[str, Any]], None] | None,
        source: Path,
        target: str,
        bytes_written: int,
        total_size: int,
        *,
        done: bool = False,
    ) -> None:
        if progress is None:
            return
        progress(
            {
                "op": "write_file",
                "path": target,
                "local_path": str(source),
                "bytes": int(bytes_written),
                "total": int(total_size),
                "done": bool(done),
            }
        )

    def _emit_read_progress(
        self,
        progress: Callable[[dict[str, Any]], None] | None,
        source: str,
        target: Path,
        bytes_read: int,
        total_size: int,
        *,
        done: bool = False,
    ) -> None:
        if progress is None:
            return
        progress(
            {
                "op": "read_file",
                "path": source,
                "local_path": str(target),
                "bytes": int(bytes_read),
                "total": int(total_size),
                "done": bool(done),
            }
        )

    def _start_write(self, temp_path: str) -> None:
        body = (
            "import os\n"
            f"path = {_device_string(temp_path)}\n"
            f"old = globals().get({_device_string(UPLOAD_HANDLE_VAR)})\n"
            "if old is not None:\n"
            "    try:\n"
            "        old.close()\n"
            "    except Exception:\n"
            "        pass\n"
            f"globals()[{_device_string(UPLOAD_HANDLE_VAR)}] = None\n"
            f"globals()[{_device_string(UPLOAD_PATH_VAR)}] = path\n"
            "try:\n"
            "    os.remove(path)\n"
            "except OSError:\n"
            "    pass\n"
            f"globals()[{_device_string(UPLOAD_HANDLE_VAR)}] = open(path, 'wb')\n"
            "data = True\n"
        )
        self.execute(body)

    def _append_write_chunk(self, temp_path: str, encoded: str) -> int:
        body = (
            "import binascii\n"
            f"path = {_device_string(temp_path)}\n"
            f"encoded = {_device_string(encoded)}\n"
            "chunk = binascii.a2b_base64(encoded)\n"
            f"f = globals().get({_device_string(UPLOAD_HANDLE_VAR)})\n"
            f"current_path = globals().get({_device_string(UPLOAD_PATH_VAR)})\n"
            "if f is None or current_path != path:\n"
            "    raise OSError('upload file is not open')\n"
            "written = f.write(chunk)\n"
            "data = len(chunk) if written is None else written\n"
        )
        return int(self.execute(body) or 0)

    def _discard_write_temp(self, temp_path: str) -> None:
        body = (
            "import os\n"
            f"path = {_device_string(temp_path)}\n"
            f"f = globals().get({_device_string(UPLOAD_HANDLE_VAR)})\n"
            "if f is not None:\n"
            "    try:\n"
            "        f.close()\n"
            "    except Exception:\n"
            "        pass\n"
            f"globals()[{_device_string(UPLOAD_HANDLE_VAR)}] = None\n"
            f"globals()[{_device_string(UPLOAD_PATH_VAR)}] = None\n"
            "try:\n"
            "    os.remove(path)\n"
            "except OSError:\n"
            "    pass\n"
            "data = True\n"
        )
        self.execute(body)

    def _finish_write(self, temp_path: str, target_path: str) -> int:
        body = (
            "import os\n"
            f"tmp = {_device_string(temp_path)}\n"
            f"target = {_device_string(target_path)}\n"
            f"f = globals().get({_device_string(UPLOAD_HANDLE_VAR)})\n"
            f"current_path = globals().get({_device_string(UPLOAD_PATH_VAR)})\n"
            "if f is None or current_path != tmp:\n"
            "    raise OSError('upload file is not open')\n"
            "try:\n"
            "    f.close()\n"
            "finally:\n"
            f"    globals()[{_device_string(UPLOAD_HANDLE_VAR)}] = None\n"
            f"    globals()[{_device_string(UPLOAD_PATH_VAR)}] = None\n"
            "try:\n"
            "    os.remove(target)\n"
            "except OSError:\n"
            "    pass\n"
            "os.rename(tmp, target)\n"
            "st = os.stat(target)\n"
            "data = int(st[6]) if len(st) > 6 else 0\n"
        )
        return int(self.execute(body) or 0)

    def read_file(
        self,
        device_path: str,
        local_path: str,
        *,
        chunk_size: int = DEFAULT_CHUNK_SIZE,
        progress: Callable[[dict[str, Any]], None] | None = None,
    ) -> None:
        """Download one device file to a local path.

        :param device_path: Device source path.
        :param local_path: Local destination path.
        :param chunk_size: Bytes per chunk.
        :param progress: Optional callback receiving byte-level download progress.
        :return: None
        """
        source = _normalize_device_path(device_path)
        target = Path(local_path)
        target.parent.mkdir(parents=True, exist_ok=True)
        temp_target = target.with_name(target.name + ".mpydownload")
        info = self.stat(source)
        if info is None:
            raise FsOperationError("file not found: %s" % source, "not_found")
        size = int(info.get("size") or 0)
        try:
            self._read_file_stdout_base64(source, target, temp_target, size, chunk_size, progress)
            os.replace(temp_target, target)
            self._emit_read_progress(progress, source, target, size, size, done=True)
        except Exception:
            try:
                temp_target.unlink()
            except Exception:
                pass
            raise

    def _read_file_stdout_base64(
        self,
        source: str,
        target: Path,
        temp_target: Path,
        size: int,
        chunk_size: int,
        progress: Callable[[dict[str, Any]], None] | None,
    ) -> None:
        offset = 0
        pending = b""
        started = False
        completed = False
        device_error = ""
        saw_consumer_data = False

        def parse_marker(line: bytes, marker: str) -> dict[str, Any]:
            text = line.decode("utf-8", errors="replace")
            try:
                payload = json.loads(text[len(marker) :])
            except json.JSONDecodeError as exc:
                raise FsOperationError("invalid download stream marker: %s" % exc, "bad_json")
            return payload if isinstance(payload, dict) else {}

        def process_line(raw_line: bytes, handle) -> None:
            nonlocal started, completed, device_error, offset
            line = raw_line.strip()
            if not line:
                return
            if line.startswith(DOWNLOAD_START_MARKER.encode("ascii")):
                payload = parse_marker(line, DOWNLOAD_START_MARKER)
                expected = int(payload.get("size") or 0)
                if expected != size:
                    raise FsOperationError(
                        "downloaded size mismatch for %s: expected %d bytes, device reported %d bytes"
                        % (source, size, expected),
                        "size_mismatch",
                    )
                started = True
                return
            if line.startswith(DOWNLOAD_END_MARKER.encode("ascii")):
                payload = parse_marker(line, DOWNLOAD_END_MARKER)
                reported = int(payload.get("bytes") or 0)
                if reported != offset:
                    raise FsOperationError(
                        "downloaded size mismatch for %s: host read %d bytes, device reported %d bytes"
                        % (source, offset, reported),
                        "size_mismatch",
                    )
                completed = True
                return
            if line.startswith(DOWNLOAD_ERROR_MARKER.encode("ascii")):
                payload = parse_marker(line, DOWNLOAD_ERROR_MARKER)
                device_error = str(payload.get("error") or "device download failed")
                return
            if not started:
                raise FsOperationError("download stream start marker not found for %s" % source, "bad_response")
            if completed:
                return
            try:
                chunk = base64.b64decode(line)
            except Exception as exc:
                raise FsOperationError("invalid download data for %s: %s" % (source, exc), "bad_response")
            handle.write(chunk)
            offset += len(chunk)
            self._emit_read_progress(progress, source, target, offset, size)

        def consume_stdout(data: bytes, handle) -> None:
            nonlocal pending, saw_consumer_data
            if not data:
                return
            saw_consumer_data = True
            pending += data.replace(b"\x04", b"")
            while b"\n" in pending:
                line, pending = pending.split(b"\n", 1)
                process_line(line, handle)

        self._emit_read_progress(progress, source, target, 0, size)
        with temp_target.open("wb") as handle:
            result = self._transport.exec_raw(
                self._stdout_base64_sender_code(source, size, chunk_size),
                timeout=self._timeout,
                stdout_consumer=lambda data: consume_stdout(data, handle),
            )
            if not saw_consumer_data and result.stdout:
                consume_stdout(result.stdout, handle)
            consume_stdout(b"\n", handle)
            if result.stderr:
                raise FsOperationError(
                    result.stderr.decode("utf-8", errors="replace").strip() or "device stderr",
                    "stderr",
                )
            if device_error:
                raise FsOperationError(device_error)
            if not started:
                raise FsOperationError("download stream start marker not found for %s" % source, "bad_response")
            if not completed:
                raise FsOperationError("download stream end marker not found for %s" % source, "bad_response")
            if offset != size:
                raise FsOperationError(
                    "downloaded size mismatch for %s: expected %d bytes, got %d bytes"
                    % (source, size, offset),
                    "size_mismatch",
                )

    def _stdout_base64_sender_code(self, source: str, size: int, chunk_size: int) -> str:
        return (
            "try:\n"
            "    import ujson as json\n"
            "except ImportError:\n"
            "    import json\n"
            "import binascii, sys\n"
            f"path = {_device_string(source)}\n"
            f"total = {int(size)}\n"
            f"chunk_size = {max(1, int(chunk_size))}\n"
            f"start_marker = {DOWNLOAD_START_MARKER!r}\n"
            f"end_marker = {DOWNLOAD_END_MARKER!r}\n"
            f"error_marker = {DOWNLOAD_ERROR_MARKER!r}\n"
            "def emit(marker, payload):\n"
            "    sys.stdout.write(marker + json.dumps(payload) + '\\n')\n"
            "def write_bytes(data):\n"
            "    stream = getattr(sys.stdout, 'buffer', None)\n"
            "    if stream is not None:\n"
            "        stream.write(data)\n"
            "    else:\n"
            "        sys.stdout.write(data.decode())\n"
            "f = None\n"
            "sent = 0\n"
            "try:\n"
            "    emit(start_marker, {'size': total})\n"
            "    f = open(path, 'rb')\n"
            "    while True:\n"
            "        chunk = f.read(chunk_size)\n"
            "        if not chunk:\n"
            "            break\n"
            "        encoded = binascii.b2a_base64(chunk)\n"
            "        if encoded[-1:] != b'\\n':\n"
            "            encoded += b'\\n'\n"
            "        write_bytes(encoded)\n"
            "        sent += len(chunk)\n"
            "    f.close()\n"
            "    f = None\n"
            "    if sent != total:\n"
            "        raise OSError('downloaded size mismatch')\n"
            "    emit(end_marker, {'bytes': sent})\n"
            "except Exception as exc:\n"
            "    if f is not None:\n"
            "        try:\n"
            "            f.close()\n"
            "        except Exception:\n"
            "            pass\n"
            "    try:\n"
            "        emit(error_marker, {'error': repr(exc)})\n"
            "    except Exception:\n"
            "        pass\n"
        )

    def _read_chunk(self, device_path: str, offset: int, size: int) -> str:
        body = (
            "import binascii\n"
            f"path = {_device_string(device_path)}\n"
            f"offset = {int(offset)}\n"
            f"size = {int(size)}\n"
            "f = open(path, 'rb')\n"
            "try:\n"
            "    f.seek(offset)\n"
            "    chunk = f.read(size)\n"
            "finally:\n"
            "    f.close()\n"
            "data = binascii.b2a_base64(chunk).decode().strip()\n"
        )
        data = self.execute(body)
        return str(data or "")

    def exec_json(self, source: str) -> Any:
        """Execute user-supplied source and return raw stdout/stderr as text.

        :param source: Python source.
        :return: Execution result dictionary.
        """
        result = self._transport.exec_raw(source, timeout=self._timeout)
        return {
            "stdout": result.stdout.decode("utf-8", errors="replace"),
            "stderr": result.stderr.decode("utf-8", errors="replace"),
        }


def list_serial_ports() -> list[dict[str, str]]:
    """List host serial ports using pyserial.

    :return: Serial port dictionaries.
    """
    from serial.tools import list_ports

    ports = []
    for port in list_ports.comports():
        ports.append(
            {
                "port": str(port.device),
                "name": str(port.description or port.manufacturer or "Serial Port"),
            }
        )
    return ports


def run_fs_operation(client: DeviceFsClient, op: str, payload: dict[str, Any]) -> Any:
    """Dispatch one filesystem operation.

    :param client: Open filesystem client.
    :param op: Operation name.
    :param payload: Operation payload.
    :return: Operation result.
    """
    if op == "stat":
        return client.stat(str(payload.get("path") or "/"))
    if op == "listdir":
        return client.listdir(str(payload.get("path") or "/"))
    if op == "tree":
        return client.tree(str(payload.get("path") or payload.get("root") or "/"))
    if op == "mkdir":
        client.mkdir(str(payload.get("path") or "/"), parents=bool(payload.get("parents", True)))
        return True
    if op == "remove":
        client.remove(str(payload.get("path") or "/"), recursive=bool(payload.get("recursive", True)))
        return True
    if op == "rename":
        client.rename(str(payload.get("src") or ""), str(payload.get("dst") or ""))
        return True
    if op == "write_file":
        progress_callback = payload.get("progress_callback")
        client.write_file(
            str(payload.get("local_path") or ""),
            str(payload.get("path") or ""),
            progress=progress_callback if callable(progress_callback) else None,
        )
        return True
    if op == "read_file":
        progress_callback = payload.get("progress_callback")
        client.read_file(
            str(payload.get("path") or ""),
            str(payload.get("local_path") or ""),
            progress=progress_callback if callable(progress_callback) else None,
        )
        return True
    if op == "exec":
        return client.exec_json(str(payload.get("source") or ""))
    raise FsOperationError("unsupported filesystem operation: %s" % op, "unsupported")


def response_payload(request_id: str, ok: bool, data: Any = None, error: str = "", code: str = "") -> dict[str, Any]:
    """Build a response payload for JSON control/CLI callers.

    :param request_id: Request identifier.
    :param ok: Success flag.
    :param data: Response data.
    :param error: Error message.
    :param code: Error code.
    :return: Response dictionary.
    """
    result = {"request_id": request_id, "ok": ok}
    if ok:
        result["data"] = data
    else:
        result["error"] = error
        result["code"] = code or "error"
    return result
