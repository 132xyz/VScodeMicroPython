"""Serial raw REPL transport helpers for the standalone spike.

:return: None
"""

from __future__ import annotations

import ctypes
import struct
import time
from typing import Callable, Optional

import serial

from mpyrepl.runtime.models import ExecResult, ReplConfig


BytesConsumer = Callable[[bytes], None]
INTERRUPT_FOLLOW_GRACE = 1.5
READ_UNTIL_MAX_CHUNK_SIZE = 4096


class TransportError(RuntimeError):
    """Raised when the transport cannot complete a protocol step."""


class ReplSyncError(TransportError):
    """Report REPL synchronization failure without implying serial I/O loss."""

    def __init__(self, message: str, reset_sent: bool = False, reset_observed: bool = False) -> None:
        """Store whether the failed protocol step may have reset the device.

        :param message: Protocol diagnostic.
        :param reset_sent: Whether Ctrl-D was sent before the failure.
        :param reset_observed: Whether the soft reboot marker was received.
        """
        super().__init__(message)
        self.reset_sent = reset_sent
        self.reset_observed = reset_observed


class TransportInterrupted(TransportError):
    """Raised when a user interrupt breaks a long-running follow operation."""


def _describe_observed_bytes(data: bytes, limit: int = 120) -> str:
    """Return a compact representation of observed device bytes.

    :param data: Captured device bytes.
    :param limit: Maximum number of trailing bytes to include.
    :return: Human-readable byte summary.
    """
    if len(data) <= limit:
        return repr(data)
    return "<%d bytes total, tail=%r>" % (len(data), data[-limit:])


