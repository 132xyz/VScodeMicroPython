"""Async NDJSON RPC server for the hidden serial manager.

:return: None
"""

from __future__ import annotations

import asyncio
import secrets
import sys
from typing import Any, Awaitable, Callable, TextIO

from mpyrepl.manager.protocol import (
    DEFAULT_HOST,
    ERROR_AUTH,
    ERROR_INTERNAL,
    ERROR_PROTOCOL,
    PROTOCOL_VERSION,
    RpcMethodError,
    RpcProtocolError,
    error_response_line,
    event_line,
    parse_request,
    ready_line,
    response_line,
)
from mpyrepl.manager.session import ManagerSession
from mpyrepl.runtime.models import ReplConfig


FS_METHODS = {
    "fs.stat": "stat",
    "fs.listdir": "listdir",
    "fs.tree": "tree",
    "fs.mkdir": "mkdir",
    "fs.remove": "remove",
    "fs.rename": "rename",
    "fs.readFile": "read_file",
    "fs.writeFile": "write_file",
    "fs.exec": "exec",
}

CLIENT_ROLES = {"extension", "repl", "agent"}


class ManagerServer:
    """Serve manager RPC requests for one active serial session.

    :param token: Authentication token.
    :param host: Bind host.
    :param port: Bind port, or zero for OS-assigned.
    :return: None
    """

    def __init__(self, token: str, host: str = DEFAULT_HOST, port: int = 0) -> None:
        """Initialize server state without opening sockets.

        :param token: Authentication token.
        :param host: Bind host.
        :param port: Bind port, or zero for OS-assigned.
        :return: None
        """
        self._token = token
        self._instance_id = secrets.token_hex(16)
        self._host = host
        self._port = port
        self._server: asyncio.AbstractServer | None = None
        self._session: ManagerSession | None = None
        self._clients: set[asyncio.StreamWriter] = set()
        self._client_roles: dict[asyncio.StreamWriter, str] = {}
        self._client_readers: dict[asyncio.StreamWriter, asyncio.StreamReader] = {}
        self._operation_lock = asyncio.Lock()
        self._queued_operations = 0
        self._shutdown_event = asyncio.Event()
        self._loop: asyncio.AbstractEventLoop | None = None

    @property
    def host(self) -> str:
        """Return the bound host.

        :return: Host string.
        """
        return self._host

    @property
    def port(self) -> int:
        """Return the bound TCP port.

        :return: Port number.
        """
        return self._port

    async def start(self, session: ManagerSession) -> None:
        """Open the session and start listening for clients.

        :param session: Serial manager session.
        :return: None
        """
        self._loop = asyncio.get_running_loop()
        self._session = session
        await session.open()
        self._server = await asyncio.start_server(self._handle_client, self._host, self._port)
        sock = self._server.sockets[0] if self._server.sockets else None
        if sock is not None:
            self._host, self._port = sock.getsockname()[:2]

    async def serve_until_shutdown(self) -> int:
        """Run until a shutdown request is received.

        :return: Process exit code.
        """
        if self._server is None:
            raise RuntimeError("manager server is not started")
        async with self._server:
            await self._shutdown_event.wait()
        await self.close()
        return 0

    async def close(self) -> None:
        """Close clients, server socket, and serial session.

        :return: None
        """
        clients = list(self._clients)
        self._clients.clear()
        self._client_roles.clear()
        self._client_readers.clear()
        for writer in clients:
            await _close_writer(writer)
        if self._server is not None:
            self._server.close()
            try:
                await asyncio.wait_for(self._server.wait_closed(), timeout=1.0)
            except Exception:
                pass
            self._server = None
        await self._close_session()

    async def _close_session(self) -> None:
        """Close the serial session if it is still active.

        :return: None
        """
        if self._session is not None:
            session = self._session
            self._session = None
            await session.close()

    def emit_event(self, event: str, payload: dict[str, Any]) -> None:
        """Broadcast one event from any session thread.

        :param event: Event name.
        :param payload: Event payload.
        :return: None
        """
        loop = self._loop
        if loop is None or loop.is_closed():
            return
        line = event_line(event, payload).encode("utf-8")
        loop.call_soon_threadsafe(lambda: asyncio.create_task(self._broadcast(line)))

    async def _broadcast(self, line: bytes) -> None:
        stale: list[asyncio.StreamWriter] = []
        for writer in list(self._clients):
            try:
                writer.write(line)
                await writer.drain()
            except Exception:
                stale.append(writer)
        for writer in stale:
            self._clients.discard(writer)
            self._client_roles.pop(writer, None)
            self._client_readers.pop(writer, None)

    async def _handle_client(
        self,
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
    ) -> None:
        self._clients.add(writer)
        self._client_roles[writer] = "unknown"
        self._client_readers[writer] = reader
        try:
            await self._write_line(writer, event_line("status", self._status_payload()))
            while not reader.at_eof():
                line = await reader.readline()
                if not line:
                    break
                should_shutdown = await self._handle_line(writer, line)
                if should_shutdown:
                    break
        except (ConnectionError, OSError):
            pass
        finally:
            self._clients.discard(writer)
            self._client_roles.pop(writer, None)
            self._client_readers.pop(writer, None)
            await _close_writer(writer)

    async def _handle_line(self, writer: asyncio.StreamWriter, line: bytes) -> bool:
        request_id = ""
        try:
            request = parse_request(line)
            request_id = request.request_id
            if request.token != self._token:
                raise RpcProtocolError("invalid manager token", ERROR_AUTH)
            result = await self._dispatch(
                request.method,
                request.params,
                request.request_id,
                writer,
            )
        except RpcMethodError as exc:
            await self._write_line(
                writer,
                error_response_line(request_id, exc.code, str(exc), exc.details),
            )
            return False
        except RpcProtocolError as exc:
            await self._write_line(writer, error_response_line(request_id, exc.code, str(exc)))
            return False
        except Exception as exc:
            await self._write_line(writer, error_response_line(request_id, ERROR_INTERNAL, str(exc)))
            return False

        await self._write_line(writer, response_line(request_id, result))
        if request.method == "manager.shutdown":
            self._shutdown_event.set()
            return True
        return False

    async def _dispatch(
        self,
        method: str,
        params: dict[str, Any],
        request_id: str,
        writer: asyncio.StreamWriter | None = None,
    ) -> Any:
        session = self._require_session()
        if method == "manager.ping":
            return {
                "pong": True,
                "protocolVersion": PROTOCOL_VERSION,
                "managerInstanceId": self._instance_id,
            }
        if method == "manager.hello":
            role = str(params.get("role") or "").strip().lower()
            if role not in CLIENT_ROLES:
                raise RpcMethodError("unsupported client role: %s" % (role or "empty"), "invalid_role")
            if writer is not None:
                self._client_roles[writer] = role
            return {
                "protocolVersion": PROTOCOL_VERSION,
                "managerInstanceId": self._instance_id,
                "role": role,
                "capabilities": [
                    "agent-cli",
                    "client-roles",
                    "bounded-queue",
                    "filesystem",
                    "repl-exec",
                ],
                "status": self._status_payload(),
            }
        if method == "manager.status":
            return self._status_payload()
        if method == "manager.shutdown":
            try:
                await session.cancel()
            except Exception:
                pass
            await self._close_session()
            return {"closing": True}
        if method == "manager.cancel":
            return await session.cancel()
        if method == "device.interrupt":
            return await session.interrupt()
        if method == "device.softReset":
            return await self._run_serial_operation(method, params, session.soft_reset, writer)
        if method == "repl.exec":
            label = str(params.get("label") or "")
            async def execute() -> Any:
                if label:
                    self.emit_event("execution", {"phase": "started", "label": label})
                try:
                    return await session.execute(
                        str(params.get("source") or ""),
                        _optional_float(params.get("followTimeout")),
                        params.get("instrument", True) is not False,
                    )
                finally:
                    if label:
                        self.emit_event("execution", {"phase": "finished", "label": label})

            return await self._run_serial_operation(method, params, execute, writer)
        if method == "repl.complete":
            return await session.complete(
                str(params.get("text") or ""),
                _optional_int(params.get("cursor")),
                bool(params.get("requested", True)),
            )
        if method == "repl.clearRuntimeCache":
            return session.clear_runtime_cache()
        if method in FS_METHODS:
            payload = _fs_payload(method, params, request_id)
            return await self._run_serial_operation(
                method,
                params,
                lambda: session.fs_operation(FS_METHODS[method], payload),
                writer,
            )
        raise RpcMethodError("unsupported method: %s" % method, "unsupported")

    async def _run_serial_operation(
        self,
        method: str,
        params: dict[str, Any],
        operation: Callable[[], Awaitable[Any]],
        writer: asyncio.StreamWriter | None = None,
    ) -> Any:
        """Run one serial operation with an optional bounded queue wait."""
        policy = str(params.get("queuePolicy") or "wait")
        if policy not in {"wait", "reject"}:
            raise RpcMethodError("queuePolicy must be 'wait' or 'reject'", "invalid_params")
        if policy == "reject" and self._operation_lock.locked():
            raise RpcMethodError("serial manager is busy", "busy", self._busy_details(method))

        timeout_ms = _optional_float(params.get("queueTimeoutMs"))
        if timeout_ms is not None and timeout_ms < 0:
            raise RpcMethodError("queueTimeoutMs must be non-negative", "invalid_params")
        self._queued_operations += 1
        try:
            try:
                await self._acquire_operation_lock(timeout_ms, writer)
            except asyncio.TimeoutError as exc:
                raise RpcMethodError(
                    "timed out waiting for the serial manager",
                    "queue_timeout",
                    self._busy_details(method),
                ) from exc
        finally:
            self._queued_operations -= 1

        try:
            return await operation()
        finally:
            self._operation_lock.release()

    async def _acquire_operation_lock(
        self,
        timeout_ms: float | None,
        writer: asyncio.StreamWriter | None,
    ) -> None:
        if timeout_ms == 0:
            if self._operation_lock.locked():
                raise asyncio.TimeoutError
            await self._operation_lock.acquire()
            return
        reader = self._client_readers.get(writer) if writer is not None else None
        acquire_task = asyncio.create_task(self._operation_lock.acquire())
        disconnect_task = asyncio.create_task(self._wait_for_disconnect(reader)) if reader is not None else None
        wait_tasks = {acquire_task}
        if disconnect_task is not None:
            wait_tasks.add(disconnect_task)
        try:
            done, _ = await asyncio.wait(
                wait_tasks,
                timeout=None if timeout_ms is None else timeout_ms / 1000.0,
                return_when=asyncio.FIRST_COMPLETED,
            )
            if disconnect_task is not None and disconnect_task in done:
                if acquire_task in done and acquire_task.result():
                    self._operation_lock.release()
                else:
                    acquire_task.cancel()
                    await _ignore_cancelled(acquire_task)
                raise RpcMethodError("manager client disconnected while queued", "cancelled")
            if acquire_task in done:
                return
            acquire_task.cancel()
            await _ignore_cancelled(acquire_task)
            raise asyncio.TimeoutError
        finally:
            if not acquire_task.done():
                acquire_task.cancel()
                await _ignore_cancelled(acquire_task)
            if disconnect_task is not None and not disconnect_task.done():
                disconnect_task.cancel()
                await _ignore_cancelled(disconnect_task)

    @staticmethod
    async def _wait_for_disconnect(reader: asyncio.StreamReader) -> None:
        while not reader.at_eof():
            await asyncio.sleep(0.05)

    def _busy_details(self, requested_method: str) -> dict[str, Any]:
        status = self._require_session().status()
        return {
            "requestedMethod": requested_method,
            "operation": status.get("operation") or "",
            "queuedOperationCount": self._queued_operations,
        }

    async def _write_line(self, writer: asyncio.StreamWriter, line: str) -> None:
        writer.write(line.encode("utf-8"))
        await writer.drain()

    def _require_session(self) -> ManagerSession:
        if self._session is None:
            raise RpcMethodError("manager session is not ready", "not_ready")
        return self._session

    def _status_payload(self) -> dict[str, Any]:
        status = dict(self._require_session().status())
        status["clientCount"] = len(self._clients)
        status["extensionClientCount"] = self._role_count("extension")
        status["replClientCount"] = self._role_count("repl")
        status["agentClientCount"] = self._role_count("agent")
        status["queuedOperationCount"] = self._queued_operations
        status["protocolVersion"] = PROTOCOL_VERSION
        return status

    def _role_count(self, role: str) -> int:
        return sum(1 for value in self._client_roles.values() if value == role)


