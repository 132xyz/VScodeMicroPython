"""Standard-library CLI client for an extension-owned serial manager."""

from __future__ import annotations

import argparse
import itertools
import json
import os
import socket
import sys
import time
import uuid
from pathlib import Path
from typing import Any, Callable, Sequence

from mpyrepl.manager.protocol import PROTOCOL_VERSION, decode_json_line, encode_json_line


DESCRIPTOR_SCHEMA_VERSION = 1
DESCRIPTOR_NAME = "serial-manager.json"
WORKBENCH_DIR = ".mpy-workbench"
SESSION_ENV = "MPY_MANAGER_SESSION"

EXIT_OK = 0
EXIT_USAGE = 2
EXIT_DISCOVERY = 3
EXIT_BUSY = 4
EXIT_TIMEOUT = 5
EXIT_TRANSPORT = 6
EXIT_DEVICE = 7
EXIT_RPC = 8


class AgentCliError(RuntimeError):
    """A stable command-line error with an exit code and optional details."""

    def __init__(self, code: str, message: str, exit_code: int, details: Any = None) -> None:
        super().__init__(message)
        self.code = code
        self.exit_code = exit_code
        self.details = details


class ManagerRequestError(RuntimeError):
    """Structured error returned by the hidden manager."""

    def __init__(self, code: str, message: str, details: Any = None) -> None:
        super().__init__(message)
        self.code = code or "rpc_error"
        self.details = details


class AgentArgumentParser(argparse.ArgumentParser):
    """Argument parser that reports usage failures through the JSON contract."""

    def error(self, message: str) -> None:
        raise AgentCliError("usage", message, EXIT_USAGE)


class AgentManagerClient:
    """Small blocking NDJSON client that does not import REPL/TUI modules."""

    def __init__(
        self,
        host: str,
        port: int,
        token: str,
        *,
        progress: bool = False,
    ) -> None:
        self._host = host
        self._port = port
        self._token = token
        self._progress = progress
        self._counter = itertools.count(1)
        self._socket: socket.socket | None = None
        self._reader = None

    def connect(self, timeout: float = 5.0) -> None:
        if self._socket is not None:
            return
        sock = socket.create_connection((self._host, self._port), timeout=timeout)
        sock.settimeout(None)
        self._socket = sock
        self._reader = sock.makefile("rb")

    def close(self) -> None:
        reader = self._reader
        sock = self._socket
        self._reader = None
        self._socket = None
        if reader is not None:
            try:
                reader.close()
            except Exception:
                pass
        if sock is not None:
            try:
                sock.close()
            except Exception:
                pass

    def call(self, method: str, params: dict[str, Any] | None = None, timeout: float = 30.0) -> Any:
        self.connect()
        request_id = "agent-%s-%s-%s" % (os.getpid(), next(self._counter), uuid.uuid4().hex[:8])
        payload = {
            "id": request_id,
            "token": self._token,
            "method": method,
            "params": params or {},
        }
        sock = self._socket
        if sock is None:
            raise RuntimeError("manager client is not connected")
        sock.settimeout(timeout if timeout > 0 else None)
        try:
            sock.sendall(encode_json_line(payload).encode("utf-8"))
            while True:
                message = self._read_message()
                if "event" in message:
                    self._handle_event(message, request_id)
                    continue
                if str(message.get("id")) != request_id:
                    continue
                if not message.get("ok"):
                    error = message.get("error") if isinstance(message.get("error"), dict) else {}
                    raise ManagerRequestError(
                        str(error.get("code") or "rpc_error"),
                        str(error.get("message") or "manager request failed"),
                        error.get("details"),
                    )
                return message.get("result")
        finally:
            if self._socket is sock:
                sock.settimeout(None)

    def _read_message(self) -> dict[str, Any]:
        if self._reader is None:
            raise RuntimeError("manager client is not connected")
        line = self._reader.readline()
        if not line:
            raise RuntimeError("manager connection closed")
        return decode_json_line(line)

    def _handle_event(self, message: dict[str, Any], request_id: str) -> None:
        if not self._progress or message.get("event") != "progress":
            return
        payload = message.get("payload") if isinstance(message.get("payload"), dict) else {}
        if str(payload.get("operationId") or "") != request_id:
            return
        sys.stderr.write(json.dumps({"event": "progress", "payload": payload}, ensure_ascii=False) + "\n")
        sys.stderr.flush()


