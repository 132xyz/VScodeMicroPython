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


class _LegacyWaitingSerial:
    def __init__(self, pending: int) -> None:
        self._pending = pending

    def inWaiting(self) -> int:
        return self._pending


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
        responses = iter([b"out\x04", b"err\x04"])
        transport.read_until = lambda *args, **kwargs: next(responses)
        self.assertEqual(
            transport.follow(1.0),
            transport_module.ExecResult(stdout=b"out", stderr=b"err"),
        )

        transport = SerialReplTransport(ReplConfig(port="COM4"))
        transport.read_until = lambda *args, **kwargs: b"out"
        with self.assertRaisesRegex(transport_module.TransportError, "stdout EOF"):
            transport.follow(1.0)

        transport = SerialReplTransport(ReplConfig(port="COM4"))
        responses = iter([b"out\x04", b"err"])
        transport.read_until = lambda *args, **kwargs: next(responses)
        with self.assertRaisesRegex(transport_module.TransportError, "stderr EOF"):
            transport.follow(1.0)

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
        transport.in_waiting = lambda: 1 if serial_stub.read_chunks else 0
        transport.read_until = lambda *args, **kwargs: b"\x04"

        transport.raw_paste_write(b"abcd")

        self.assertEqual(serial_stub.writes, [b"abcd", b"\x04"])

        broken_header = SerialReplTransport(ReplConfig(port="COM4", operation_timeout=1.0))
        broken_header._serial = _FakeSerial()
        broken_header.read_exact = lambda size, timeout: b"\x01"
        with self.assertRaisesRegex(transport_module.TransportError, "header incomplete"):
            broken_header.raw_paste_write(b"abc")

        broken_response = SerialReplTransport(ReplConfig(port="COM4", operation_timeout=1.0))
        broken_response._serial = _FakeSerial()
        broken_response.read_exact = lambda size, timeout: struct.pack("<H", 2)
        broken_response.in_waiting = lambda: 1
        broken_response._serial.read_chunks = [b"X"]
        with self.assertRaisesRegex(
            transport_module.TransportError, "unexpected raw paste response"
        ):
            broken_response.raw_paste_write(b"abc")

    def test_drain_input_in_waiting_and_read_exact_work_with_buffered_serial(self) -> None:
        transport = SerialReplTransport(ReplConfig(port="COM4", operation_timeout=0.1))
        serial_stub = _FakeSerial()
        serial_stub.read_chunks = [b"abc", b"def"]
        transport._serial = serial_stub

        self.assertEqual(transport.in_waiting(), 3)
        self.assertEqual(transport.read_exact(4, timeout=0.1), b"abcd")

        serial_stub.read_chunks = [b"12", b"34"]
        transport.drain_input()
        self.assertEqual(serial_stub.read_chunks, [])

    def test_interrupt_exit_and_describe_bytes(self) -> None:
        transport = SerialReplTransport(ReplConfig(port="COM4"))
        transport._serial = _FakeSerial()
        transport._in_raw_repl = True

        transport.interrupt()
        transport.exit_raw_repl()

        self.assertEqual(transport._serial.writes, [b"\x03", b"\r\x02"])
        self.assertFalse(transport._in_raw_repl)

    def test_in_waiting_falls_back_to_legacy_api(self) -> None:
        transport = SerialReplTransport(ReplConfig(port="COM4"))
        transport._serial = _LegacyWaitingSerial(7)
        self.assertEqual(transport.in_waiting(), 7)


if __name__ == "__main__":
    unittest.main()