def _optional_float(value: Any) -> float | None:
    if isinstance(value, (int, float)):
        return float(value)
    return None


def _optional_int(value: Any) -> int | None:
    if isinstance(value, int):
        return value
    return None


def _first_string(params: dict[str, Any], *names: str, default: str = "") -> str:
    for name in names:
        value = params.get(name)
        if isinstance(value, str) and value:
            return value
    return default


def _fs_payload(method: str, params: dict[str, Any], request_id: str) -> dict[str, Any]:
    payload: dict[str, Any] = {"request_id": request_id}
    if method in {"fs.stat", "fs.listdir", "fs.tree", "fs.mkdir", "fs.remove", "fs.readFile", "fs.writeFile"}:
        payload["path"] = _first_string(params, "path", "devicePath", default="/")
    if method == "fs.mkdir":
        payload["parents"] = bool(params.get("parents", True))
    if method == "fs.remove":
        payload["recursive"] = bool(params.get("recursive", True))
    if method == "fs.rename":
        payload["src"] = _first_string(params, "src", "source", "sourcePath")
        payload["dst"] = _first_string(params, "dst", "target", "targetPath")
    if method in {"fs.readFile", "fs.writeFile"}:
        payload["local_path"] = _first_string(params, "local_path", "localPath")
    if method == "fs.exec":
        payload["source"] = str(params.get("source") or "")
    return payload