def build_agent_parser() -> argparse.ArgumentParser:
    parser = AgentArgumentParser(description="Attach to the MicroPython WorkBench serial manager")
    parser.add_argument("--session", default="", help="Path to serial-manager.json")
    parser.add_argument("--workspace", default="", help="Workspace root containing .mpy-workbench")
    parser.add_argument("--busy", choices=("wait", "reject"), default="wait")
    parser.add_argument("--queue-timeout", type=float, default=30.0, help="Busy queue timeout in seconds")
    parser.add_argument("--timeout", type=float, default=120.0, help="Started operation timeout in seconds")
    parser.add_argument("--progress", action="store_true", help="Write matching transfer progress JSONL to stderr")
    commands = parser.add_subparsers(dest="agent_command", required=True)

    commands.add_parser("status", help="Show manager and device status")
    wait_parser = commands.add_parser("wait-idle", help="Wait until the serial manager is idle")
    wait_parser.add_argument("--idle-timeout", type=float, default=30.0)

    exec_parser = commands.add_parser("exec", help="Execute MicroPython source")
    exec_parser.add_argument("--code", required=True)
    exec_file_parser = commands.add_parser("exec-file", help="Execute a local Python file")
    exec_file_parser.add_argument("local_path")

    for name in ("ls", "tree", "stat"):
        command = commands.add_parser(name)
        command.add_argument("device_path", nargs="?", default="/")

    get_parser = commands.add_parser("get", help="Download one device file")
    get_parser.add_argument("device_path")
    get_parser.add_argument("local_path")
    put_parser = commands.add_parser("put", help="Upload one local file")
    put_parser.add_argument("local_path")
    put_parser.add_argument("device_path")

    mkdir_parser = commands.add_parser("mkdir")
    mkdir_parser.add_argument("device_path")
    mkdir_parser.add_argument("--no-parents", action="store_true")
    rm_parser = commands.add_parser("rm")
    rm_parser.add_argument("device_path")
    rm_parser.add_argument("--recursive", action="store_true")
    rm_parser.add_argument("--yes", action="store_true")
    mv_parser = commands.add_parser("mv")
    mv_parser.add_argument("source_path")
    mv_parser.add_argument("target_path")

    commands.add_parser("interrupt")
    commands.add_parser("soft-reset")
    return parser


def discover_session_file(session: str = "", workspace: str = "", cwd: Path | None = None) -> Path:
    """Resolve the active workspace descriptor without probing ports."""
    if session:
        return Path(session).expanduser().resolve()
    from_env = os.environ.get(SESSION_ENV, "").strip()
    if from_env:
        return Path(from_env).expanduser().resolve()
    if workspace:
        return (Path(workspace).expanduser().resolve() / WORKBENCH_DIR / DESCRIPTOR_NAME)

    current = (cwd or Path.cwd()).resolve()
    for directory in (current, *current.parents):
        candidate = directory / WORKBENCH_DIR / DESCRIPTOR_NAME
        if candidate.is_file():
            return candidate
    raise AgentCliError(
        "manager_not_found",
        "no active serial manager descriptor was found",
        EXIT_DISCOVERY,
    )


