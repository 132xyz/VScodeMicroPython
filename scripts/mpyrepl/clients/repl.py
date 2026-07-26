"""Terminal-side REPL client for the hidden serial manager.

:return: None
"""

from __future__ import annotations

import argparse
import itertools
import json
import ntpath
import queue
import socket
import sys
import threading
import time
import traceback
from contextlib import ExitStack, contextmanager
from typing import Any, Callable, Iterator

from mpyrepl.manager.protocol import decode_json_line, encode_json_line
from prompt_toolkit.completion import Completer, Completion
from prompt_toolkit.document import Document
from prompt_toolkit.input import Input, create_input
from prompt_toolkit.key_binding import KeyPress
from prompt_toolkit.keys import Keys
from prompt_toolkit.patch_stdout import patch_stdout
from mpyrepl.repl.session import PROMPT_EXIT, PROMPT_SOFT_RESET, build_prompt_session


CTRL_C = "\x03"
RUN_FILE_PREFIX = ":mpy-run-file "
EXIT_TRANSPORT_LOST = 2
_TRANSPORT_LOST = object()
CtrlCReader = Callable[[Input, float], bool]


class ManagerRequestError(RuntimeError):
    """Structured error returned by the hidden manager."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code or "error"


class ManagerClient:
    """Small blocking NDJSON RPC client used by the terminal REPL.

    :param host: Manager host.
    :param port: Manager port.
    :param token: Manager authentication token.
    :return: None
    """

    def __init__(self, host: str, port: int, token: str) -> None:
        """Open no sockets yet.

        :param host: Manager host.
        :param port: Manager port.
        :param token: Manager authentication token.
        :return: None
        """
        self._host = host
        self._port = port
        self._token = token
        self._counter = itertools.count(1)
        self._socket: socket.socket | None = None
        self._reader = None
        self._connect_lock = threading.Lock()
        self._send_lock = threading.Lock()
        self._pending_lock = threading.Lock()
        self._pending: dict[str, queue.Queue[dict[str, Any] | Exception]] = {}
        self._reader_stop = threading.Event()
        self._reader_thread: threading.Thread | None = None
        self._reader_error: Exception | None = None

    def connect(self) -> None:
        """Connect to the manager endpoint.

        :return: None
        """
        with self._connect_lock:
            if self._socket is not None:
                return
            sock = socket.create_connection((self._host, self._port), timeout=10)
            sock.settimeout(None)
            self._socket = sock
            self._reader = sock.makefile("rb")
            self._reader_error = None
            self._reader_stop.clear()

    def close(self) -> None:
        """Close the manager connection.

        :return: None
        """
        self._reader_stop.set()
        with self._connect_lock:
            reader = self._reader
            sock = self._socket
            reader_thread = self._reader_thread
            self._reader = None
            self._socket = None
            self._reader_thread = None
        self._fail_pending(RuntimeError("manager connection closed"))
        if sock is not None:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except Exception:
                pass
        if reader is not None:
            try:
                reader.close()
            except Exception:
                pass
        if sock is not None:
            try:
                sock.close()
            except Exception:
                pass
        if reader_thread is not None and reader_thread is not threading.current_thread():
            reader_thread.join(timeout=0.5)
        with self._pending_lock:
            self._reader_error = None

    def call(self, method: str, params: dict[str, Any] | None = None) -> Any:
        """Send one request and wait for the matching response.

        :param method: RPC method.
        :param params: Request params.
        :return: RPC result.
        """
        self.connect()
        request_id = str(next(self._counter))
        payload = {"id": request_id, "token": self._token, "method": method, "params": params or {}}
        response_queue: queue.Queue[dict[str, Any] | Exception] = queue.Queue(maxsize=1)
        with self._pending_lock:
            if self._reader_error is not None:
                raise RuntimeError(str(self._reader_error)) from self._reader_error
            self._pending[request_id] = response_queue
        try:
            self._ensure_reader_thread()
            with self._send_lock:
                sock = self._socket
                if sock is None:
                    raise RuntimeError("manager client is not connected")
                sock.sendall(encode_json_line(payload).encode("utf-8"))
            response = response_queue.get()
        finally:
            with self._pending_lock:
                self._pending.pop(request_id, None)

        if isinstance(response, Exception):
            raise RuntimeError(str(response)) from response
        if not response.get("ok"):
            error = response.get("error") if isinstance(response.get("error"), dict) else {}
            raise ManagerRequestError(
                str(error.get("code") or "error"),
                str(error.get("message") or "manager request failed"),
            )
        return response.get("result")

    def _ensure_reader_thread(self) -> None:
        """Start the single socket reader used by requests and live events."""
        with self._pending_lock:
            thread = self._reader_thread
            if thread is not None and thread.is_alive():
                return
            if self._reader_error is not None:
                raise RuntimeError(str(self._reader_error)) from self._reader_error
            if self._reader is None:
                raise RuntimeError("manager client is not connected")
            thread = threading.Thread(
                target=self._reader_loop,
                name="mpyrepl-manager-reader",
                daemon=True,
            )
            self._reader_thread = thread
            thread.start()

    def _reader_loop(self) -> None:
        """Continuously drain manager messages so idle output is not delayed."""
        try:
            while not self._reader_stop.is_set():
                message = self._read_message()
                if "event" in message:
                    self._handle_event(message)
                    continue
                request_id = str(message.get("id") or "")
                with self._pending_lock:
                    response_queue = self._pending.get(request_id)
                if response_queue is not None:
                    response_queue.put(message)
        except Exception as exc:
            if not self._reader_stop.is_set():
                self._fail_pending(exc)

    def _fail_pending(self, exc: Exception) -> None:
        """Wake every blocked request after the shared reader fails."""
        with self._pending_lock:
            if not self._reader_stop.is_set():
                self._reader_error = exc
            response_queues = list(self._pending.values())
        for response_queue in response_queues:
            try:
                response_queue.put_nowait(exc)
            except queue.Full:
                pass

    def _read_message(self) -> dict[str, Any]:
        reader = self._reader
        if reader is None:
            raise RuntimeError("manager client is not connected")
        line = reader.readline()
        if not line:
            raise RuntimeError("manager connection closed")
        return decode_json_line(line)

    def _handle_event(self, message: dict[str, Any]) -> None:
        event = message.get("event")
        payload = message.get("payload") if isinstance(message.get("payload"), dict) else {}
        if event == "stdout":
            stream = sys.stdout
            stream.write(str(payload.get("text") or ""))
            stream.flush()
        elif event == "stderr":
            stream = sys.stderr
            stream.write(str(payload.get("text") or ""))
            stream.flush()
        elif event == "status" and payload.get("state") == "closing":
            stream = sys.stderr
            stream.write("\n[mpyrepl] manager is closing\n")
            stream.flush()


class ManagerCompleter(Completer):
    """Prompt-toolkit completer backed by the hidden manager RPC.

    :param client: Connected manager client.
    :return: None
    """

    def __init__(self, client: ManagerClient) -> None:
        """Store the manager client used for completion requests.

        :param client: Manager RPC client.
        :return: None
        """
        self._client = client

    def has_completion_target(self, document: Document) -> bool:
        """Return whether the current cursor position is worth completing.

        :param document: Prompt document.
        :return: True when completion should be attempted.
        """
        before_cursor = document.current_line_before_cursor
        return bool(before_cursor.strip()) and not before_cursor.endswith((" ", "\t"))

    def get_completions(self, document: Document, complete_event):
        """Yield completion candidates returned by ``repl.complete``.

        :param document: Prompt document.
        :param complete_event: Prompt-toolkit completion event.
        :return: Completion iterator.
        """
        if not self.has_completion_target(document):
            return
        try:
            result = self._client.call(
                "repl.complete",
                {
                    "text": document.text,
                    "cursor": document.cursor_position,
                    "requested": bool(getattr(complete_event, "completion_requested", False)),
                },
            )
        except Exception:
            return
        if not isinstance(result, list):
            return
        for item in result:
            if not isinstance(item, dict):
                continue
            text = str(item.get("text") or "")
            if not text:
                continue
            start_position = item.get("startPosition", 0)
            if not isinstance(start_position, int):
                start_position = 0
            yield Completion(
                text,
                start_position=start_position,
                display=str(item.get("display") or text),
                display_meta=str(item.get("meta") or ""),
            )


def parse_endpoint(endpoint: str) -> tuple[str, int]:
    """Parse host:port endpoint text.

    :param endpoint: Endpoint string.
    :return: Host and port.
    """
    if ":" not in endpoint:
        raise ValueError("endpoint must be host:port")
    host, port_text = endpoint.rsplit(":", 1)
    return host, int(port_text)


def run_repl_client(endpoint: str, token: str) -> int:
    """Run the terminal REPL client loop.

    :param endpoint: Manager endpoint in host:port format.
    :param token: Manager token.
    :return: Process exit code.
    """
    host, port = parse_endpoint(endpoint)
    client = ManagerClient(host, port, token)
    completer = ManagerCompleter(client)
    input_obj = create_input()
    session = build_prompt_session(completer=completer, input=input_obj, complete_while_typing=True)
    exit_code = 0
    try:
        client.call("manager.hello", {"role": "repl"})
        status = client.call("manager.status")
        sys.stderr.write(
            "[mpyrepl] connected to manager on %s:%s (%s)\n"
            % (host, port, status.get("state", "unknown") if isinstance(status, dict) else "unknown")
        )
        sys.stderr.flush()
        while True:
            try:
                with _patch_prompt_output():
                    source = session.prompt(
                        ">>> ",
                        pre_run=lambda: session.default_buffer.load_history_if_not_yet_loaded(),
                    )
            except EOFError:
                break
            except KeyboardInterrupt:
                try:
                    client.call("device.interrupt")
                except ManagerRequestError as exc:
                    _report_manager_error(exc)
                    if exc.code == "transport_lost":
                        exit_code = EXIT_TRANSPORT_LOST
                        break
                    continue
                sys.stderr.write("\n[mpyrepl] interrupt sent\n")
                sys.stderr.flush()
                continue

            stripped = source.strip()
            if source == PROMPT_EXIT or stripped in {":q", ":quit", ":exit"}:
                break
            if source == PROMPT_SOFT_RESET:
                try:
                    client.call("device.softReset")
                except ManagerRequestError as exc:
                    _report_manager_error(exc)
                    if exc.code == "transport_lost":
                        exit_code = EXIT_TRANSPORT_LOST
                        break
                continue
            if not stripped:
                continue

            try:
                run_file = parse_run_file_command(source)
            except ValueError as exc:
                sys.stderr.write("\n[mpyrepl] invalid run-file command: %s\n" % exc)
                sys.stderr.flush()
                continue

            if run_file is not None:
                if not _run_file(client, host, port, token, input_obj, run_file):
                    exit_code = EXIT_TRANSPORT_LOST
                    break
                continue

            if _execute_source(client, host, port, token, input_obj, source) is _TRANSPORT_LOST:
                exit_code = EXIT_TRANSPORT_LOST
                break
    finally:
        client.close()
        input_obj.close()
    return exit_code


def parse_run_file_command(source: str) -> str | None:
    """Parse an extension-owned run-file command.

    :param source: Accepted REPL input.
    :return: Local file path, or None for ordinary REPL input.
    """
    if not source.startswith(RUN_FILE_PREFIX):
        return None
    encoded_path = source[len(RUN_FILE_PREFIX) :].strip()
    try:
        file_path = json.loads(encoded_path)
    except (TypeError, ValueError) as exc:
        raise ValueError("expected a JSON string path") from exc
    if not isinstance(file_path, str) or not file_path:
        raise ValueError("expected a non-empty string path")
    return file_path


def _file_label(file_path: str) -> str:
    """Return a display label for Windows or POSIX paths on any host OS."""
    return ntpath.basename(file_path) or file_path


def _run_file(
    client: ManagerClient,
    host: str,
    port: int,
    token: str,
    input_obj: Input,
    file_path: str,
) -> bool:
    """Read and execute one local file through the manager-owned transport."""
    label = _file_label(file_path)
    try:
        with open(file_path, "r", encoding="utf-8-sig") as source_file:
            source = source_file.read()
    except (OSError, UnicodeError) as exc:
        sys.stderr.write("\n[mpyrepl] failed to read %s: %s\n" % (label, exc))
        sys.stderr.flush()
        return True

    sys.stderr.write("\n[mpyrepl] running %s\n" % label)
    sys.stderr.flush()
    result = _execute_source(
        client,
        host,
        port,
        token,
        input_obj,
        source,
        instrument=False,
        label=label,
    )
    if isinstance(result, dict) and not result.get("stderr"):
        sys.stderr.write("\n[mpyrepl] finished %s\n" % label)
        sys.stderr.flush()
    return result is not _TRANSPORT_LOST


def _execute_source(
    client: ManagerClient,
    host: str,
    port: int,
    token: str,
    input_obj: Input,
    source: str,
    *,
    instrument: bool = True,
    label: str = "",
) -> Any | None:
    """Execute source while forwarding Ctrl+C through a second manager client."""
    params: dict[str, Any] = {"source": source}
    if not instrument:
        params["instrument"] = False
    if label:
        params["label"] = label

    watcher = _ExecutionInterruptWatcher(host, port, token, input_obj)
    try:
        with watcher:
            result = client.call("repl.exec", params)
    except KeyboardInterrupt:
        watcher.send_interrupt()
        _report_execution_interrupt(watcher)
        return None
    except ManagerRequestError as exc:
        if watcher.interrupt_sent and exc.code == "cancelled":
            _report_execution_interrupt(watcher)
            return None
        _report_manager_error(exc)
        if exc.code == "transport_lost":
            return _TRANSPORT_LOST
        return None
    if watcher.interrupt_sent:
        _report_execution_interrupt(watcher)
        return None
    return result


def _report_manager_error(exc: ManagerRequestError) -> None:
    if exc.code == "transport_lost":
        sys.stderr.write("\n[mpyrepl] serial connection lost; REPL client is closing\n")
    else:
        sys.stderr.write("\n[mpyrepl] manager request failed: %s\n" % exc)
    sys.stderr.flush()


def _report_execution_interrupt(watcher: "_ExecutionInterruptWatcher") -> None:
    if watcher.reported:
        return
    watcher.reported = True
    if watcher.interrupt_error is not None:
        sys.stderr.write("\n[mpyrepl] interrupt failed: %s\n" % watcher.interrupt_error)
    else:
        sys.stderr.write("\n[mpyrepl] interrupt sent\n")
    sys.stderr.flush()


def _send_interrupt_out_of_band(host: str, port: int, token: str) -> None:
    client = ManagerClient(host, port, token)
    try:
        client.call("device.interrupt")
    finally:
        client.close()


class _ExecutionInterruptWatcher:
    def __init__(
        self,
        host: str,
        port: int,
        token: str,
        input_obj: Input,
        ctrl_c_reader: CtrlCReader | None = None,
    ) -> None:
        self._host = host
        self._port = port
        self._token = token
        self._input = input_obj
        self._ctrl_c_reader = ctrl_c_reader or _read_ctrl_c_from_input
        self._stop = threading.Event()
        self._interrupt_sent = threading.Event()
        self._thread: threading.Thread | None = None
        self.interrupt_error: Exception | None = None
        self.reported = False

    @property
    def interrupt_sent(self) -> bool:
        return self._interrupt_sent.is_set()

    def __enter__(self) -> "_ExecutionInterruptWatcher":
        self._thread = threading.Thread(target=self._run, name="mpyrepl-ctrl-c-watch", daemon=True)
        self._thread.start()
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self._stop.set()
        thread = self._thread
        if thread is not None:
            thread.join(timeout=0.2)

    def send_interrupt(self) -> None:
        if self._interrupt_sent.is_set():
            return
        try:
            _send_interrupt_out_of_band(self._host, self._port, self._token)
        except Exception as exc:
            self.interrupt_error = exc
        finally:
            self._interrupt_sent.set()

    def _run(self) -> None:
        try:
            raw_mode = self._input.raw_mode()
        except Exception:
            raw_mode = _null_context()
        with raw_mode:
            while not self._stop.is_set() and not self._interrupt_sent.is_set():
                try:
                    if self._ctrl_c_reader(self._input, 0.05):
                        self.send_interrupt()
                        return
                except Exception:
                    return


def _read_ctrl_c_from_input(input_obj: Input, timeout: float) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        for key_press in input_obj.read_keys():
            if _is_ctrl_c_key(key_press):
                return True
        time.sleep(0.01)
    return False


def _is_ctrl_c_key(key_press: KeyPress) -> bool:
    return key_press.key == Keys.ControlC or key_press.data == CTRL_C


@contextmanager
def _null_context() -> Iterator[None]:
    yield


@contextmanager
def _patch_prompt_output() -> Iterator[None]:
    """Keep live output prompt-safe, with a fallback for non-console test hosts."""
    with ExitStack() as stack:
        try:
            stack.enter_context(patch_stdout(raw=True))
        except Exception:
            pass
        yield


def build_parser() -> argparse.ArgumentParser:
    """Build the standalone REPL client parser.

    :return: Parser instance.
    """
    parser = argparse.ArgumentParser(description="MicroPython manager terminal client")
    parser.add_argument("--endpoint", required=True, help="Manager endpoint, for example 127.0.0.1:50000")
    parser.add_argument("--token", required=True, help="Manager authentication token")
    return parser


def main() -> int:
    """Run the standalone REPL client.

    :return: Process exit code.
    """
    try:
        args = build_parser().parse_args()
        return run_repl_client(args.endpoint, args.token)
    except KeyboardInterrupt:
        sys.stderr.write("\n[mpyrepl] interrupted\n")
        sys.stderr.flush()
        return 130
    except Exception:
        sys.stderr.write("\n[mpyrepl] REPL client crashed; traceback follows.\n")
        traceback.print_exc()
        sys.stderr.flush()
        return 1


if __name__ == "__main__":
    sys.exit(main())
