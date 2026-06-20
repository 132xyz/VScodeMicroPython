"""Terminal-side REPL client for the hidden serial manager.

:return: None
"""

from __future__ import annotations

import argparse
import itertools
import socket
import sys
import traceback
from typing import Any

from manager_protocol import decode_json_line, encode_json_line
from prompt_toolkit.completion import Completer, Completion
from prompt_toolkit.document import Document
from session import PROMPT_EXIT, PROMPT_SOFT_RESET, build_prompt_session


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
                raise RuntimeError(str(error.get("message") or "manager request failed"))
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
    session = build_prompt_session(completer=completer, complete_while_typing=True)
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
                client.call("device.interrupt")
                sys.stderr.write("\n[mpyrepl] interrupt sent\n")
                sys.stderr.flush()
                continue

            stripped = source.strip()
            if source == PROMPT_EXIT or stripped in {":q", ":quit", ":exit"}:
                break
            if source == PROMPT_SOFT_RESET:
                client.call("device.softReset")
                continue
            if not stripped:
                continue
            result = client.call("repl.exec", {"source": source})
            if isinstance(result, dict) and result.get("stderr"):
                continue
    finally:
        client.close()
    return 0


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
