"""Raw REPL execution and legacy async REPL support.

:return: None
"""

from __future__ import annotations

import asyncio
import json
import signal
import sys
from pathlib import Path
from typing import Callable

from prompt_toolkit.document import Document
from prompt_toolkit.patch_stdout import patch_stdout

from mpyrepl.completion.device import query_device_attributes
from mpyrepl.completion.engine import ReplCompleter
from mpyrepl.completion.state import ReplSessionSymbols
from mpyrepl.repl.control import FileControlChannel
from mpyrepl.repl.semantics import build_helper_source, instrument_source
from mpyrepl.repl.session import PROMPT_EXIT, PROMPT_SOFT_RESET, build_prompt_session
from mpyrepl.runtime.decode import Utf8StreamDecoder
from mpyrepl.runtime.filesystem import (
    DeviceFsClient,
    FsOperationError,
    response_payload,
    run_fs_operation,
)
from mpyrepl.runtime.models import ReplConfig
from mpyrepl.runtime.operation_gate import SerialOperationGate
from mpyrepl.runtime.transport import SerialReplTransport, TransportError, TransportInterrupted


MIN_PYTHON = (3, 9)
PROMPT_CONTROL_EXIT = "__mpyrepl_prompt_control_exit__"


class AsyncReplState:
    """Mutable state shared between the prompt loop and control watcher.

    :return: None
    """

    def __init__(self) -> None:
        """Initialize control flags.

        :return: None
        """
        self.executing = False
        self.prompt_active = False
        self.pending_action = ""
        self.pending_exec_source = ""
        self.pending_exec_label = ""


class ReplInputBuffer:
    """Track the current editable source block.

    :return: None
    """

    def __init__(self) -> None:
        """Initialize an empty input buffer.

        :return: None
        """
        self._source = ""

    def prompt_text(self) -> str:
        """Return the primary prompt text.

        :return: Prompt text.
        """
        return ">>> "

    def prompt_default(self) -> str | Document:
        """Return the current editable source block.

        :return: Existing source as a Document, or an empty string.
        """
        if not self._source:
            return ""
        return Document(self._source, cursor_position=len(self._source))

    def has_pending_input(self) -> bool:
        """Report whether a source block is currently stored.

        :return: True when there is buffered source.
        """
        return bool(self._source.strip())

    def remember(self, source: str) -> None:
        """Remember the current editable source block.

        :param source: Current source block.
        :return: None
        """
        self._source = source

    def reset(self) -> None:
        """Discard any buffered source.

        :return: None
        """
        self._source = ""

    def consume_source(self, source: str) -> str:
        """Return the accepted source block and clear the editor state.

        :param source: Accepted source block.
        :return: Normalized source block.
        """
        self._source = ""
        return source.rstrip()


def write_stream_chunk(stream, decoder: Utf8StreamDecoder, chunk: bytes) -> None:
    """Decode and forward one output chunk.

    :param stream: Output stream.
    :param decoder: Incremental decoder.
    :param chunk: Raw byte chunk.
    :return: None
    """
    text = decoder.feed(chunk)
    if text:
        write_text(stream, text)


def write_text(stream, text: str) -> None:
    """Write decoded text to a host stream with a Unicode-safe fallback.

    :param stream: Output stream.
    :param text: Decoded text to forward.
    :return: None
    """
    try:
        stream.write(text)
    except UnicodeEncodeError:
        buffer = getattr(stream, "buffer", None)
        if buffer is not None:
            buffer.write(text.encode("utf-8", errors="replace"))
        else:
            encoding = getattr(stream, "encoding", None) or "utf-8"
            safe_text = text.encode(encoding, errors="replace").decode(encoding, errors="replace")
            stream.write(safe_text)
    stream.flush()


def flush_decoder(stream, decoder: Utf8StreamDecoder) -> None:
    """Flush any buffered decoder output.

    :param stream: Output stream.
    :param decoder: Incremental decoder.
    :return: None
    """
    text = decoder.flush()
    if text:
        write_text(stream, text)