class SerialReplTransport:
    """Minimal raw REPL transport aligned with mpremote's serial behavior.

    :param config: Runtime configuration.
    :return: None
    """

    def __init__(self, config: ReplConfig) -> None:
        """Store configuration without opening the serial port yet.

        :param config: Runtime configuration.
        :return: None
        """
        self._config = config
        self._serial: Optional[serial.Serial] = None
        self._in_raw_repl = False
        self._use_raw_paste = True
        self._interrupt_requested_at: Optional[float] = None
        self._read_buffer = b""
        self._raw_paste_active = False
        self._prompt_ready = False
        self.console_consumer: Optional[BytesConsumer] = None
        self.operation_deadline: Optional[float] = None

    def console_output(self, data: bytes) -> None:
        """Forward bytes not owned by an internal response to the shared console."""
        if data and self.console_consumer is not None:
            self.console_consumer(data)

    def _await_prompt(self, timeout: float) -> None:
        if self._prompt_ready:
            return
        data = self.read_until(b">", timeout=None, overall_timeout=timeout, consumer=self.console_output)
        if not data.endswith(b">"):
            raise ReplSyncError("could not observe raw prompt before execution")
        self._prompt_ready = True

    def __enter__(self) -> "SerialReplTransport":
        """Open the transport when used as a context manager.

        :return: The opened transport.
        """
        self.open()
        return self

    def __exit__(self, exc_type, exc_value, traceback) -> None:
        """Close the transport when leaving a context manager.

        :return: None
        """
        self.close()

    def open(self) -> None:
        """Open the configured serial port.

        :return: None
        """
        if self._serial is not None:
            return

        self._serial = serial.serial_for_url(
            self._config.port,
            baudrate=self._config.baudrate,
            timeout=self._config.read_timeout,
            inter_byte_timeout=1,
            do_not_open=True,
        )
        self._serial.open()

    def close(self) -> None:
        """Close the serial port and reset local state.

        :return: None
        """
        if self._serial is None:
            return

        try:
            if self._serial.is_open:
                self._serial.close()
        finally:
            self._serial = None
            self._in_raw_repl = False
            self._read_buffer = b""
            self._raw_paste_active = False
            self._prompt_ready = False

    def read_until(
        self,
        ending: bytes,
        timeout: Optional[float],
        overall_timeout: Optional[float] = None,
        consumer: Optional[BytesConsumer] = None,
        include_ending_in_consumer: bool = False,
        interrupt_timeout: Optional[float] = None,
    ) -> bytes:
        """Read until a byte suffix matches or timeouts expire.

        :param ending: Byte suffix to stop on.
        :param timeout: Inter-character timeout in seconds.
        :param overall_timeout: Overall timeout in seconds.
        :param consumer: Optional callback for streaming incoming chunks.
        :param include_ending_in_consumer: Whether to forward the final suffix.
        :return: Accumulated bytes.
        """
        data = bytearray()
        emitted_length = 0
        started_at = time.monotonic()
        last_char_at = started_at

        while True:
            now = time.monotonic()
            if self.operation_deadline is not None and now >= self.operation_deadline:
                raise ReplSyncError("serial operation deadline exceeded")
            if interrupt_timeout is not None and self._interrupt_requested_at is not None and now >= self._interrupt_requested_at + interrupt_timeout:
                break
            if overall_timeout is not None and now >= started_at + overall_timeout:
                break

            pending = len(self._read_buffer) or self._safe_in_waiting()
            read_size = min(max(1, pending), READ_UNTIL_MAX_CHUNK_SIZE)
            new_data = self._read_serial(read_size)
            if new_data:
                prefix_length = max(0, len(ending) - 1)
                prefix = bytes(data[-prefix_length:]) if prefix_length else b""
                ending_index = (prefix + new_data).find(ending)
                if ending_index >= 0:
                    take = ending_index + len(ending) - len(prefix)
                    data.extend(new_data[:take])
                    remainder = new_data[take:]
                    if remainder:
                        self._read_buffer = remainder + self._read_buffer
                    if consumer is not None:
                        limit = len(data) if include_ending_in_consumer else len(data) - len(ending)
                        if emitted_length < limit:
                            consumer(bytes(data[emitted_length:limit]))
                    return bytes(data)
                data.extend(new_data)
                if consumer is not None:
                    safe_limit = len(data) - prefix_length
                    if emitted_length < safe_limit:
                        consumer(bytes(data[emitted_length:safe_limit]))
                        emitted_length = safe_limit
                    last_char_at = time.monotonic()
                    continue
                last_char_at = time.monotonic()
                continue

            now = time.monotonic()
            if timeout is not None and now >= last_char_at + timeout:
                break
            if (
                interrupt_timeout is not None
                and self._interrupt_requested_at is not None
                and now >= max(self._interrupt_requested_at, last_char_at) + interrupt_timeout
            ):
                break
            time.sleep(0.01)

        if consumer is not None and emitted_length < len(data):
            consumer(bytes(data[emitted_length:]))
        return bytes(data)

    def enter_raw_repl(self, soft_reset: bool, operation_timeout: Optional[float] = None) -> None:
        """Interrupt the board and switch into raw REPL.

        :param soft_reset: Whether to soft reset while entering raw REPL.
        :param operation_timeout: Optional timeout override for this entry attempt.
        :return: None
        """
        protocol_timeout = self._config.operation_timeout if operation_timeout is None else operation_timeout
        deadline = time.monotonic() + protocol_timeout
        self._in_raw_repl = False
        self._prompt_ready = False
        # A second Ctrl-C also releases a raw-paste reader waiting for abort acknowledgement.
        self._write_serial(b"\r\x03\x03")
        self._write_serial(b"\r\x01")

        if soft_reset:
            data = self.read_until(
                b"raw REPL; CTRL-B to exit\r\n>",
                timeout=None,
                overall_timeout=max(0.0, deadline - time.monotonic()),
            )
            if not data.endswith(b"raw REPL; CTRL-B to exit\r\n>"):
                raise ReplSyncError(
                    "could not enter raw repl before soft reset; observed=%s"
                    % (_describe_observed_bytes(data),)
                )

            self._write_serial(b"\x04")
            data = self.read_until(
                b"soft reboot\r\n",
                timeout=None,
                overall_timeout=max(0.0, deadline - time.monotonic()),
            )
            if not data.endswith(b"soft reboot\r\n"):
                raise ReplSyncError(
                    "could not observe soft reboot banner; observed=%s"
                    % (_describe_observed_bytes(data),),
                    reset_sent=True,
                )

        data = self.read_until(
            b"raw REPL; CTRL-B to exit\r\n",
            timeout=None,
            overall_timeout=max(0.0, deadline - time.monotonic()),
            consumer=self.console_output,
        )
        if not data.endswith(b"raw REPL; CTRL-B to exit\r\n"):
            raise ReplSyncError(
                "could not enter raw repl; observed=%s" % (_describe_observed_bytes(data),),
                reset_sent=soft_reset,
                reset_observed=soft_reset,
            )

        prompt = self.read_until(b">", timeout=None, overall_timeout=max(0.0, deadline - time.monotonic()))
        if not prompt.endswith(b">"):
            raise ReplSyncError(
                "could not observe raw prompt; observed=%s" % _describe_observed_bytes(prompt),
                reset_sent=soft_reset,
                reset_observed=soft_reset,
            )
        self._prompt_ready = True
        self._in_raw_repl = True
        self._raw_paste_active = False

    def exit_raw_repl(self) -> None:
        """Return to friendly REPL and clear local raw state.

        :return: None
        """
        if self._serial is None:
            return
        try:
            self._write_serial(b"\r\x02")
        except TransportError:
            pass
        finally:
            self._in_raw_repl = False

    def interrupt(self) -> None:
        """Send Ctrl-C to the device.

        :return: None
        """
        self._write_serial(b"\x03")
        self._interrupt_requested_at = time.monotonic()

    def clear_interrupt_request(self) -> None:
        """Clear local interrupt follow state.

        :return: None
        """
        self._interrupt_requested_at = None

    def soft_reset(
        self,
        output_consumer: Optional[BytesConsumer] = None,
        operation_timeout: Optional[float] = None,
    ) -> None:
        """Trigger a raw-mode soft reset and wait for the next raw prompt.

        :param output_consumer: Optional streaming callback for boot output.
        :param operation_timeout: Optional deadline override for all reset stages.
        :return: None
        """
        if not self._in_raw_repl:
            raise ReplSyncError("soft reset requires raw repl")

        protocol_timeout = self._config.operation_timeout if operation_timeout is None else operation_timeout
        deadline = time.monotonic() + protocol_timeout
        self._await_prompt(max(0.0, deadline - time.monotonic()))

        self._write_serial(b"\x04")
        self._prompt_ready = False
        self._in_raw_repl = False
        self.clear_interrupt_request()
        data = self.read_until(
            b"soft reboot\r\n",
            timeout=None,
            overall_timeout=max(0.0, deadline - time.monotonic()),
            consumer=output_consumer,
            include_ending_in_consumer=True,
        )
        if not data.endswith(b"soft reboot\r\n"):
            raise ReplSyncError(
                "soft reboot banner not observed; observed=%s" % _describe_observed_bytes(data),
                reset_sent=True,
            )

        data = self.read_until(
            b"raw REPL; CTRL-B to exit\r\n",
            timeout=None,
            overall_timeout=max(0.0, deadline - time.monotonic()),
            consumer=output_consumer,
            include_ending_in_consumer=True,
        )
        if not data.endswith(b"raw REPL; CTRL-B to exit\r\n"):
            raise ReplSyncError(
                "raw repl prompt not restored after soft reset; observed=%s" % _describe_observed_bytes(data),
                reset_sent=True,
                reset_observed=True,
            )

        prompt = self.read_until(
            b">",
            timeout=None,
            overall_timeout=max(0.0, deadline - time.monotonic()),
            consumer=output_consumer,
        )
        if not prompt.endswith(b">"):
            raise ReplSyncError(
                "raw repl prompt not restored after soft reset; observed=%s" % _describe_observed_bytes(prompt),
                reset_sent=True,
                reset_observed=True,
            )
        self._prompt_ready = True
        self._in_raw_repl = True

    def exec_raw(
        self,
        command: str,
        timeout: Optional[float],
        stdout_consumer: Optional[BytesConsumer] = None,
        stderr_consumer: Optional[BytesConsumer] = None,
    ) -> ExecResult:
        """Execute UTF-8 source bytes through raw REPL.

        :param command: Python source code.
        :param timeout: Follow timeout in seconds.
        :param stdout_consumer: Optional streaming stdout callback.
        :param stderr_consumer: Optional streaming stderr callback.
        :return: Raw stdout and stderr bytes.
        """
        self.exec_raw_no_follow(command.encode("utf-8"))
        return self.follow(timeout, stdout_consumer=stdout_consumer, stderr_consumer=stderr_consumer)

    def exec_raw_no_follow(self, command_bytes: bytes) -> None:
        """Submit code through raw REPL without reading command output.

        :param command_bytes: UTF-8 encoded source bytes.
        :return: None
        """
        self._await_prompt(self._config.operation_timeout)
        self._prompt_ready = False

        if self._use_raw_paste:
            self._write_serial(b"\x05A\x01")
            response = self.read_exact(2, timeout=self._config.operation_timeout)
            if response == b"R\x01":
                self.raw_paste_write(command_bytes)
                return
            if response == b"R\x00":
                self._use_raw_paste = False
            else:
                data = self.read_until(
                    b"w REPL; CTRL-B to exit\r\n>",
                    timeout=self._config.read_timeout,
                    overall_timeout=self._config.operation_timeout,
                )
                if not data.endswith(b"w REPL; CTRL-B to exit\r\n>"):
                    raise TransportError("device did not enter raw repl fallback mode")
                self._use_raw_paste = False

        for start in range(0, len(command_bytes), 256):
            self._write_serial(command_bytes[start : start + 256])
            time.sleep(0.01)
        self._write_serial(b"\x04")

        response = self.read_exact(2, timeout=self._config.operation_timeout)
        if response != b"OK":
            raise TransportError("could not execute command: %r" % (response,))

    def follow(
        self,
        timeout: Optional[float],
        stdout_consumer: Optional[BytesConsumer] = None,
        stderr_consumer: Optional[BytesConsumer] = None,
    ) -> ExecResult:
        """Read raw REPL stdout and stderr until both EOF markers arrive.

        :param timeout: Inter-byte follow timeout in seconds, or None to wait indefinitely.
        :param stdout_consumer: Optional streaming stdout callback.
        :param stderr_consumer: Optional streaming stderr callback.
        :return: Raw stdout and stderr bytes.
        """
        stdout_data = self.read_until(
            b"\x04",
            timeout=timeout,
            consumer=stdout_consumer,
            interrupt_timeout=INTERRUPT_FOLLOW_GRACE,
        )
        if not stdout_data.endswith(b"\x04"):
            if self._interrupt_requested_at is not None:
                raise TransportInterrupted("interrupted waiting for stdout EOF")
            raise ReplSyncError("timeout waiting for stdout EOF")

        stderr_data = self.read_until(
            b"\x04",
            timeout=timeout,
            consumer=stderr_consumer,
            interrupt_timeout=INTERRUPT_FOLLOW_GRACE,
        )
        if not stderr_data.endswith(b"\x04"):
            if self._interrupt_requested_at is not None:
                raise TransportInterrupted("interrupted waiting for stderr EOF")
            raise ReplSyncError("timeout waiting for stderr EOF")

        self.clear_interrupt_request()
        self._await_prompt(self._config.operation_timeout)
        return ExecResult(stdout=stdout_data[:-1], stderr=stderr_data[:-1])

    def write_bytes(self, data: bytes) -> int:
        """Write raw bytes to the open serial stream.

        :param data: Bytes to write.
        :return: Number of bytes accepted by pyserial.
        """
        written = self._write_serial(data)
        return len(data) if written is None else int(written)

    def flush_output(self) -> None:
        """Flush pending serial output bytes when the backend supports it.

        :return: None
        """
        serial_port = self._ensure_serial()
        flush = getattr(serial_port, "flush", None)
        if callable(flush):
            try:
                flush()
            except (OSError, serial.SerialException) as exc:
                raise TransportError(str(exc)) from exc

    def raw_paste_write(self, command_bytes: bytes) -> None:
        """Write source bytes using raw-paste window flow control.

        :param command_bytes: UTF-8 encoded source bytes.
        :return: None
        """
        self._raw_paste_active = True
        try:
            self._raw_paste_write(command_bytes)
            self._raw_paste_active = False
        except ReplSyncError:
            deadline = self.operation_deadline
            self.operation_deadline = None
            try:
                self.abort_raw_paste()
            finally:
                self.operation_deadline = deadline
            raise

    def abort_raw_paste(self) -> bool:
        """Abort an incomplete source upload without executing it or soft-resetting."""
        if not self._raw_paste_active:
            return True
        self._write_serial(b"\x03\x03")
        data = self.read_until(
            b"\x04>", timeout=None, overall_timeout=min(2.0, self._config.operation_timeout)
        )
        if not data.endswith(b"\x04>"):
            self._in_raw_repl = False
            return False
        self._raw_paste_active = False
        self._prompt_ready = True
        self._in_raw_repl = True
        return True

    def _raw_paste_write(self, command_bytes: bytes) -> None:
        header = self.read_exact(2, timeout=self._config.operation_timeout)
        if len(header) != 2:
            raise ReplSyncError("raw paste header incomplete")

        window_size = struct.unpack("<H", header)[0]
        if window_size == 0:
            raise ReplSyncError("raw paste window size must be positive")
        window_remaining = window_size
        offset = 0
        deadline = time.monotonic() + self._config.operation_timeout

        while offset < len(command_bytes):
            while window_remaining == 0 or self._read_buffer or self._safe_in_waiting():
                response = self._read_serial(1)
                if response == b"":
                    if time.monotonic() >= deadline:
                        raise ReplSyncError("timed out waiting for raw paste window credit")
                    time.sleep(0.01)
                    continue
                if response == b"\x01":
                    window_remaining += window_size
                    deadline = time.monotonic() + self._config.operation_timeout
                elif response == b"\x04":
                    self._write_serial(b"\x04")
                    return
                else:
                    raise ReplSyncError("unexpected raw paste response: %r" % (response,))

            chunk = command_bytes[offset : offset + min(window_remaining, window_size)]
            written = self._write_serial(chunk)
            count = len(chunk) if written is None else written
            if count <= 0 or count > len(chunk):
                raise ReplSyncError("raw paste source write made no progress")
            offset += count
            window_remaining -= count

        self._write_serial(b"\x04")
        result = self.read_until(
            b"\x04",
            timeout=None,
            overall_timeout=self._config.operation_timeout,
        )
        if not result.endswith(b"\x04"):
            raise ReplSyncError("device did not acknowledge raw paste end")

    def drain_input(self, max_duration: float | None = 0.25) -> None:
        """Consume any pending bytes from the serial input buffer.

        :param max_duration: Maximum seconds to spend draining, or None for no bound.
        :return: None
        """
        serial_port = self._ensure_serial()
        reset_input = getattr(serial_port, "reset_input_buffer", None)
        if callable(reset_input):
            try:
                reset_input()
                self._read_buffer = b""
                return
            except (OSError, serial.SerialException):
                pass

        self._read_buffer = b""
        deadline = None if max_duration is None else time.monotonic() + max_duration
        pending = self._safe_in_waiting()
        while pending > 0:
            self._read_serial(pending)
            if deadline is not None and time.monotonic() >= deadline:
                break
            pending = self._safe_in_waiting()

    def in_waiting(self) -> int:
        """Return the number of bytes available from the serial port.

        :return: Count of pending bytes.
        """
        serial_port = self._ensure_serial()
        if hasattr(serial_port, "in_waiting"):
            return int(serial_port.in_waiting)
        return int(serial_port.inWaiting())

    def probe_connection(self) -> bool:
        """Verify that the serial backend can query the open device.

        The probe does not write bytes or consume device input. On Windows,
        querying ``in_waiting`` reaches the driver and reports a removed USB
        serial device through ``ClearCommError``.

        :return: True when the serial device is still reachable.
        """
        serial_port = self._ensure_serial()
        if not getattr(serial_port, "is_open", False):
            raise TransportError("serial port is not open")
        try:
            if hasattr(serial_port, "in_waiting"):
                int(serial_port.in_waiting)
            else:
                int(serial_port.inWaiting())
        except (OSError, serial.SerialException) as exc:
            raise TransportError(str(exc)) from exc
        return True

    def read_idle_output(self, max_bytes: int = 65536) -> bytes:
        """Read asynchronous raw-REPL output without consuming its next prompt.

        :param max_bytes: Maximum newly arrived bytes to consume.
        :return: Device output bytes excluding the preserved raw prompt.
        """
        self.probe_connection()
        buffered = self._read_buffer
        self._read_buffer = b""
        pending = min(self._safe_in_waiting(), max(0, max_bytes))
        incoming = self._read_serial(pending) if pending else b""
        data = buffered + incoming
        if not data:
            return b""

        return data

    def _safe_in_waiting(self) -> int:
        """Return pending bytes when supported, suppressing serial status failures.

        :return: Count of pending bytes, or 0 when unavailable.
        """
        try:
            return self.in_waiting()
        except (OSError, serial.SerialException):
            return 0

    def read_exact(self, size: int, timeout: float) -> bytes:
        """Read exactly the requested number of bytes or fail on timeout.

        :param size: Number of bytes to read.
        :param timeout: Overall timeout in seconds.
        :return: Read bytes.
        """
        deadline = time.monotonic() + timeout
        data = bytearray()

        while len(data) < size:
            chunk = self._read_serial(size - len(data))
            if chunk:
                data.extend(chunk)
                continue
            if time.monotonic() >= deadline:
                break

        return bytes(data)

    def _read_serial(self, size: int) -> bytes:
        """Read bytes without pyserial's Windows ClearCommError polling path.

        :param size: Maximum bytes to read.
        :return: Bytes returned by the serial backend.
        """
        if size <= 0:
            return b""
        if self._read_buffer:
            data = self._read_buffer[:size]
            self._read_buffer = self._read_buffer[size:]
            return data

        serial_port = self._ensure_serial()
        try:
            win32_data = self._read_serial_win32(serial_port, size)
            if win32_data is not None:
                return win32_data
            return serial_port.read(size)
        except (OSError, serial.SerialException) as exc:
            raise TransportError(str(exc)) from exc

    def _write_serial(self, data: bytes) -> int | None:
        """Write bytes while normalizing backend failures.

        :param data: Bytes sent to the serial backend.
        :return: Number of accepted bytes when provided by pyserial.
        """
        if self.operation_deadline is not None and time.monotonic() >= self.operation_deadline:
            raise ReplSyncError("serial operation deadline exceeded")
        serial_port = self._ensure_serial()
        try:
            return serial_port.write(data)
        except (OSError, serial.SerialException) as exc:
            raise TransportError(str(exc)) from exc

    def _read_serial_win32(self, serial_port: object, size: int) -> Optional[bytes]:
        """Read from pyserial's Windows handle without calling ClearCommError.

        :param serial_port: pyserial serial object.
        :param size: Maximum bytes to read.
        :return: Bytes when the Windows backend is detected, otherwise None.
        """
        win32 = getattr(getattr(serial, "serialwin32", None), "win32", None)
        port_handle = getattr(serial_port, "_port_handle", None)
        overlapped_read = getattr(serial_port, "_overlapped_read", None)
        if win32 is None or port_handle is None or overlapped_read is None:
            return None
        if not getattr(serial_port, "is_open", False):
            raise serial.PortNotOpenError()

        win32.ResetEvent(overlapped_read.hEvent)
        buffer = ctypes.create_string_buffer(size)
        read_count = win32.DWORD()
        read_ok = win32.ReadFile(
            port_handle,
            buffer,
            size,
            ctypes.byref(read_count),
            ctypes.byref(overlapped_read),
        )
        if not read_ok and win32.GetLastError() not in (
            win32.ERROR_SUCCESS,
            win32.ERROR_IO_PENDING,
        ):
            raise serial.SerialException("ReadFile failed ({!r})".format(ctypes.WinError()))

        result_ok = win32.GetOverlappedResult(
            port_handle,
            ctypes.byref(overlapped_read),
            ctypes.byref(read_count),
            True,
        )
        if not result_ok and win32.GetLastError() != win32.ERROR_OPERATION_ABORTED:
            raise serial.SerialException(
                "GetOverlappedResult failed ({!r})".format(ctypes.WinError())
            )
        return bytes(buffer.raw[: read_count.value])

    def _ensure_serial(self) -> serial.Serial:
        """Return the opened serial object or raise.

        :return: Opened serial object.
        """
        if self._serial is None:
            raise TransportError("serial port is not open")
        return self._serial