def load_session_descriptor(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise AgentCliError("manager_not_found", "session descriptor does not exist: %s" % path, EXIT_DISCOVERY) from exc
    except (OSError, json.JSONDecodeError) as exc:
        raise AgentCliError("invalid_session", "failed to read session descriptor: %s" % exc, EXIT_DISCOVERY) from exc
    if not isinstance(payload, dict):
        raise AgentCliError("invalid_session", "session descriptor must be a JSON object", EXIT_DISCOVERY)
    if payload.get("schemaVersion") != DESCRIPTOR_SCHEMA_VERSION:
        raise AgentCliError("schema_mismatch", "unsupported session descriptor schema", EXIT_DISCOVERY)
    if payload.get("protocolVersion") != PROTOCOL_VERSION:
        raise AgentCliError("protocol_mismatch", "session descriptor protocol does not match this CLI", EXIT_DISCOVERY)
    host = payload.get("host")
    port = payload.get("port")
    token = payload.get("token")
    if host not in {"127.0.0.1", "localhost", "::1"}:
        raise AgentCliError("invalid_session", "manager host must be loopback", EXIT_DISCOVERY)
    if not isinstance(port, int) or not 0 < port <= 65535 or not isinstance(token, str) or not token:
        raise AgentCliError("invalid_session", "session descriptor endpoint is invalid", EXIT_DISCOVERY)
    return payload


def _queue_params(args: argparse.Namespace) -> dict[str, Any]:
    if args.queue_timeout < 0:
        raise AgentCliError("usage", "--queue-timeout must be non-negative", EXIT_USAGE)
    if args.timeout <= 0:
        raise AgentCliError("usage", "--timeout must be greater than zero", EXIT_USAGE)
    return {
        "queuePolicy": args.busy,
        "queueTimeoutMs": int(args.queue_timeout * 1000),
    }


def _rpc_timeout(args: argparse.Namespace) -> float:
    return max(5.0, args.queue_timeout + args.timeout + 5.0)


def execute_agent_command(client: AgentManagerClient, args: argparse.Namespace) -> Any:
    command = args.agent_command
    if command == "status":
        return client.call("manager.status", timeout=5.0)
    if command == "wait-idle":
        return _wait_idle(client, args.idle_timeout)
    if command == "interrupt":
        return client.call("device.interrupt", timeout=5.0)

    params = _queue_params(args)
    timeout = _rpc_timeout(args)
    if command == "soft-reset":
        return client.call("device.softReset", params, timeout=timeout)
    if command in {"exec", "exec-file"}:
        source = args.code if command == "exec" else _read_source_file(args.local_path)
        params.update({"source": source, "instrument": False, "followTimeout": args.timeout})
        return client.call("repl.exec", params, timeout=timeout)
    if command in {"ls", "tree", "stat"}:
        return client.call("fs." + ("listdir" if command == "ls" else command), {**params, "path": args.device_path}, timeout=timeout)
    if command == "get":
        local_path = str(Path(args.local_path).expanduser().resolve())
        return client.call("fs.readFile", {**params, "devicePath": args.device_path, "localPath": local_path}, timeout=timeout)
    if command == "put":
        local_path = Path(args.local_path).expanduser().resolve()
        if not local_path.is_file():
            raise AgentCliError("local_file_not_found", "local file does not exist: %s" % local_path, EXIT_USAGE)
        return client.call("fs.writeFile", {**params, "devicePath": args.device_path, "localPath": str(local_path)}, timeout=timeout)
    if command == "mkdir":
        return client.call("fs.mkdir", {**params, "path": args.device_path, "parents": not args.no_parents}, timeout=timeout)
    if command == "rm":
        if not args.yes:
            raise AgentCliError("confirmation_required", "rm requires --yes", EXIT_USAGE)
        return client.call("fs.remove", {**params, "path": args.device_path, "recursive": args.recursive}, timeout=timeout)
    if command == "mv":
        return client.call("fs.rename", {**params, "src": args.source_path, "dst": args.target_path}, timeout=timeout)
    raise AgentCliError("usage", "unsupported agent command: %s" % command, EXIT_USAGE)


def _read_source_file(local_path: str) -> str:
    try:
        return Path(local_path).expanduser().read_text(encoding="utf-8-sig")
    except (OSError, UnicodeError) as exc:
        raise AgentCliError("local_file_error", "failed to read source file: %s" % exc, EXIT_USAGE) from exc


def _wait_idle(client: AgentManagerClient, timeout: float) -> dict[str, Any]:
    if timeout < 0:
        raise AgentCliError("usage", "--idle-timeout must be non-negative", EXIT_USAGE)
    deadline = time.monotonic() + timeout
    while True:
        status = client.call("manager.status", timeout=5.0)
        if isinstance(status, dict) and not status.get("busy") and not status.get("queuedOperationCount"):
            return status
        if time.monotonic() >= deadline:
            raise AgentCliError("queue_timeout", "timed out waiting for the serial manager to become idle", EXIT_TIMEOUT)
        time.sleep(0.1)


def _exit_for_rpc(code: str) -> int:
    if code == "busy":
        return EXIT_BUSY
    if code in {"queue_timeout", "timeout"}:
        return EXIT_TIMEOUT
    if code in {"transport", "transport_lost", "not_ready"}:
        return EXIT_TRANSPORT
    if code in {"device", "device_error", "not_found", "exists"}:
        return EXIT_DEVICE
    return EXIT_RPC


def run_agent(args: argparse.Namespace, client_factory: Callable[..., AgentManagerClient] = AgentManagerClient) -> tuple[int, dict[str, Any]]:
    session_path = discover_session_file(args.session, args.workspace)
    descriptor = load_session_descriptor(session_path)
    client = client_factory(
        str(descriptor["host"]),
        int(descriptor["port"]),
        str(descriptor["token"]),
        progress=bool(args.progress),
    )
    try:
        hello = client.call("manager.hello", {"role": "agent"}, timeout=5.0)
        if not isinstance(hello, dict) or hello.get("protocolVersion") != PROTOCOL_VERSION:
            raise AgentCliError("protocol_mismatch", "manager protocol does not match this CLI", EXIT_DISCOVERY)
        expected_instance = descriptor.get("managerInstanceId")
        if expected_instance and hello.get("managerInstanceId") != expected_instance:
            raise AgentCliError("stale_session", "session descriptor belongs to another manager instance", EXIT_DISCOVERY)
        result = execute_agent_command(client, args)
        if args.agent_command in {"exec", "exec-file"} and isinstance(result, dict) and result.get("stderr"):
            return EXIT_DEVICE, {
                "ok": False,
                "error": {"code": "device_error", "message": "device execution failed"},
                "result": result,
            }
        return EXIT_OK, {"ok": True, "result": result}
    finally:
        client.close()


def main(argv: Sequence[str] | None = None) -> int:
    try:
        args = build_agent_parser().parse_args(argv)
        exit_code, payload = run_agent(args)
    except AgentCliError as exc:
        exit_code = exc.exit_code
        error: dict[str, Any] = {"code": exc.code, "message": str(exc)}
        if exc.details is not None:
            error["details"] = exc.details
        payload = {"ok": False, "error": error}
    except ManagerRequestError as exc:
        exit_code = _exit_for_rpc(exc.code)
        error = {"code": exc.code, "message": str(exc)}
        if exc.details is not None:
            error["details"] = exc.details
        payload = {"ok": False, "error": error}
    except (TimeoutError, socket.timeout) as exc:
        exit_code = EXIT_TIMEOUT
        payload = {"ok": False, "error": {"code": "timeout", "message": str(exc) or "manager request timed out"}}
    except (ConnectionError, OSError, RuntimeError) as exc:
        exit_code = EXIT_TRANSPORT
        payload = {"ok": False, "error": {"code": "manager_unavailable", "message": str(exc)}}
    except KeyboardInterrupt:
        exit_code = 130
        payload = {"ok": False, "error": {"code": "interrupted", "message": "agent command interrupted"}}
    print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