def install_sigint_forwarder(transport: SerialReplTransport) -> Callable[[], None]:
    """Forward local SIGINT events to the device as Ctrl-C.

    :param transport: Active serial transport.
    :return: Function that restores the previous handler.
    """
    previous_handler = signal.getsignal(signal.SIGINT)

    def _handler(signum, frame) -> None:
        try:
            transport.interrupt()
            sys.stderr.write("\n[mpyrepl] forwarded Ctrl-C to device\n")
            sys.stderr.flush()
        except Exception as exc:  # pragma: no cover - best effort signal path
            sys.stderr.write("\n[mpyrepl] failed to forward Ctrl-C: %s\n" % (exc,))
            sys.stderr.flush()

    signal.signal(signal.SIGINT, _handler)

    def _restore() -> None:
        signal.signal(signal.SIGINT, previous_handler)

    return _restore


def ensure_python_version() -> None:
    """Require the minimum Python version for AST unparse support.

    :return: None
    """
    if sys.version_info < MIN_PYTHON:
        raise RuntimeError(
            "mpyrepl semantics require Python %d.%d or newer"
            % (MIN_PYTHON[0], MIN_PYTHON[1])
        )


def ensure_helper_loaded(
    transport: SerialReplTransport,
    follow_timeout: float,
    helper_version: str = "",
) -> None:
    """Inject the minimal REPL helper into the current device session.

    :param transport: Active serial transport.
    :param follow_timeout: Timeout while loading the helper.
    :param helper_version: Version string shown by the injected helper.
    :return: None
    """
    result = transport.exec_raw(build_helper_source(helper_version), timeout=follow_timeout)
    if result.stderr:
        detail = result.stderr.decode("utf-8", errors="replace").strip()
        raise TransportError("failed to inject repl helper: %s" % detail)


def run_exec(config: ReplConfig, code: str, follow_timeout: float) -> int:
    """Execute one block of code and stream stdout and stderr.

    :param config: Runtime configuration.
    :param code: Python source code.
    :param follow_timeout: Timeout for execution output.
    :return: Process exit code.
    """
    stdout_decoder = Utf8StreamDecoder()
    stderr_decoder = Utf8StreamDecoder()

    with SerialReplTransport(config) as transport:
        transport.enter_raw_repl(soft_reset=config.soft_reset_on_connect)
        ensure_helper_loaded(transport, follow_timeout)
        restore_sigint = install_sigint_forwarder(transport)
        try:
            result = execute_once(transport, code, follow_timeout, stdout_decoder, stderr_decoder)
        finally:
            restore_sigint()
            flush_decoder(sys.stdout, stdout_decoder)
            flush_decoder(sys.stderr, stderr_decoder)
            transport.exit_raw_repl()

    return 1 if result.stderr else 0


def run_soft_reset(config: ReplConfig) -> int:
    """Trigger a raw-mode soft reset and stream its banner output.

    :param config: Runtime configuration.
    :return: Process exit code.
    """
    stdout_decoder = Utf8StreamDecoder()

    with SerialReplTransport(config) as transport:
        transport.enter_raw_repl(soft_reset=False)
        transport.soft_reset(
            output_consumer=lambda chunk: write_stream_chunk(sys.stdout, stdout_decoder, chunk)
        )
        flush_decoder(sys.stdout, stdout_decoder)
        transport.exit_raw_repl()

    print(json.dumps(response_payload("", True, data=True), ensure_ascii=False))
    return 0


def run_interrupt(config: ReplConfig) -> int:
    """Send Ctrl-C without entering raw REPL.

    :param config: Runtime configuration.
    :return: Process exit code.
    """
    with SerialReplTransport(config) as transport:
        transport.interrupt()
    print(json.dumps(response_payload("", True, data=True), ensure_ascii=False))
    return 0


