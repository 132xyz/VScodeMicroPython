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

        with self.assertRaisesRegex(TransportError, r"observed=b'garbage prompt'"):
            transport.enter_raw_repl(soft_reset=False)

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

        with self.assertRaisesRegex(TransportError, "soft reset requires raw repl"):
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
        self.assertEqual(transport.follow(1.0), ExecResult(stdout=b"out", stderr=b"err"))

        transport = SerialReplTransport(ReplConfig(port="COM4"))
        transport.read_until = lambda *args, **kwargs: b"out"
        with self.assertRaisesRegex(TransportError, "stdout EOF"):
            transport.follow(1.0)

        with self.assertRaisesRegex(TransportError, "serial port is not open"):
            transport._ensure_serial()

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


if __name__ == "__main__":
    unittest.main()