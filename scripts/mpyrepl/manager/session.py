"""Serial session owned by the hidden MicroPython manager.

:return: None
"""

from __future__ import annotations

import asyncio
from dataclasses import replace
from typing import Any, Callable

from prompt_toolkit.completion import CompleteEvent
from prompt_toolkit.document import Document

from mpyrepl.completion.device import query_device_attributes
from mpyrepl.completion.engine import ReplCompleter
from mpyrepl.completion.state import ReplSessionSymbols
from mpyrepl.manager.protocol import RpcMethodError
from mpyrepl.repl.semantics import build_helper_source, instrument_source
from mpyrepl.runtime.decode import Utf8StreamDecoder
from mpyrepl.runtime.filesystem import DeviceFsClient, FsOperationError, run_fs_operation
from mpyrepl.runtime.models import ReplConfig
from mpyrepl.runtime.operation_gate import SerialOperationGate
from mpyrepl.runtime.transport import SerialReplTransport, TransportError, TransportInterrupted


EventCallback = Callable[[str, dict[str, Any]], None]
TransportFactory = Callable[[ReplConfig], SerialReplTransport]
CONNECTION_PROBE_INTERVAL = 0.5
RECONNECT_RETRY_INTERVAL = 0.25


def _decode_chunk(decoder: Utf8StreamDecoder, chunk: bytes) -> str:
    """Decode one output chunk and return ready text.

    :param decoder: UTF-8 stream decoder.
    :param chunk: Raw bytes.
    :return: Decoded text, possibly empty.
    """
    return decoder.feed(chunk)