def execute_once(
    transport: SerialReplTransport,
    code: str,
    follow_timeout: float | None,
    stdout_decoder: Utf8StreamDecoder,
    stderr_decoder: Utf8StreamDecoder,
):
    """Execute one block inside an already-open raw REPL session.

    :param transport: Active serial transport.
    :param code: Python source code.
    :param follow_timeout: Timeout for execution output.
    :param stdout_decoder: Decoder for stdout.
    :param stderr_decoder: Decoder for stderr.
    :return: Raw execution result.
    """
    prepared_code = instrument_source(code)
    return transport.exec_raw(
        prepared_code,
        timeout=follow_timeout,
        stdout_consumer=lambda chunk: write_stream_chunk(sys.stdout, stdout_decoder, chunk),
        stderr_consumer=lambda chunk: write_stream_chunk(sys.stderr, stderr_decoder, chunk),
    )


def recover_after_interrupted_execution(
    transport: SerialReplTransport,
    recovery_timeout: float,
) -> None:
    """Best-effort recovery when user interrupt does not produce raw EOF markers.

    :param transport: Active serial transport.
    :param recovery_timeout: Overall timeout for prompt realignment.
    :return: None
    """
    transport.clear_interrupt_request()
    try:
        transport.drain_input(max_duration=0.2)
    except Exception:
        pass

    try:
        transport.enter_raw_repl(soft_reset=False, operation_timeout=recovery_timeout)
    except Exception as exc:
        write_text(sys.stderr, "\n[mpyrepl] interrupt recovery failed: %s\n" % (exc,))


def run_session_probe(config: ReplConfig, first: str, second: str, follow_timeout: float) -> int:
    """Run two code blocks within one raw REPL session.

    :param config: Runtime configuration.
    :param first: First Python source block.
    :param second: Second Python source block.
    :param follow_timeout: Timeout for each execution.
    :return: Process exit code.
    """
    stdout_decoder = Utf8StreamDecoder()
    stderr_decoder = Utf8StreamDecoder()

    with SerialReplTransport(config) as transport:
        transport.enter_raw_repl(soft_reset=config.soft_reset_on_connect)
        ensure_helper_loaded(transport, follow_timeout)
        first_result = execute_once(transport, first, follow_timeout, stdout_decoder, stderr_decoder)
        second_result = execute_once(transport, second, follow_timeout, stdout_decoder, stderr_decoder)
        flush_decoder(sys.stdout, stdout_decoder)
        flush_decoder(sys.stderr, stderr_decoder)
        transport.exit_raw_repl()

    if first_result.stderr or second_result.stderr:
        return 1
    return 0


def run_prompt_once(config: ReplConfig, follow_timeout: float) -> int:
    """Prompt for one line of code, execute it, then exit.

    :param config: Runtime configuration.
    :param follow_timeout: Timeout for execution output.
    :return: Process exit code.
    """
    session = build_prompt_session()
    code = session.prompt(
        ">>> ",
        pre_run=lambda: session.default_buffer.load_history_if_not_yet_loaded(),
    )
    if code == PROMPT_SOFT_RESET:
        return run_soft_reset(config)
    if code == PROMPT_EXIT:
        return 0
    return run_exec(config, code, follow_timeout)


def request_prompt_exit(session) -> None:
    """Exit the current prompt_toolkit prompt if it is running.

    :param session: Active prompt session.
    :return: None
    """
    app = session.app
    if not app.is_running or app.loop is None:
        return

    def _exit_prompt() -> None:
        try:
            app.exit(result=PROMPT_CONTROL_EXIT)
        except Exception as exc:
            if "Return value already set" not in str(exc):
                raise

    app.loop.call_soon_threadsafe(_exit_prompt)


