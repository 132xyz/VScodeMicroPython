"""Top-level command dispatch for mpyrepl."""

from __future__ import annotations

import asyncio
import json
import sys

from mpyrepl.cli import parse_args
from mpyrepl.clients.repl import run_repl_client
from mpyrepl.manager.server import run_manager
from mpyrepl.repl.async_runner import (
    ensure_python_version,
    run_async_repl,
    run_exec,
    run_interrupt,
    run_prompt_once,
    run_session_probe,
    run_soft_reset,
)
from mpyrepl.runtime.filesystem import (
    PROGRESS_MARKER,
    DeviceFsClient,
    FsOperationError,
    list_serial_ports,
    response_payload,
    run_fs_operation,
)
from mpyrepl.runtime.models import ReplConfig
from mpyrepl.runtime.transport import SerialReplTransport, TransportError


def run_ports() -> int:
    """List host serial ports as one JSON response line."""
    try:
        data = list_serial_ports()
        print(json.dumps(response_payload("", True, data=data), ensure_ascii=False))
        return 0
    except Exception as exc:
        print(json.dumps(response_payload("", False, error=str(exc), code="error"), ensure_ascii=False))
        return 1


def write_fs_progress_event(event: dict) -> None:
    """Write one machine-readable filesystem progress event."""
    print(PROGRESS_MARKER + json.dumps(event, ensure_ascii=False), flush=True)


def run_fs_cli(config: ReplConfig, args) -> int:
    """Run one filesystem operation from the command line."""
    payload = {
        "op": args.op,
        "path": args.path,
        "src": args.src,
        "dst": args.dst,
        "local_path": args.local_path,
        "source": args.source,
        "recursive": not args.no_recursive,
    }
    if getattr(args, "progress", False) and args.op == "write_file":
        payload["progress_callback"] = write_fs_progress_event

    transport = SerialReplTransport(config)
    try:
        transport.open()
        transport.enter_raw_repl(soft_reset=config.soft_reset_on_connect)
        client = DeviceFsClient(transport, timeout=config.operation_timeout)
        data = run_fs_operation(client, args.op, payload)
        print(json.dumps(response_payload("", True, data=data), ensure_ascii=False))
        return 0
    except FsOperationError as exc:
        print(json.dumps(response_payload("", False, error=str(exc), code=exc.code), ensure_ascii=False))
        return 1
    except Exception as exc:
        print(json.dumps(response_payload("", False, error=str(exc), code="error"), ensure_ascii=False))
        return 1
    finally:
        try:
            transport.exit_raw_repl()
        except Exception:
            pass
        transport.close()


def main() -> int:
    """Parse arguments and execute the selected command."""
    ensure_python_version()
    args = parse_args()
    if args.command == "ports":
        return run_ports()
    if args.command == "repl-client":
        return run_repl_client(args.endpoint, args.token)
    if not args.port:
        sys.stderr.write("[mpyrepl] --port is required for %s\n" % (args.command,))
        sys.stderr.flush()
        return 2

    config = ReplConfig(
        port=args.port,
        baudrate=args.baudrate,
        read_timeout=args.read_timeout,
        operation_timeout=args.operation_timeout,
        soft_reset_on_connect=args.soft_reset_on_connect,
    )

    try:
        if args.command == "exec":
            return run_exec(config, args.code, args.follow_timeout)
        if args.command == "session-probe":
            return run_session_probe(config, args.first, args.second, args.follow_timeout)
        if args.command == "prompt-once":
            return run_prompt_once(config, args.follow_timeout)
        if args.command == "async-repl":
            return asyncio.run(
                run_async_repl(
                    config,
                    args.follow_timeout,
                    args.control_file,
                    args.stub_root,
                    args.completion_roots,
                    args.dir_query_timeout,
                    args.helper_version,
                )
            )
        if args.command == "manager":
            return run_manager(
                config,
                host=args.host,
                port=args.manager_port,
                token=args.token,
                follow_timeout=args.follow_timeout,
                stub_root=args.stub_root,
                completion_roots=args.completion_roots,
                dir_query_timeout=args.dir_query_timeout,
                helper_version=args.helper_version,
                session_file=args.session_file,
                owner_version=args.owner_version,
                script_path=args.script_path,
            )
        if args.command == "soft-reset":
            return run_soft_reset(config)
        if args.command == "interrupt":
            return run_interrupt(config)
        if args.command == "fs":
            return run_fs_cli(config, args)
        raise ValueError("unsupported command: %s" % (args.command,))
    except TransportError as exc:
        sys.stderr.write("[mpyrepl] %s\n" % (exc,))
        sys.stderr.flush()
        return 2
    except RuntimeError as exc:
        sys.stderr.write("[mpyrepl] %s\n" % (exc,))
        sys.stderr.flush()
        return 3