class ManagerSession:
    """Own one MicroPython raw REPL transport for the manager process.

    :param config: Serial runtime configuration.
    :param follow_timeout: Default execution follow timeout.
    :param stub_root: Optional completion stub root.
    :param completion_roots: Additional local completion roots.
    :param dir_query_timeout: Device-backed completion timeout.
    :param helper_version: Version string shown by the injected helper.
    :param emit_event: Event callback used by the manager server.
    :param transport_factory: Optional transport factory for tests.
    :return: None
    """

    def __init__(
        self,
        config: ReplConfig,
        follow_timeout: float | None = None,
        stub_root: str = "",
        completion_roots: list[str] | None = None,
        dir_query_timeout: float = 2.0,
        helper_version: str = "",
        emit_event: EventCallback | None = None,
        transport_factory: TransportFactory = SerialReplTransport,
    ) -> None:
        """Store session configuration without opening the serial port.

        :param config: Serial runtime configuration.
        :param follow_timeout: Default execution follow timeout, or None to wait for user code indefinitely.
        :param stub_root: Optional completion stub root.
        :param completion_roots: Additional local completion roots.
        :param dir_query_timeout: Device-backed completion timeout.
        :param helper_version: Version string shown by the injected helper.
        :param emit_event: Event callback used by the manager server.
        :param transport_factory: Optional transport factory for tests.
        :return: None
        """
        self._config = config
        self._follow_timeout = follow_timeout
        self._stub_root = stub_root
        self._completion_roots = list(completion_roots or [])
        self._dir_query_timeout = dir_query_timeout
        self._helper_version = helper_version
        self._emit_event = emit_event or (lambda event, payload: None)
        self._transport_factory = transport_factory
        self._transport: SerialReplTransport | None = None
        self._fs_client: DeviceFsClient | None = None
        self._gate = SerialOperationGate()
        self._symbols = ReplSessionSymbols()
        self._completer: ReplCompleter | None = None
        self._state = "stopped"
        self._connection_monitor: asyncio.Task[None] | None = None
        self._idle_output_decoder = Utf8StreamDecoder()

    @property
    def state(self) -> str:
        """Return the coarse manager session state.

        :return: State string.
        """
        if self._state == "ready" and self._gate.busy:
            return "busy"
        return self._state

    @property
    def gate(self) -> SerialOperationGate:
        """Return the serial operation gate.

        :return: Gate instance.
        """
        return self._gate

    async def open(self) -> None:
        """Open the serial transport and initialize raw REPL helpers.

        :return: None
        """
        if self._transport is not None:
            return

        self._state = "starting"
        self._emit_status()
        transport = self._transport_factory(self._config)
        try:
            await asyncio.to_thread(transport.open)
            await self._gate.run(
                "enter-raw-repl",
                transport.enter_raw_repl,
                self._config.soft_reset_on_connect,
            )
            await self._gate.run("helper-load", self._ensure_helper_loaded, transport)
        except Exception:
            self._state = "failed"
            self._emit_status()
            try:
                await asyncio.to_thread(transport.close)
            except Exception:
                pass
            raise

        self._transport = transport
        self._fs_client = DeviceFsClient(transport, timeout=self._config.operation_timeout)
        self._completer = ReplCompleter(
            self._symbols,
            stub_root=self._stub_root,
            completion_roots=self._completion_roots,
            dotted_provider=lambda expression, prefix, timeout=None: query_device_attributes(
                transport,
                self._gate,
                self._symbols,
                expression,
                timeout=self._dir_query_timeout if timeout is None else min(timeout, self._dir_query_timeout),
            ),
        )
        self._state = "ready"
        self._emit_status()
        self._start_connection_monitor(transport)

    async def close(self) -> None:
        """Close the raw REPL transport and serial port.

        :return: None
        """
        await self._release_transport(announce_closing=True)

    async def reconnect(
        self,
        timeout: float,
        retry_interval: float = RECONNECT_RETRY_INTERVAL,
    ) -> dict[str, Any]:
        """Reopen the configured serial port until the device is ready.

        :param timeout: Maximum time to wait for USB serial re-enumeration.
        :param retry_interval: Delay between failed open attempts.
        :return: Ready session status.
        """
        return await self.connect(
            self._config.port,
            self._config.baudrate,
            timeout,
            retry_interval=retry_interval,
        )

    async def connect(
        self,
        port: str,
        baudrate: int | None,
        timeout: float,
        retry_interval: float = RECONNECT_RETRY_INTERVAL,
    ) -> dict[str, Any]:
        """Connect the manager to an explicitly selected serial port.

        :param port: Serial port name or URL.
        :param baudrate: Optional serial baud rate.
        :param timeout: Maximum time to wait for the device.
        :param retry_interval: Delay between failed open attempts.
        :return: Ready session status.
        """
        target_port = port.strip()
        target_baudrate = self._config.baudrate if baudrate is None else baudrate
        if not target_port:
            raise RpcMethodError("serial port must not be empty", "invalid_params")
        if target_baudrate <= 0:
            raise RpcMethodError("baudrate must be greater than zero", "invalid_params")
        if timeout <= 0:
            raise RpcMethodError("connect timeout must be greater than zero", "invalid_params")

        await self._release_transport(announce_closing=False)
        self._config = replace(self._config, port=target_port, baudrate=target_baudrate)
        self._symbols.clear()
        self._emit_status()
        return await self._open_with_retry(timeout, retry_interval)

    async def disconnect(self) -> dict[str, Any]:
        """Release the serial port while keeping the manager RPC server alive.

        :return: Stopped session status.
        """
        await self._release_transport(announce_closing=False)
        self._symbols.clear()
        return self.status()

    async def _open_with_retry(self, timeout: float, retry_interval: float) -> dict[str, Any]:
        """Open the configured device repeatedly until ready or timed out."""
        deadline = asyncio.get_running_loop().time() + timeout
        last_error: Exception | None = None
        while True:
            try:
                await self.open()
                return self.status()
            except Exception as exc:
                last_error = exc

            remaining = deadline - asyncio.get_running_loop().time()
            if remaining <= 0:
                break
            await asyncio.sleep(min(max(retry_interval, 0.01), remaining))

        detail = str(last_error) if last_error is not None else "device did not become ready"
        raise RpcMethodError(
            "failed to connect %s within %.1f seconds (%s)" % (self._config.port, timeout, detail),
            "transport",
            {"port": self._config.port, "timeoutSeconds": timeout},
        ) from last_error

    async def _release_transport(self, announce_closing: bool) -> None:
        """Release the current serial transport without stopping the manager."""
        await self._stop_connection_monitor()
        if announce_closing:
            self._state = "closing"
            self._emit_status()
        transport = self._transport
        if transport is not None:
            if self._gate.busy:
                try:
                    await asyncio.to_thread(transport.interrupt)
                except Exception:
                    pass
                await self._wait_for_gate_idle(2.0)
            self._transport = None
            self._fs_client = None
            try:
                await asyncio.to_thread(transport.exit_raw_repl)
            except Exception:
                pass
            try:
                await asyncio.to_thread(transport.close)
            except Exception:
                pass
        self._fs_client = None
        self._completer = None
        self._idle_output_decoder = Utf8StreamDecoder()
        self._state = "stopped"
        self._emit_status()

    def status(self) -> dict[str, Any]:
        """Return JSON-compatible manager session status.

        :return: Status payload.
        """
        return {
            "state": self.state,
            "port": self._config.port,
            "baudrate": self._config.baudrate,
            "busy": self._gate.busy,
            "operation": self._gate.current_operation,
        }

    async def interrupt(self) -> bool:
        """Send Ctrl-C to the device.

        :return: True when an interrupt was sent.
        """
        await self._ensure_open()
        transport = self._require_transport()
        try:
            await asyncio.to_thread(transport.interrupt)
        except TransportError as exc:
            await self._mark_transport_lost(exc)
        self._emit_event("status", self.status())
        return True

    async def cancel(self) -> bool:
        """Cancel the current operation using the same path as interrupt.

        :return: True when cancellation was requested.
        """
        return await self.interrupt()

    async def soft_reset(self) -> bool:
        """Run a raw-mode soft reset and stream boot output.

        :return: True on success.
        """
        await self._ensure_open()
        transport = self._require_transport()
        decoder = Utf8StreamDecoder()

        def _consumer(chunk: bytes) -> None:
            text = _decode_chunk(decoder, chunk)
            if text:
                self._emit_event("stdout", {"text": text})

        try:
            await self._gate.run("soft-reset", transport.soft_reset, _consumer)
            await self._gate.run("helper-load", self._ensure_helper_loaded, transport)
        except TransportError as exc:
            await self._mark_transport_lost(exc)
        finally:
            text = decoder.flush()
            if text:
                self._emit_event("stdout", {"text": text})
        self._symbols.clear()
        if self._completer is not None:
            self._completer.clear_runtime_cache()
        return True

    async def execute(
        self,
        source: str,
        follow_timeout: float | None = None,
        instrument: bool = True,
    ) -> dict[str, str]:
        """Execute one user source block and stream output events.

        :param source: Python source.
        :param follow_timeout: Optional follow timeout.
        :param instrument: Apply interactive expression echo semantics when true.
        :return: Decoded stdout/stderr.
        """
        prepared = source.rstrip()
        if not prepared:
            return {"stdout": "", "stderr": ""}

        await self._ensure_open()
        transport = self._require_transport()
        stdout_decoder = Utf8StreamDecoder()
        stderr_decoder = Utf8StreamDecoder()
        stdout_chunks: list[str] = []
        stderr_chunks: list[str] = []

        def _stdout_consumer(chunk: bytes) -> None:
            text = _decode_chunk(stdout_decoder, chunk)
            if text:
                stdout_chunks.append(text)
                self._emit_event("stdout", {"text": text})

        def _stderr_consumer(chunk: bytes) -> None:
            text = _decode_chunk(stderr_decoder, chunk)
            if text:
                stderr_chunks.append(text)
                self._emit_event("stderr", {"text": text})

        try:
            executed_source = instrument_source(prepared) if instrument else prepared
            result = await self._gate.run(
                "repl.exec",
                transport.exec_raw,
                executed_source,
                self._follow_timeout if follow_timeout is None else follow_timeout,
                _stdout_consumer,
                _stderr_consumer,
            )
        except TransportInterrupted:
            await self._gate.run("interrupt-recover", transport.enter_raw_repl, False, 2.0)
            raise RpcMethodError("execution interrupted", "cancelled")
        except TransportError as exc:
            await self._mark_transport_lost(exc)
        finally:
            stdout_tail = stdout_decoder.flush()
            stderr_tail = stderr_decoder.flush()
            if stdout_tail:
                stdout_chunks.append(stdout_tail)
                self._emit_event("stdout", {"text": stdout_tail})
            if stderr_tail:
                stderr_chunks.append(stderr_tail)
                self._emit_event("stderr", {"text": stderr_tail})

        stdout_text = "".join(stdout_chunks) or result.stdout.decode("utf-8", errors="replace")
        stderr_text = "".join(stderr_chunks) or result.stderr.decode("utf-8", errors="replace")
        if not result.stderr:
            source_changes = self._symbols.record_successful_source(prepared)
            if self._completer is not None:
                self._completer.invalidate_runtime_cache(
                    rebound_roots=source_changes.rebound_roots,
                    mutated_roots=source_changes.mutated_roots,
                    clear_all=source_changes.clear_runtime_cache,
                )
        return {"stdout": stdout_text, "stderr": stderr_text}

    async def fs_operation(self, op: str, payload: dict[str, Any]) -> Any:
        """Execute one filesystem operation through the shared transport.

        :param op: Existing fs_ops operation name.
        :param payload: Operation payload.
        :return: Operation result.
        """
        await self._ensure_open()
        client = self._require_fs_client()
        request_id = str(payload.get("request_id") or "")
        operation_payload = dict(payload)
        if op in {"write_file", "read_file"}:
            operation_payload["progress_callback"] = lambda event: self._emit_event(
                "progress",
                {"operationId": request_id, **event},
            )
        try:
            return await self._gate.run("fs." + op, run_fs_operation, client, op, operation_payload)
        except FsOperationError as exc:
            raise RpcMethodError(str(exc), exc.code or "device") from exc
        except TransportError as exc:
            await self._mark_transport_lost(exc)

    async def complete(self, text: str, cursor: int | None = None, requested: bool = True) -> list[dict[str, Any]]:
        """Return completion candidates for one prompt document.

        :param text: Prompt text.
        :param cursor: Cursor offset.
        :param requested: Whether completion was explicitly requested.
        :return: Completion candidate payloads.
        """
        if self._completer is None:
            await self._ensure_open()
        if self._completer is None:
            raise RpcMethodError("completion is not ready", "not_ready")
        return await asyncio.to_thread(self._complete_blocking, text, cursor, requested)

    def clear_runtime_cache(self) -> bool:
        """Clear manager-side completion runtime cache.

        :return: True when cache was cleared.
        """
        if self._completer is not None:
            self._completer.clear_runtime_cache()
        return True

    def _complete_blocking(
        self,
        text: str,
        cursor: int | None,
        requested: bool,
    ) -> list[dict[str, Any]]:
        completer = self._completer
        if completer is None:
            return []
        document = Document(text, cursor_position=len(text) if cursor is None else cursor)
        completions = list(completer.get_completions(document, CompleteEvent(completion_requested=requested)))
        return [
            {
                "text": completion.text,
                "startPosition": completion.start_position,
                "display": str(completion.display_text),
                "meta": str(completion.display_meta_text),
            }
            for completion in completions
        ]

    async def _wait_for_gate_idle(self, timeout: float) -> None:
        deadline = asyncio.get_running_loop().time() + timeout
        while self._gate.busy and asyncio.get_running_loop().time() < deadline:
            await asyncio.sleep(0.05)

    async def _ensure_open(self) -> None:
        if self._transport is None:
            await self.open()

    def _start_connection_monitor(self, transport: SerialReplTransport) -> None:
        """Start the idle serial-device monitor for the active transport."""
        self._connection_monitor = asyncio.create_task(
            self._monitor_connection(transport),
            name="mpyrepl-connection-monitor",
        )

    async def _stop_connection_monitor(self) -> None:
        """Cancel the idle serial-device monitor when it is running."""
        monitor = self._connection_monitor
        self._connection_monitor = None
        if monitor is None or monitor is asyncio.current_task():
            return
        monitor.cancel()
        try:
            await monitor
        except asyncio.CancelledError:
            pass

    async def _monitor_connection(self, transport: SerialReplTransport) -> None:
        """Probe an idle transport and forward asynchronous device output."""
        try:
            while self._transport is transport:
                await asyncio.sleep(CONNECTION_PROBE_INTERVAL)
                if self._transport is not transport:
                    return
                try:
                    idle_reader = getattr(transport, "read_idle_output", transport.probe_connection)
                    probe_result = await asyncio.to_thread(
                        self._gate.try_run_blocking,
                        "connection-probe",
                        idle_reader,
                    )
                except TransportError as exc:
                    try:
                        await self._mark_transport_lost(exc)
                    except RpcMethodError:
                        return
                if probe_result is None:
                    continue
                if isinstance(probe_result, (bytes, bytearray)) and probe_result:
                    text = _decode_chunk(self._idle_output_decoder, bytes(probe_result))
                    if text:
                        self._emit_event("stdout", {"text": text, "background": True})
        except asyncio.CancelledError:
            return

    async def _mark_transport_lost(self, exc: TransportError) -> None:
        transport = self._transport
        self._transport = None
        self._fs_client = None
        self._completer = None
        self._state = "stopped"
        await self._stop_connection_monitor()
        self._emit_status()
        if transport is not None:
            try:
                await asyncio.to_thread(transport.close)
            except Exception:
                pass
        raise RpcMethodError(
            "serial connection lost; retry the command to reconnect (%s)" % exc,
            "transport_lost",
        ) from exc

    def _ensure_helper_loaded(self, transport: SerialReplTransport) -> None:
        result = transport.exec_raw(
            build_helper_source(self._helper_version),
            timeout=self._config.operation_timeout,
        )
        if result.stderr:
            detail = result.stderr.decode("utf-8", errors="replace").strip()
            raise TransportError("failed to inject repl helper: %s" % detail)

    def _require_transport(self) -> SerialReplTransport:
        if self._transport is None:
            raise RpcMethodError("serial manager is not connected", "not_connected")
        return self._transport

    def _require_fs_client(self) -> DeviceFsClient:
        if self._fs_client is None:
            raise RpcMethodError("filesystem client is not ready", "not_connected")
        return self._fs_client

    def _emit_status(self) -> None:
        self._emit_event("status", self.status())