def write_json_file(path: str, payload: dict) -> None:
    """Write a JSON response file atomically enough for polling clients.

    :param path: Response file path.
    :param payload: JSON-compatible payload.
    :return: None
    """
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    temp = target.with_name(target.name + ".tmp")
    temp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    temp.replace(target)


async def handle_fs_control_request(
    request,
    gate: SerialOperationGate,
    state: AsyncReplState,
    fs_client: DeviceFsClient,
) -> None:
    """Execute one filesystem control request and write its response.

    :param request: Parsed control request.
    :param gate: Shared serial operation gate.
    :param state: Shared async REPL state.
    :param fs_client: Filesystem client bound to the active transport.
    :return: None
    """
    request_id = request.request_id or str(request.sequence)
    response_file = request.response_file
    payload = dict(request.payload or {})
    op = str(payload.get("op") or "")
    progress_file = getattr(request, "progress_file", "")

    if state.executing:
        write_json_file(
            response_file,
            response_payload(request_id, False, error="device is busy running user code", code="busy"),
        )
        return

    try:
        if progress_file and op == "write_file":
            payload["progress_callback"] = lambda event: write_json_file(progress_file, event)
        data = await gate.run("fs-" + op, run_fs_operation, fs_client, op, payload)
    except FsOperationError as exc:
        write_json_file(
            response_file,
            response_payload(request_id, False, error=str(exc), code=exc.code),
        )
    except Exception as exc:
        write_json_file(
            response_file,
            response_payload(request_id, False, error=str(exc), code="error"),
        )
    else:
        write_json_file(response_file, response_payload(request_id, True, data=data))


async def apply_pending_action(
    transport: SerialReplTransport,
    gate: SerialOperationGate,
    state: AsyncReplState,
    session_symbols: ReplSessionSymbols,
    completer: ReplCompleter,
    follow_timeout: float,
) -> bool:
    """Apply any deferred control action after the current execution completes.

    :param transport: Active serial transport.
    :param state: Shared async REPL state.
    :param follow_timeout: Timeout for helper reinjection.
    :return: True when the loop should exit.
    """
    action = state.pending_action
    state.pending_action = ""
    if not action:
        return False

    if action == "exit":
        return True

    if action == "soft-reset":
        stdout_decoder = Utf8StreamDecoder()
        await gate.run(
            "soft-reset",
            transport.soft_reset,
            lambda chunk: write_stream_chunk(sys.stdout, stdout_decoder, chunk),
        )
        flush_decoder(sys.stdout, stdout_decoder)
        await gate.run("helper-load", ensure_helper_loaded, transport, follow_timeout)
        session_symbols.clear()
        completer.clear_runtime_cache()
        return False

    raise RuntimeError("unsupported pending action: %s" % (action,))


async def execute_source_block(
    transport: SerialReplTransport,
    gate: SerialOperationGate,
    state: AsyncReplState,
    session_symbols: ReplSessionSymbols,
    completer: ReplCompleter,
    source: str,
    follow_timeout: float | None,
) -> None:
    """Execute one user source block and update session-side caches on success.

    :param transport: Active serial transport.
    :param gate: Serialized raw REPL operation gate.
    :param state: Shared async REPL state.
    :param session_symbols: Host-side symbol cache.
    :param completer: Runtime completer cache.
    :param source: Python source code.
    :param follow_timeout: Inter-byte timeout for execution output, or None to wait indefinitely.
    :return: None
    """
    prepared_code = source.rstrip()
    if not prepared_code:
        return

    stdout_decoder = Utf8StreamDecoder()
    stderr_decoder = Utf8StreamDecoder()
    state.executing = True
    try:
        result = await gate.run(
            "execute",
            execute_once,
            transport,
            prepared_code,
            follow_timeout,
            stdout_decoder,
            stderr_decoder,
        )
    except TransportInterrupted:
        state.executing = False
        flush_decoder(sys.stdout, stdout_decoder)
        flush_decoder(sys.stderr, stderr_decoder)
        write_text(sys.stderr, "\n[mpyrepl] interrupted; recovering raw REPL\n")
        await gate.run(
            "interrupt-recover",
            recover_after_interrupted_execution,
            transport,
            2.0,
        )
        return
    finally:
        state.executing = False
        flush_decoder(sys.stdout, stdout_decoder)
        flush_decoder(sys.stderr, stderr_decoder)

    if not result.stderr:
        source_changes = session_symbols.record_successful_source(prepared_code)
        completer.invalidate_runtime_cache(
            rebound_roots=source_changes.rebound_roots,
            mutated_roots=source_changes.mutated_roots,
            clear_all=source_changes.clear_runtime_cache,
        )


