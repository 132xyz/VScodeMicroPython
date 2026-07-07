"""Async NDJSON RPC server for the hidden serial manager.

:return: None
"""

from __future__ import annotations

import asyncio
import secrets
import sys
from typing import Any, TextIO

from manager_protocol import (
    DEFAULT_HOST,
    ERROR_AUTH,
    ERROR_INTERNAL,
    ERROR_PROTOCOL,
    RpcMethodError,
    RpcProtocolError,
    error_response_line,
    event_line,
    parse_request,
    ready_line,
    response_line,
)
from manager_session import ManagerSession
from models import ReplConfig


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
        self._host = host
        self._port = port
        self._server: asyncio.AbstractServer | None = None
        self._session: ManagerSession | None = None
        self._clients: set[asyncio.StreamWriter] = set()
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
        for writer in clients:
            await _close_writer(writer)
        if self._server is not None:
            self._server.close()
            try:
                await asyncio.wait_for(self._server.wait_closed(), timeout=1.0)
            except Exception:
                pass
            self._server = None
        if self._session is not None:
            await self._session.close()
            self._session = None

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

    async def _handle_client(
        self,
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
    ) -> None:
        self._clients.add(writer)
        try:
            await self._write_line(writer, event_line("status", self._require_session().status()))
            while not reader.at_eof():
                line = await reader.readline()
                if not line:
                    break
                should_shutdown = await self._handle_line(writer, line)
                if should_shutdown:
                    break
        finally:
            self._clients.discard(writer)
            await _close_writer(writer)

    async def _handle_line(self, writer: asyncio.StreamWriter, line: bytes) -> bool:
        request_id = ""
        try:
            request = parse_request(line)
            request_id = request.request_id
            if request.token != self._token:
                raise RpcProtocolError("invalid manager token", ERROR_AUTH)
            result = await self._dispatch(request.method, request.params, request.request_id)
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

    async def _dispatch(self, method: str, params: dict[str, Any], request_id: str) -> Any:
        session = self._require_session()
        if method == "manager.ping":
            return {"pong": True}
        if method == "manager.status":
            return session.status()
        if method == "manager.shutdown":
            try:
                await session.cancel()
            except Exception:
                pass
            return {"closing": True}
        if method == "manager.cancel":
            return await session.cancel()
        if method == "device.interrupt":
            return await session.interrupt()
        if method == "device.softReset":
            return await session.soft_reset()
        if method == "repl.exec":
            return await session.execute(
                str(params.get("source") or ""),
                _optional_float(params.get("followTimeout")),
            )
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
            return await session.fs_operation(FS_METHODS[method], payload)
        raise RpcMethodError("unsupported method: %s" % method, "unsupported")

    async def _write_line(self, writer: asyncio.StreamWriter, line: str) -> None:
        writer.write(line.encode("utf-8"))
        await writer.drain()

    def _require_session(self) -> ManagerSession:
        if self._session is None:
            raise RpcMethodError("manager session is not ready", "not_ready")
        return self._session


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
