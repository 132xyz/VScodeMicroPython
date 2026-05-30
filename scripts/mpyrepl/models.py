"""Data models for the standalone REPL spike.

:return: None
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class ReplConfig:
    """Runtime configuration for the serial REPL transport.

    :param port: Serial port name or URL.
    :param baudrate: Serial baud rate.
    :param read_timeout: Per-read timeout in seconds.
    :param operation_timeout: Overall timeout for protocol operations.
    :param soft_reset_on_connect: Whether entering raw REPL should soft-reset first.
    """

    port: str
    baudrate: int = 115200
    read_timeout: float = 0.1
    operation_timeout: float = 10.0
    soft_reset_on_connect: bool = False


@dataclass(frozen=True)
class ExecResult:
    """Captured bytes from a raw REPL execution.

    :param stdout: Raw stdout bytes before decoding.
    :param stderr: Raw stderr bytes before decoding.
    """

    stdout: bytes
    stderr: bytes