async def watch_control_channel(
    channel: FileControlChannel,
    state: AsyncReplState,
    session,
    transport: SerialReplTransport,
    gate: SerialOperationGate,
    fs_client: DeviceFsClient,
) -> None:
    """Poll the control file and translate commands into safe transport actions.

    :param channel: File-based control channel.
    :param state: Shared async REPL state.
    :param session: Prompt session used by the foreground loop.
    :param transport: Active serial transport.
    :return: None
    """
    active_fs_task: asyncio.Task | None = None
    while True:
        if active_fs_task is not None and active_fs_task.done():
            try:
                active_fs_task.result()
            except Exception as exc:
                write_text(sys.stderr, "\n[mpyrepl] filesystem request task failed: %s\n" % exc)
            active_fs_task = None

        request = channel.read_next()
        if request is None:
            await asyncio.sleep(0.05)
            continue

        command = request.command
        if command == "interrupt":
            await asyncio.to_thread(transport.interrupt)
            if state.prompt_active:
                request_prompt_exit(session)
            continue

        if command == "soft-reset":
            if state.executing:
                await asyncio.to_thread(transport.interrupt)
            state.pending_action = "soft-reset"
            if state.prompt_active:
                request_prompt_exit(session)
            continue

        if command == "interrupt-reset":
            await asyncio.to_thread(transport.interrupt)
            await asyncio.sleep(0.05)
            await asyncio.to_thread(transport.interrupt)
            state.pending_action = "soft-reset"
            if state.prompt_active:
                request_prompt_exit(session)
            continue

        if command == "exit":
            if state.executing:
                await asyncio.to_thread(transport.interrupt)
            state.pending_action = "exit"
            if state.prompt_active:
                request_prompt_exit(session)
            continue

        if command == "exec":
            state.pending_exec_source = request.source
            state.pending_exec_label = request.label
            if state.prompt_active:
                request_prompt_exit(session)
            continue

        if command == "fs":
            if active_fs_task is not None:
                write_json_file(
                    request.response_file,
                    response_payload(
                        request.request_id or str(request.sequence),
                        False,
                        error="device is busy running filesystem operation",
                        code="busy",
                    ),
                )
                continue
            active_fs_task = asyncio.create_task(
                handle_fs_control_request(request, gate, state, fs_client)
            )
            await asyncio.sleep(0)
            continue


