"""Unit tests for transport diagnostics.

:return: None
"""

from __future__ import annotations

import os
import struct
import sys
import unittest
from unittest import mock


CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
if CURRENT_DIR not in sys.path:
    sys.path.insert(0, CURRENT_DIR)

import bootstrap

bootstrap.configure_import_path()

from models import ExecResult, ReplConfig
from transport import SerialReplTransport, TransportError
import transport as transport_module


class _FakeSerial:
    """Minimal serial stub used for transport error tests.

    :return: None
    """

    def __init__(self) -> None:
        """Initialize captured writes.

        :return: None
        """
        self.writes: list[bytes] = []
        self.read_chunks: list[bytes] = []
        self.is_open = True
        self.closed = False
        self.flushes = 0

    @property
    def in_waiting(self) -> int:
        """Return the number of queued read bytes.

        :return: Pending byte count.
        """
        return len(self.read_chunks[0]) if self.read_chunks else 0

    def write(self, data: bytes) -> None:
        """Record written bytes.

        :param data: Outgoing bytes.
        :return: None
        """
        self.writes.append(data)

    def flush(self) -> None:
        self.flushes += 1

    def read(self, size: int) -> bytes:
        """Return queued bytes.

        :param size: Requested byte count.
        :return: Returned bytes.
        """
        if not self.read_chunks:
            return b""
        chunk = self.read_chunks.pop(0)
        if len(chunk) > size:
            self.read_chunks.insert(0, chunk[size:])
            return chunk[:size]
        return chunk

    def close(self) -> None:
        """Mark the serial stub as closed.

        :return: None
        """
        self.closed = True
        self.is_open = False

    def open(self) -> None:
        """Mark the serial stub as opened.

        :return: None
        """
        self.is_open = True


class _ResettableFakeSerial(_FakeSerial):
    def __init__(self) -> None:
        super().__init__()
        self.reset_input_calls = 0

    def reset_input_buffer(self) -> None:
        self.reset_input_calls += 1
        self.read_chunks = []


class _ClearCommErrorSerial(_FakeSerial):
    @property
    def in_waiting(self) -> int:
        raise transport_module.serial.SerialException("ClearCommError failed")


class _LegacyWaitingSerial:
    def __init__(self, pending: int) -> None:
        self._pending = pending

    def inWaiting(self) -> int:
        return self._pending


class _ContinuousSerial:
    def __init__(self) -> None:
        self.read_calls = 0

    @property
    def in_waiting(self) -> int:
        return 1

    def read(self, size: int) -> bytes:
        self.read_calls += 1
        return b"x"


