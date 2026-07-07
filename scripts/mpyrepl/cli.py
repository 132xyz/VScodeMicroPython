"""Command-line parsing for the standalone REPL spike.

:return: None
"""

from __future__ import annotations

import argparse


def build_parser() -> argparse.ArgumentParser:
    """Create the command-line parser.

    :return: Configured parser.
    """
    parser = argparse.ArgumentParser(description="Standalone MicroPython raw REPL spike")
    parser.add_argument("--port", default="", help="Serial port or URL, for example COM4")
    parser.add_argument("--baudrate", type=int, default=115200, help="Serial baud rate")
    parser.add_argument(
        "--read-timeout",
        type=float,
        default=0.1,
        help="Per-read timeout in seconds",
    )
    parser.add_argument(
        "--operation-timeout",
        type=float,
        default=10.0,
        help="Overall timeout for protocol operations in seconds",
    )
    parser.add_argument(
        "--soft-reset-on-connect",
        action="store_true",
        help="Soft reset while entering raw REPL",
    )

    subparsers = parser.add_subparsers(dest="command", required=True)

    exec_parser = subparsers.add_parser("exec", help="Execute one block of source code")
    exec_parser.add_argument("--code", required=True, help="Python source to execute")
    exec_parser.add_argument(
        "--follow-timeout",
        type=float,
        default=10.0,
        help="Timeout while waiting for stdout and stderr EOF markers",
    )

    session_parser = subparsers.add_parser(
        "session-probe",
        help="Execute two code blocks within one raw REPL session",
    )
    session_parser.add_argument("--first", required=True, help="First Python source block")
    session_parser.add_argument("--second", required=True, help="Second Python source block")
    session_parser.add_argument(
        "--follow-timeout",
        type=float,
        default=10.0,
        help="Timeout while waiting for stdout and stderr EOF markers",
    )

    prompt_parser = subparsers.add_parser(
        "prompt-once",
        help="Open one prompt_toolkit prompt, execute the entered code, then exit",
    )
    prompt_parser.add_argument(
        "--follow-timeout",
        type=float,
        default=10.0,
        help="Timeout while waiting for stdout and stderr EOF markers",
    )

    async_parser = subparsers.add_parser(
        "async-repl",
        help="Run a minimal async prompt_toolkit REPL loop",
    )
    async_parser.add_argument(
        "--follow-timeout",
        type=float,
        default=10.0,
        help="Timeout while waiting for stdout and stderr EOF markers",
    )
    async_parser.add_argument(
        "--control-file",
        default="",
        help="Optional file path used for out-of-band control commands",
    )
    async_parser.add_argument(
        "--stub-root",
        default="",
        help="Optional stub root used for bare top-level module completion",
    )
    async_parser.add_argument(
        "--completion-root",
        dest="completion_roots",
        action="append",
        default=[],
        help="Additional completion root; may be specified more than once",
    )
    async_parser.add_argument(
        "--dir-query-timeout",
        type=float,
        default=2.0,
        help="Timeout in seconds for device-backed dir() completion queries",
    )
    async_parser.add_argument(
        "--helper-version",
        default="",
        help="Version string exposed by the injected REPL helper",
    )

    manager_parser = subparsers.add_parser(
        "manager",
        help="Run the hidden serial manager RPC server",
    )
    manager_parser.add_argument("--host", default="127.0.0.1", help="Manager bind host")
    manager_parser.add_argument(
        "--manager-port",
        dest="manager_port",
        type=int,
        default=0,
        help="Manager bind port, or 0 for an OS-assigned port",
    )
    manager_parser.add_argument("--token", default="", help="Manager authentication token")
    manager_parser.add_argument(
        "--follow-timeout",
        type=float,
        default=None,
        help="Timeout while waiting for stdout and stderr EOF markers; defaults to no timeout for user code",
    )
    manager_parser.add_argument(
        "--stub-root",
        default="",
        help="Optional stub root used for completion",
    )
    manager_parser.add_argument(
        "--completion-root",
        dest="completion_roots",
        action="append",
        default=[],
        help="Additional completion root; may be specified more than once",
    )
    manager_parser.add_argument(
        "--dir-query-timeout",
        type=float,
        default=2.0,
        help="Timeout in seconds for device-backed dir() completion queries",
    )
    manager_parser.add_argument(
        "--helper-version",
        default="",
        help="Version string exposed by the injected REPL helper",
    )

    repl_client_parser = subparsers.add_parser(
        "repl-client",
        help="Run a terminal client connected to a hidden serial manager",
    )
    repl_client_parser.add_argument(
        "--endpoint",
        required=True,
        help="Manager endpoint, for example 127.0.0.1:50000",
    )
    repl_client_parser.add_argument("--token", required=True, help="Manager authentication token")

    subparsers.add_parser("ports", help="List host serial ports as JSON")

    fs_parser = subparsers.add_parser("fs", help="Run one filesystem operation as JSON")
    fs_parser.add_argument("--op", required=True, help="Filesystem operation name")
    fs_parser.add_argument("--path", default="", help="Device path")
    fs_parser.add_argument("--src", default="", help="Source device path for rename")
    fs_parser.add_argument("--dst", default="", help="Destination device path for rename")
    fs_parser.add_argument("--local-path", default="", help="Local file path for upload/download")
    fs_parser.add_argument("--source", default="", help="Python source for exec operation")
    fs_parser.add_argument(
        "--no-recursive",
        action="store_true",
        help="Do not recursively remove directories",
    )
    fs_parser.add_argument(
        "--progress",
        action="store_true",
        help="Emit JSONL progress events for write_file operations",
    )

    subparsers.add_parser("interrupt", help="Send Ctrl-C to the configured serial port")
    subparsers.add_parser("soft-reset", help="Trigger a raw-mode soft reset")
    return parser


def parse_args() -> argparse.Namespace:
    """Parse command-line arguments.

    :return: Parsed namespace.
    """
    return build_parser().parse_args()
