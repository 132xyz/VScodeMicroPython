"""Terminal-side REPL client for the hidden serial manager.

:return: None
"""

from __future__ import annotations

import argparse
import itertools
import socket
import sys
import threading
import time
import traceback
from contextlib import contextmanager
from typing import Any, Callable, Iterator

from manager_protocol import decode_json_line, encode_json_line
from prompt_toolkit.completion import Completer, Completion
from prompt_toolkit.document import Document
from prompt_toolkit.input import Input, create_input
from prompt_toolkit.key_binding import KeyPress
from prompt_toolkit.keys import Keys
from session import PROMPT_EXIT, PROMPT_SOFT_RESET, build_prompt_session


CTRL_C = "\x03"
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

    def connect(self) -> None:
        """Connect to the manager endpoint.

        :return: None
        """
        if self._socket is not None:
            return
        sock = socket.create_connection((self._host, self._port), timeout=10)
        sock.settimeout(None)
        self._socket = sock
        self._reader = sock.makefile("rb")

    def close(self) -> None:
        """Close the manager connection.

        :return: None
        """
        reader = self._reader
        sock = self._socket
        self._reader = None
        self._socket = None
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

    def call(self, method: str, params: dict[str, Any] | None = None) -> Any:
        """Send one request and wait for the matching response.

        :param method: RPC method.
        :param params: Request params.
        :return: RPC result.
        """
        self.connect()
        request_id = str(next(self._counter))
        payload = {"id": request_id, "token": self._token, "method": method, "params": params or {}}
        assert self._socket is not None
        self._socket.sendall(encode_json_line(payload).encode("utf-8"))
        while True:
            message = self._read_message()
            if "event" in message:
                self._handle_event(message)
                continue
            if str(message.get("id")) != request_id:
                continue
            if not message.get("ok"):
                error = message.get("error") if isinstance(message.get("error"), dict) else {}
                raise ManagerRequestError(
                    str(error.get("code") or "error"),
                    str(error.get("message") or "manager request failed"),
                )
            return message.get("result")

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
            sys.stdout.write(str(payload.get("text") or ""))
            sys.stdout.flush()
        elif event == "stderr":
            sys.stderr.write(str(payload.get("text") or ""))
            sys.stderr.flush()
        elif event == "status" and payload.get("state") == "closing":
            sys.stderr.write("\n[mpyrepl] manager is closing\n")
            sys.stderr.flush()


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
    try:
        status = client.call("manager.status")
        sys.stderr.write(
            "[mpyrepl] connected to manager on %s:%s (%s)\n"
            % (host, port, status.get("state", "unknown") if isinstance(status, dict) else "unknown")
        )
        sys.stderr.flush()
        while True:
            try:
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
                continue
            if not stripped:
                continue
            watcher = _ExecutionInterruptWatcher(host, port, token, input_obj)
            try:
                with watcher:
                    result = client.call("repl.exec", {"source": source})
            except KeyboardInterrupt:
                watcher.send_interrupt()
                _report_execution_interrupt(watcher)
                continue
            except ManagerRequestError as exc:
                if watcher.interrupt_sent and exc.code == "cancelled":
                    _report_execution_interrupt(watcher)
                    continue
                _report_manager_error(exc)
                continue
            if watcher.interrupt_sent:
                _report_execution_interrupt(watcher)
                continue
            if isinstance(result, dict) and result.get("stderr"):
                continue
    finally:
        client.close()
        input_obj.close()
    return 0


def _report_manager_error(exc: ManagerRequestError) -> None:
    if exc.code == "transport_lost":
        sys.stderr.write("\n[mpyrepl] serial connection lost; retrying will reconnect the manager\n")
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