class TransportBehaviorTests(unittest.TestCase):
    """Cover transport diagnostics for raw REPL entry failures.

    :return: None
    """

    def test_enter_raw_repl_error_includes_observed_bytes(self) -> None:
        """Raw REPL entry errors should surface captured device bytes.

        :return: None
        """
        transport = SerialReplTransport(ReplConfig(port="COM4"))
        transport._serial = _FakeSerial()
        transport.drain_input = lambda: None
        transport.read_until = lambda *args, **kwargs: b"garbage prompt"

        with self.assertRaisesRegex(transport_module.TransportError, r"observed=b'garbage prompt'"):
            transport.enter_raw_repl(soft_reset=False)

    def test_enter_raw_repl_soft_reset_path_covers_success_and_banner_failure(self) -> None:
        transport = SerialReplTransport(ReplConfig(port="COM4"))
        transport._serial = _FakeSerial()
        transport.drain_input = lambda: None
        responses = iter(
            [
                b"raw REPL; CTRL-B to exit\r\n>",
                b"soft reboot\r\n",
                b"raw REPL; CTRL-B to exit\r\n",
            ]
        )
        transport.read_until = lambda *args, **kwargs: next(responses)

        transport.enter_raw_repl(soft_reset=True)
        self.assertTrue(transport._in_raw_repl)
        self.assertEqual(transport._serial.writes, [b"\r\x03", b"\r\x01", b"\x04"])

        broken = SerialReplTransport(ReplConfig(port="COM4"))
        broken._serial = _FakeSerial()
        broken.drain_input = lambda: None
        broken_responses = iter([b"raw REPL; CTRL-B to exit\r\n>", b"missing banner"])
        broken.read_until = lambda *args, **kwargs: next(broken_responses)

        with self.assertRaisesRegex(transport_module.TransportError, "soft reboot banner"):
            broken.enter_raw_repl(soft_reset=True)

    def test_open_and_close_manage_serial_handle(self) -> None:
        serial_stub = _FakeSerial()
        transport = SerialReplTransport(ReplConfig(port="loop://"))

        with mock.patch("transport.serial.serial_for_url", return_value=serial_stub) as serial_for_url:
            transport.open()
            transport.open()

        serial_for_url.assert_called_once()
        self.assertIs(transport._serial, serial_stub)

        transport.close()
        self.assertIsNone(transport._serial)
        self.assertFalse(transport._in_raw_repl)
        self.assertTrue(serial_stub.closed)

    def test_context_manager_opens_and_closes_transport(self) -> None:
        serial_stub = _FakeSerial()
        transport = SerialReplTransport(ReplConfig(port="loop://"))

        with mock.patch("transport.serial.serial_for_url", return_value=serial_stub):
            with transport as opened:
                self.assertIs(opened, transport)
                self.assertIs(transport._serial, serial_stub)

        self.assertIsNone(transport._serial)
        self.assertTrue(serial_stub.closed)

    def test_read_until_streams_chunks_and_handles_timeouts(self) -> None:
        transport = SerialReplTransport(ReplConfig(port="COM4", read_timeout=0.01, operation_timeout=0.05))
        serial_stub = _FakeSerial()
        serial_stub.read_chunks = [b"ab", b"c", b"END"]
        transport._serial = serial_stub
        streamed: list[bytes] = []

        self.assertEqual(
            transport.read_until(b"END", timeout=0.01, consumer=streamed.append),
            b"abcEND",
        )
        self.assertEqual(streamed, [b"a", b"bc"])

        serial_stub.read_chunks = [b"xy", b"END"]
        streamed = []
        self.assertEqual(
            transport.read_until(
                b"END",
                timeout=0.01,
                consumer=streamed.append,
                include_ending_in_consumer=True,
            ),
            b"xyEND",
        )
        self.assertEqual(streamed, [b"xyEND"])

        serial_stub.read_chunks = [b"out\x04err\x04"]
        self.assertEqual(transport.read_until(b"\x04", timeout=0.01), b"out\x04")
        self.assertEqual(transport.read_until(b"\x04", timeout=0.01), b"err\x04")

        transport._serial = _FakeSerial()
        with mock.patch("transport.time.sleep", return_value=None):
            self.assertEqual(transport.read_until(b"END", timeout=0.0), b"")
            self.assertEqual(transport.read_until(b"END", timeout=None, overall_timeout=0.0), b"")
            transport._interrupt_requested_at = 0.0
            self.assertEqual(
                transport.read_until(b"END", timeout=None, interrupt_timeout=0.0),
                b"",
            )

    def test_read_until_does_not_poll_windows_in_waiting(self) -> None:
        transport = SerialReplTransport(ReplConfig(port="COM4", read_timeout=0.01))
        serial_stub = _ClearCommErrorSerial()
        serial_stub.read_chunks = [b"O", b"K"]
        transport._serial = serial_stub

        self.assertEqual(transport.read_until(b"OK", timeout=0.01), b"OK")

    def test_soft_reset_requires_raw_mode_and_streams_banner(self) -> None:
        transport = SerialReplTransport(ReplConfig(port="COM4"))
        transport._serial = _FakeSerial()

        with self.assertRaisesRegex(transport_module.TransportError, "soft reset requires raw repl"):
            transport.soft_reset()

        transport._in_raw_repl = True
        streamed: list[bytes] = []
        responses = iter(
            [
                b">",
                b"soft reboot\r\n",
                b"raw REPL; CTRL-B to exit\r\n",
            ]
        )

        def fake_read_until(*args, consumer=None, include_ending_in_consumer=False, **kwargs):
            data = next(responses)
            if consumer is not None and include_ending_in_consumer:
                consumer(data)
            return data

        transport.read_until = fake_read_until
        transport.soft_reset(output_consumer=streamed.append)

        self.assertEqual(streamed, [b"soft reboot\r\n", b"raw REPL; CTRL-B to exit\r\n"])
        self.assertEqual(transport._serial.writes, [b"\x04"])

        prompt_failure = SerialReplTransport(ReplConfig(port="COM4"))
        prompt_failure._serial = _FakeSerial()
        prompt_failure._in_raw_repl = True
        prompt_failure.read_until = lambda *args, **kwargs: b"not ready"
        with self.assertRaisesRegex(transport_module.TransportError, "raw prompt not ready"):
            prompt_failure.soft_reset()

        reboot_failure = SerialReplTransport(ReplConfig(port="COM4"))
        reboot_failure._serial = _FakeSerial()
        reboot_failure._in_raw_repl = True
        reboot_responses = iter([b">", b"missing reboot"])
        reboot_failure.read_until = lambda *args, **kwargs: next(reboot_responses)
        with self.assertRaisesRegex(transport_module.TransportError, "soft reboot banner"):
            reboot_failure.soft_reset()

        restore_failure = SerialReplTransport(ReplConfig(port="COM4"))
        restore_failure._serial = _FakeSerial()
        restore_failure._in_raw_repl = True
        restore_responses = iter([b">", b"soft reboot\r\n", b"missing prompt"])
        restore_failure.read_until = lambda *args, **kwargs: next(restore_responses)
        with self.assertRaisesRegex(transport_module.TransportError, "raw repl prompt not restored"):
            restore_failure.soft_reset()

    def test_exec_raw_no_follow_supports_raw_paste_and_plain_fallback(self) -> None:
        transport = SerialReplTransport(ReplConfig(port="COM4"))
        transport._serial = _FakeSerial()
        transport.read_until = lambda *args, **kwargs: b">"
        transport.read_exact = lambda size, timeout: b"R\x01"
        transport.raw_paste_write = mock.Mock()

        transport.exec_raw_no_follow(b"print(1)")
        transport.raw_paste_write.assert_called_once_with(b"print(1)")

        transport = SerialReplTransport(ReplConfig(port="COM4"))
        transport._serial = _FakeSerial()
        transport._use_raw_paste = False
        transport.read_until = lambda *args, **kwargs: b">"
        transport.read_exact = lambda size, timeout: b"OK"

        transport.exec_raw_no_follow(b"print(1)")
        self.assertEqual(transport._serial.writes, [b"print(1)", b"\x04"])

    def test_follow_and_ensure_serial_cover_success_and_errors(self) -> None:
        transport = SerialReplTransport(ReplConfig(port="COM4"))
        timeouts = []
        responses = iter([b"out\x04", b"err\x04"])
        transport.read_until = lambda *args, **kwargs: (
            timeouts.append(kwargs.get("timeout")),
            next(responses),
        )[-1]
        self.assertEqual(
            transport.follow(None),
            transport_module.ExecResult(stdout=b"out", stderr=b"err"),
        )
        self.assertEqual(timeouts, [None, None])

        transport = SerialReplTransport(ReplConfig(port="COM4"))
        transport.read_until = lambda *args, **kwargs: b"out"
        with self.assertRaisesRegex(transport_module.TransportError, "stdout EOF"):
            transport.follow(1.0)

        transport = SerialReplTransport(ReplConfig(port="COM4"))
        responses = iter([b"out\x04", b"err"])
        transport.read_until = lambda *args, **kwargs: next(responses)
        with self.assertRaisesRegex(transport_module.TransportError, "stderr EOF"):
            transport.follow(1.0)

        transport = SerialReplTransport(ReplConfig(port="COM4"))
        transport._interrupt_requested_at = 1.0
        transport.read_until = lambda *args, **kwargs: b"partial"
        with self.assertRaisesRegex(transport_module.TransportInterrupted, "stdout EOF"):
            transport.follow(None)

        with self.assertRaisesRegex(transport_module.TransportError, "serial port is not open"):
            transport._ensure_serial()

    def test_exec_raw_delegates_and_exec_raw_no_follow_surfaces_protocol_failures(self) -> None:
        transport = SerialReplTransport(ReplConfig(port="COM4"))
        transport.exec_raw_no_follow = mock.Mock()
        transport.follow = mock.Mock(
            return_value=transport_module.ExecResult(stdout=b"ok", stderr=b"")
        )

        result = transport.exec_raw("print(1)", timeout=2.0)
        self.assertEqual(result, transport_module.ExecResult(stdout=b"ok", stderr=b""))
        transport.exec_raw_no_follow.assert_called_once_with(b"print(1)")
        transport.follow.assert_called_once_with(2.0, stdout_consumer=None, stderr_consumer=None)

        transport = SerialReplTransport(ReplConfig(port="COM4"))
        transport._serial = _FakeSerial()
        transport._use_raw_paste = False
        transport.read_until = lambda *args, **kwargs: b">"
        transport.read_exact = lambda size, timeout: b"NO"
        with self.assertRaisesRegex(transport_module.TransportError, "could not execute command"):
            transport.exec_raw_no_follow(b"print(1)")

        transport = SerialReplTransport(ReplConfig(port="COM4"))
        transport._serial = _FakeSerial()
        transport.read_until = lambda *args, **kwargs: b"not a prompt"
        with self.assertRaisesRegex(transport_module.TransportError, "raw prompt before execution"):
            transport.exec_raw_no_follow(b"print(1)")

        transport = SerialReplTransport(ReplConfig(port="COM4"))
        transport._serial = _FakeSerial()
        responses = iter([b">", b"broken fallback"])
        transport.read_until = lambda *args, **kwargs: next(responses)
        transport.read_exact = lambda size, timeout: b"??"
        with self.assertRaisesRegex(transport_module.TransportError, "fallback mode"):
            transport.exec_raw_no_follow(b"print(1)")

    def test_raw_paste_write_uses_credit_and_acknowledges_end(self) -> None:
        transport = SerialReplTransport(ReplConfig(port="COM4", operation_timeout=1.0))
        serial_stub = _FakeSerial()
        serial_stub.read_chunks = [b"\x01"]
        transport._serial = serial_stub
        transport.read_exact = lambda size, timeout: struct.pack("<H", 2)
        transport.read_until = lambda *args, **kwargs: b"\x04"

        transport.raw_paste_write(b"abcd")

        self.assertEqual(serial_stub.writes, [b"ab", b"cd", b"\x04"])

        broken_header = SerialReplTransport(ReplConfig(port="COM4", operation_timeout=1.0))
        broken_header._serial = _FakeSerial()
        broken_header.read_exact = lambda size, timeout: b"\x01"
        with self.assertRaisesRegex(transport_module.TransportError, "header incomplete"):
            broken_header.raw_paste_write(b"abc")

        broken_response = SerialReplTransport(ReplConfig(port="COM4", operation_timeout=1.0))
        broken_response._serial = _FakeSerial()
        broken_response.read_exact = lambda size, timeout: struct.pack("<H", 2)
        broken_response._serial.read_chunks = [b"X"]
        with self.assertRaisesRegex(
            transport_module.TransportError, "unexpected raw paste response"
        ):
            broken_response.raw_paste_write(b"abc")

        early_eof = SerialReplTransport(ReplConfig(port="COM4", operation_timeout=1.0))
        early_eof._serial = _FakeSerial()
        early_eof.read_exact = lambda size, timeout: struct.pack("<H", 2)
        early_eof._serial.read_chunks = [b"\x04"]
        early_eof.raw_paste_write(b"abc")
        self.assertEqual(early_eof._serial.writes, [b"ab", b"\x04"])

        missing_ack = SerialReplTransport(ReplConfig(port="COM4", operation_timeout=1.0))
        missing_ack._serial = _FakeSerial()
        missing_ack.read_exact = lambda size, timeout: struct.pack("<H", 8)
        missing_ack.read_until = lambda *args, **kwargs: b""
        with self.assertRaisesRegex(transport_module.TransportError, "acknowledge raw paste end"):
            missing_ack.raw_paste_write(b"abc")

        timed_out_credit = SerialReplTransport(ReplConfig(port="COM4", operation_timeout=0.01))
        timed_out_credit._serial = _FakeSerial()
        timed_out_credit.read_exact = lambda size, timeout: struct.pack("<H", 0)
        with mock.patch("transport.time.sleep", return_value=None):
            with self.assertRaisesRegex(transport_module.TransportError, "window credit"):
                timed_out_credit.raw_paste_write(b"abc")

    def test_drain_input_in_waiting_and_read_exact_work_with_buffered_serial(self) -> None:
        transport = SerialReplTransport(ReplConfig(port="COM4", operation_timeout=0.1))
        serial_stub = _FakeSerial()
        serial_stub.read_chunks = [b"abc", b"def"]
        transport._serial = serial_stub

        self.assertEqual(transport.in_waiting(), 3)
        self.assertEqual(transport.read_exact(4, timeout=0.1), b"abcd")

        self.assertEqual(transport.read_exact(10, timeout=0.0), b"ef")

        serial_stub.read_chunks = [b"12", b"34"]
        transport.drain_input()
        self.assertEqual(serial_stub.read_chunks, [])

        resettable_serial = _ResettableFakeSerial()
        resettable_serial.read_chunks = [b"pending"]
        transport._serial = resettable_serial
        transport.drain_input()
        self.assertEqual(resettable_serial.reset_input_calls, 1)
        self.assertEqual(resettable_serial.read_chunks, [])

        continuous_serial = _ContinuousSerial()
        transport._serial = continuous_serial
        with mock.patch("transport.time.monotonic", side_effect=[0.0, 0.1, 0.3]):
            transport.drain_input(max_duration=0.2)
        self.assertEqual(continuous_serial.read_calls, 2)

    def test_write_bytes_and_flush_output_delegate_to_serial(self) -> None:
        transport = SerialReplTransport(ReplConfig(port="COM4"))
        serial_stub = _FakeSerial()
        transport._serial = serial_stub

        self.assertEqual(transport.write_bytes(b"abc"), 3)
        transport.flush_output()

        self.assertEqual(serial_stub.writes, [b"abc"])
        self.assertEqual(serial_stub.flushes, 1)

    def test_interrupt_exit_and_describe_bytes(self) -> None:
        transport = SerialReplTransport(ReplConfig(port="COM4"))
        transport._serial = _FakeSerial()
        transport._in_raw_repl = True

        transport.interrupt()
        transport.exit_raw_repl()

        self.assertEqual(transport._serial.writes, [b"\x03", b"\r\x02"])
        self.assertFalse(transport._in_raw_repl)
        self.assertEqual(
            transport_module._describe_observed_bytes(b"123456789", limit=4),
            "<9 bytes total, tail=b'6789'>",
        )

        transport = SerialReplTransport(ReplConfig(port="COM4"))
        serial_stub = _FakeSerial()
        serial_stub.write = mock.Mock(side_effect=transport_module.serial.SerialException("write failed"))
        transport._serial = serial_stub
        transport._in_raw_repl = True
        transport.exit_raw_repl()
        self.assertFalse(transport._in_raw_repl)

    def test_in_waiting_falls_back_to_legacy_api(self) -> None:
        transport = SerialReplTransport(ReplConfig(port="COM4"))
        transport._serial = _LegacyWaitingSerial(7)
        self.assertEqual(transport.in_waiting(), 7)


if __name__ == "__main__":
    unittest.main()
