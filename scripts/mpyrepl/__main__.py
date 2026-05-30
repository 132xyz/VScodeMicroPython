"""Standalone entry point for the raw REPL spike.

:return: None
"""

from __future__ import annotations

import asyncio
import os
import signal
import sys
import threading
from typing import Callable, TypeVar


CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
if CURRENT_DIR not in sys.path:
    sys.path.insert(0, CURRENT_DIR)

import bootstrap

bootstrap.configure_import_path()

from prompt_toolkit.document import Document

from cli import parse_args
from completion_device import query_device_attributes
from completion_engine import ReplCompleter
from completion_state import ReplSessionSymbols
from control import FileControlChannel
from decode import Utf8StreamDecoder
from models import ReplConfig
from repl_semantics import build_helper_source, instrument_source
from session import PROMPT_EXIT, PROMPT_SOFT_RESET, build_prompt_session
from transport import SerialReplTransport, TransportError
from prompt_toolkit.patch_stdout import patch_stdout


MIN_PYTHON = (3, 9)
PROMPT_CONTROL_EXIT = "__mpyrepl_prompt_control_exit__"
ResultT = TypeVar("ResultT")


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


class SerialOperationGate:
    """Serialize raw REPL protocol operations on one transport.

    :return: None
    """

    def __init__(self) -> None:
        """Initialize an idle gate.

        :return: None
        """
        self._lock = threading.Lock()
        self._current_operation = ""

    @property
    def busy(self) -> bool:
        """Return whether a serialized operation is running.

        :return: True when the transport gate is occupied.
        """
        return self._lock.locked()

    @property
    def current_operation(self) -> str:
        """Return the label of the current serialized operation.

        :return: Operation label or an empty string.
        """
        return self._current_operation

    async def run(
        self,
        operation: str,
        func: Callable[..., ResultT],
        *args,
    ) -> ResultT:
        """Run one blocking transport operation through the shared gate.

        :param operation: Human-readable operation label.
        :param func: Blocking function executed in a worker thread.
        :param args: Positional arguments forwarded to func.
        :return: Function return value.
        """
        return await asyncio.to_thread(self.run_blocking, operation, func, *args)

    def run_blocking(
        self,
        operation: str,
        func: Callable[..., ResultT],
        *args,
    ) -> ResultT:
        """Run one blocking transport operation while holding the gate.

        :param operation: Human-readable operation label.
        :param func: Blocking function.
        :param args: Positional arguments forwarded to func.
        :return: Function return value.
        """
        with self._lock:
            self._current_operation = operation
            try:
                return func(*args)
            finally:
                self._current_operation = ""

    def try_run_blocking(
        self,
        operation: str,
        func: Callable[..., ResultT],
        *args,
    ) -> ResultT | None:
        """Try to run one blocking operation without waiting for the gate.

        :param operation: Human-readable operation label.
        :param func: Blocking function.
        :param args: Positional arguments forwarded to func.
        :return: Function return value, or None when the gate is busy.
        """
        if not self._lock.acquire(blocking=False):
            return None

        self._current_operation = operation
        try:
            return func(*args)
        finally:
            self._current_operation = ""
            self._lock.release()


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
        stream.write(text)
        stream.flush()


def flush_decoder(stream, decoder: Utf8StreamDecoder) -> None:
    """Flush any buffered decoder output.

    :param stream: Output stream.
    :param decoder: Incremental decoder.
    :return: None
    """
    text = decoder.flush()
    if text:
        stream.write(text)
        stream.flush()


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


def ensure_helper_loaded(transport: SerialReplTransport, follow_timeout: float) -> None:
    """Inject the minimal REPL helper into the current device session.

    :param transport: Active serial transport.
    :param follow_timeout: Timeout while loading the helper.
    :return: None
    """
    result = transport.exec_raw(build_helper_source(), timeout=follow_timeout)
    if result.stderr:
        raise TransportError("failed to inject repl helper")


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

    return 0


def execute_once(
    transport: SerialReplTransport,
    code: str,
    follow_timeout: float,
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
    app.loop.call_soon_threadsafe(lambda: app.exit(result=PROMPT_CONTROL_EXIT))


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


async def watch_control_channel(
    channel: FileControlChannel,
    state: AsyncReplState,
    session,
    transport: SerialReplTransport,
) -> None:
    """Poll the control file and translate commands into safe transport actions.

    :param channel: File-based control channel.
    :param state: Shared async REPL state.
    :param session: Prompt session used by the foreground loop.
    :param transport: Active serial transport.
    :return: None
    """
    while True:
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


async def run_async_repl(
    config: ReplConfig,
    follow_timeout: float,
    control_file: str,
    stub_root: str,
    dir_query_timeout: float,
) -> int:
    """Run a minimal async prompt_toolkit loop over one raw REPL session.

    :param config: Runtime configuration.
    :param follow_timeout: Timeout for each execution.
    :param control_file: Optional path for extension-side control messages.
    :return: Process exit code.
    """
    state = AsyncReplState()
    gate = SerialOperationGate()
    session_symbols = ReplSessionSymbols()
    input_buffer = ReplInputBuffer()
    control_channel = FileControlChannel(control_file) if control_file else None

    with SerialReplTransport(config) as transport:
        transport.enter_raw_repl(soft_reset=config.soft_reset_on_connect)
        await gate.run("helper-load", ensure_helper_loaded, transport, follow_timeout)
        completer = ReplCompleter(
            session_symbols,
            stub_root=stub_root,
            dotted_provider=lambda expression, prefix: [
                name
                for name in query_device_attributes(
                    transport,
                    gate,
                    session_symbols,
                    expression,
                    timeout=dir_query_timeout,
                )
                if name.startswith(prefix)
            ],
        )
        session = build_prompt_session(completer=completer)
        restore_sigint = install_sigint_forwarder(transport)
        control_task = None
        if control_channel is not None:
            control_channel.prepare()
            control_task = asyncio.create_task(
                watch_control_channel(control_channel, state, session, transport)
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
                    if not prepared_code:
                        continue

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
                    finally:
                        state.executing = False
                        flush_decoder(sys.stdout, stdout_decoder)
                        flush_decoder(sys.stderr, stderr_decoder)

                    if not result.stderr:
                        session_symbols.record_successful_source(prepared_code)
                        completer.clear_runtime_cache()

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
            transport.exit_raw_repl()

    return 0


def main() -> int:
    """Parse arguments and execute the selected spike command.

    :return: Process exit code.
    """
    ensure_python_version()
    args = parse_args()
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
                    args.dir_query_timeout,
                )
            )
        if args.command == "soft-reset":
            return run_soft_reset(config)
        raise ValueError("unsupported command: %s" % (args.command,))
    except TransportError as exc:
        sys.stderr.write("[mpyrepl] %s\n" % (exc,))
        sys.stderr.flush()
        return 2
    except RuntimeError as exc:
        sys.stderr.write("[mpyrepl] %s\n" % (exc,))
        sys.stderr.flush()
        return 3


if __name__ == "__main__":
    sys.exit(main())