async def _close_writer(writer: asyncio.StreamWriter, timeout: float = 1.0) -> None:
    """Close one stream writer without allowing shutdown to hang indefinitely.

    :param writer: Stream writer to close.
    :param timeout: Maximum wait for close completion.
    :return: None
    """
    try:
        writer.close()
        await asyncio.wait_for(writer.wait_closed(), timeout=timeout)
    except Exception:
        pass


async def _ignore_cancelled(task: asyncio.Task[Any]) -> None:
    """Await a cancelled helper task without leaking cancellation."""
    try:
        await task
    except asyncio.CancelledError:
        pass


async def run_manager_async(
    config: ReplConfig,
    host: str = DEFAULT_HOST,
    port: int = 0,
    token: str = "",
    follow_timeout: float | None = None,
    stub_root: str = "",
    completion_roots: list[str] | None = None,
    dir_query_timeout: float = 2.0,
    helper_version: str = "",
    ready_stream: TextIO = sys.stdout,
) -> int:
    """Run the hidden serial manager server.

    :param config: Serial REPL config.
    :param host: Bind host.
    :param port: Bind port, or zero for random.
    :param token: Optional authentication token.
    :param follow_timeout: Default execution follow timeout, or None to wait for user code indefinitely.
    :param stub_root: Optional completion stub root.
    :param completion_roots: Additional local completion roots.
    :param dir_query_timeout: Device completion timeout.
    :param helper_version: Version string shown by the injected helper.
    :param ready_stream: Stream for the ready line.
    :return: Process exit code.
    """
    manager_token = token or secrets.token_urlsafe(24)
    server = ManagerServer(manager_token, host=host, port=port)
    session = ManagerSession(
        config,
        follow_timeout=follow_timeout,
        stub_root=stub_root,
        completion_roots=completion_roots,
        dir_query_timeout=dir_query_timeout,
        helper_version=helper_version,
        emit_event=server.emit_event,
    )
    await server.start(session)
    ready_stream.write(ready_line(server.host, server.port, manager_token))
    ready_stream.flush()
    return await server.serve_until_shutdown()


def run_manager(
    config: ReplConfig,
    host: str = DEFAULT_HOST,
    port: int = 0,
    token: str = "",
    follow_timeout: float | None = None,
    stub_root: str = "",
    completion_roots: list[str] | None = None,
    dir_query_timeout: float = 2.0,
    helper_version: str = "",
) -> int:
    """Synchronous CLI wrapper for the hidden serial manager.

    :param config: Serial REPL config.
    :param host: Bind host.
    :param port: Bind port, or zero for random.
    :param token: Optional authentication token.
    :param follow_timeout: Default execution follow timeout, or None to wait for user code indefinitely.
    :param stub_root: Optional completion stub root.
    :param completion_roots: Additional local completion roots.
    :param dir_query_timeout: Device completion timeout.
    :param helper_version: Version string shown by the injected helper.
    :return: Process exit code.
    """
    return asyncio.run(
        run_manager_async(
            config,
            host=host,
            port=port,
            token=token,
            follow_timeout=follow_timeout,
            stub_root=stub_root,
            completion_roots=completion_roots,
            dir_query_timeout=dir_query_timeout,
            helper_version=helper_version,
        )
    )