async def run_async_repl(
    config: ReplConfig,
    follow_timeout: float,
    control_file: str,
    stub_root: str,
    completion_roots: list[str] | None,
    dir_query_timeout: float,
    helper_version: str = "",
) -> int:
    """Run a minimal async prompt_toolkit loop over one raw REPL session.

    :param config: Runtime configuration.
    :param follow_timeout: Timeout for each execution.
    :param control_file: Optional path for extension-side control messages.
    :param completion_roots: Additional local completion roots.
    :param helper_version: Version string shown by the injected helper.
    :return: Process exit code.
    """
    state = AsyncReplState()
    gate = SerialOperationGate()
    session_symbols = ReplSessionSymbols()
    input_buffer = ReplInputBuffer()
    control_channel = FileControlChannel(control_file) if control_file else None
    execution_follow_timeout: float | None = None

    with SerialReplTransport(config) as transport:
        transport.enter_raw_repl(soft_reset=config.soft_reset_on_connect)
        await gate.run("helper-load", ensure_helper_loaded, transport, follow_timeout, helper_version)
        fs_client = DeviceFsClient(transport, timeout=config.operation_timeout)
        completer = ReplCompleter(
            session_symbols,
            stub_root=stub_root,
            completion_roots=completion_roots,
            dotted_provider=lambda expression, prefix, timeout=None: query_device_attributes(
                transport,
                gate,
                session_symbols,
                expression,
                timeout=dir_query_timeout
                if timeout is None
                else min(timeout, dir_query_timeout),
            ),
        )
        completer_stub_modules = getattr(completer, "stub_modules", lambda: ())()
        session = build_prompt_session(
            completer=completer,
            session_symbols=session_symbols,
            stub_modules=completer_stub_modules,
        )
        restore_sigint = install_sigint_forwarder(transport)
        control_task = None
        if control_channel is not None:
            control_channel.prepare()
            control_task = asyncio.create_task(
                watch_control_channel(control_channel, state, session, transport, gate, fs_client)
            )
        try:
            with patch_stdout(raw=True):
                while True:
                    had_pending_action = bool(state.pending_action)
                    if await apply_pending_action(
                        transport,
                        gate,
                        state,
                        session_symbols,
                        completer,
                        follow_timeout,
                    ):
                        input_buffer.reset()
                        break
                    if had_pending_action:
                        input_buffer.reset()

                    pending_exec_source = state.pending_exec_source
                    if pending_exec_source.strip():
                        state.pending_exec_source = ""
                        state.pending_exec_label = ""
                        input_buffer.reset()
                        await execute_source_block(
                            transport,
                            gate,
                            state,
                            session_symbols,
                            completer,
                            pending_exec_source,
                            execution_follow_timeout,
                        )
                        if await apply_pending_action(
                            transport,
                            gate,
                            state,
                            session_symbols,
                            completer,
                            follow_timeout,
                        ):
                            break
                        continue

                    state.prompt_active = True
                    try:
                        code = await session.prompt_async(
                            input_buffer.prompt_text(),
                            default=input_buffer.prompt_default(),
                            pre_run=lambda: session.default_buffer.load_history_if_not_yet_loaded(),
                        )
                    except EOFError:
                        break
                    except KeyboardInterrupt:
                        input_buffer.reset()
                        continue
                    finally:
                        state.prompt_active = False

                    had_pending_action = bool(state.pending_action)
                    if await apply_pending_action(
                        transport,
                        gate,
                        state,
                        session_symbols,
                        completer,
                        follow_timeout,
                    ):
                        input_buffer.reset()
                        break
                    if had_pending_action:
                        input_buffer.reset()

                    if code == PROMPT_CONTROL_EXIT:
                        continue

                    if code == PROMPT_SOFT_RESET:
                        input_buffer.reset()
                        state.pending_action = "soft-reset"
                        continue

                    if code == PROMPT_EXIT:
                        input_buffer.reset()
                        break

                    stripped = code.strip()
                    if "\n" not in code and stripped in (":q", ":quit", ":exit"):
                        break

                    prepared_code = input_buffer.consume_source(code)
                    await execute_source_block(
                        transport,
                        gate,
                        state,
                        session_symbols,
                        completer,
                        prepared_code,
                        execution_follow_timeout,
                    )

                    if await apply_pending_action(
                        transport,
                        gate,
                        state,
                        session_symbols,
                        completer,
                        follow_timeout,
                    ):
                        break
        finally:
            if control_task is not None:
                control_task.cancel()
                try:
                    await control_task
                except asyncio.CancelledError:
                    pass
            if control_channel is not None:
                control_channel.clear()
            restore_sigint()
            try:
                transport.exit_raw_repl()
            except Exception:
                pass

    return 0
