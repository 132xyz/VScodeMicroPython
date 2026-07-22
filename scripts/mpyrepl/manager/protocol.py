"""NDJSON RPC protocol helpers for the hidden serial manager.

:return: None
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any


READY_MARKER = "__MPY_MANAGER_READY__"
DEFAULT_HOST = "127.0.0.1"
PROTOCOL_VERSION = 1

ERROR_AUTH = "auth"
ERROR_INTERNAL = "internal"
ERROR_PROTOCOL = "protocol"


@dataclass(frozen=True)
class RpcRequest:
    """One validated manager RPC request.

    :param request_id: Caller-provided request id.
    :param method: RPC method name.
    :param params: Request parameters.
    :param token: Authentication token.
    :return: None
    """

    request_id: str
    method: str
    params: dict[str, Any]
    token: str


class RpcProtocolError(ValueError):
    """Raised when an RPC message is malformed."""

    def __init__(self, message: str, code: str = ERROR_PROTOCOL) -> None:
        """Store a protocol error code and message.

        :param message: Human-readable error.
        :param code: Machine-readable error code.
        :return: None
        """
        super().__init__(message)
        self.code = code


class RpcMethodError(RuntimeError):
    """Raised by manager method handlers for structured RPC errors."""

    def __init__(self, message: str, code: str = ERROR_INTERNAL, details: dict[str, Any] | None = None) -> None:
        """Store a method error code, message, and optional details.

        :param message: Human-readable error.
        :param code: Machine-readable error code.
        :param details: Additional JSON-compatible details.
        :return: None
        """
        super().__init__(message)
        self.code = code
        self.details = details or {}


def encode_json_line(payload: dict[str, Any]) -> str:
    """Encode one JSON object as an NDJSON line.

    :param payload: JSON-compatible object.
    :return: Encoded line including a newline.
    """
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n"


def decode_json_line(line: bytes | str) -> dict[str, Any]:
    """Decode one NDJSON object.

    :param line: Raw line bytes or text.
    :return: Parsed object.
    """
    text = line.decode("utf-8", errors="replace") if isinstance(line, bytes) else line
    try:
        payload = json.loads(text)
    except json.JSONDecodeError as exc:
        raise RpcProtocolError("invalid JSON: %s" % exc) from exc
    if not isinstance(payload, dict):
        raise RpcProtocolError("RPC payload must be a JSON object")
    return payload


def parse_request(line: bytes | str) -> RpcRequest:
    """Parse and validate one RPC request line.

    :param line: Raw request line.
    :return: Validated request.
    """
    payload = decode_json_line(line)
    request_id = payload.get("id")
    method = payload.get("method")
    params = payload.get("params", {})
    token = payload.get("token", "")
    if not isinstance(request_id, (str, int)):
        raise RpcProtocolError("RPC request id must be a string or number")
    if not isinstance(method, str) or not method:
        raise RpcProtocolError("RPC method must be a non-empty string")
    if params is None:
        params = {}
    if not isinstance(params, dict):
        raise RpcProtocolError("RPC params must be an object")
    if not isinstance(token, str):
        raise RpcProtocolError("RPC token must be a string")
    return RpcRequest(str(request_id), method, params, token)


def error_payload(code: str, message: str, details: dict[str, Any] | None = None) -> dict[str, Any]:
    """Build a structured RPC error object.

    :param code: Machine-readable error code.
    :param message: Human-readable error.
    :param details: Additional JSON-compatible details.
    :return: Error payload.
    """
    result: dict[str, Any] = {"code": code or ERROR_INTERNAL, "message": message}
    if details:
        result["details"] = details
    return result


def response_line(request_id: str, result: Any = None) -> str:
    """Encode one successful RPC response.

    :param request_id: Request id.
    :param result: JSON-compatible result.
    :return: Encoded NDJSON response.
    """
    return encode_json_line({"id": request_id, "ok": True, "result": result})


def error_response_line(request_id: str, code: str, message: str, details: dict[str, Any] | None = None) -> str:
    """Encode one failed RPC response.

    :param request_id: Request id.
    :param code: Machine-readable error code.
    :param message: Human-readable error.
    :param details: Additional JSON-compatible details.
    :return: Encoded NDJSON response.
    """
    return encode_json_line(
        {"id": request_id, "ok": False, "error": error_payload(code, message, details)}
    )


def event_line(event: str, payload: dict[str, Any] | None = None) -> str:
    """Encode one manager event.

    :param event: Event name.
    :param payload: Event payload.
    :return: Encoded NDJSON event.
    """
    return encode_json_line({"event": event, "payload": payload or {}})


def ready_line(host: str, port: int, token: str) -> str:
    """Encode the manager process ready line consumed by the extension.

    :param host: RPC host.
    :param port: RPC port.
    :param token: Authentication token.
    :return: Ready line.
    """
    return READY_MARKER + encode_json_line({"host": host, "port": port, "token": token})
