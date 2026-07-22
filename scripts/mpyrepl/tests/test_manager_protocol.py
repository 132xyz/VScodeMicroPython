from __future__ import annotations

import json
import os
import sys
import unittest


SCRIPTS_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

from mpyrepl import bootstrap

bootstrap.configure_import_path()

from mpyrepl.manager.protocol import (
    READY_MARKER,
    RpcMethodError,
    RpcProtocolError,
    decode_json_line,
    error_payload,
    error_response_line,
    event_line,
    parse_request,
    ready_line,
    response_line,
)


class ManagerProtocolTests(unittest.TestCase):
    def test_parse_request_accepts_string_and_numeric_ids(self) -> None:
        request = parse_request(
            b'{"id": 42, "method": "manager.ping", "params": {"x": 1}, "token": "tok"}\n'
        )

        self.assertEqual(request.request_id, "42")
        self.assertEqual(request.method, "manager.ping")
        self.assertEqual(request.params, {"x": 1})
        self.assertEqual(request.token, "tok")

    def test_parse_request_rejects_malformed_payloads(self) -> None:
        with self.assertRaises(RpcProtocolError):
            decode_json_line("[]")
        with self.assertRaises(RpcProtocolError):
            parse_request('{"id": "1", "method": "", "token": "tok"}')
        with self.assertRaises(RpcProtocolError):
            parse_request('{"id": "1", "method": "x", "params": [], "token": "tok"}')
        with self.assertRaises(RpcProtocolError):
            parse_request('{"id": "1", "method": "x", "params": {}, "token": 2}')

    def test_parse_request_defaults_empty_params_and_error_types(self) -> None:
        request = parse_request('{"id": "1", "method": "manager.status", "token": "tok", "params": null}')
        method_error = RpcMethodError("boom", "device", {"path": "/"})
        payload = error_payload("device", "boom", {"path": "/"})

        self.assertEqual(request.params, {})
        self.assertEqual(method_error.code, "device")
        self.assertEqual(method_error.details, {"path": "/"})
        self.assertEqual(payload["details"], {"path": "/"})

    def test_response_event_and_ready_lines_are_json_lines(self) -> None:
        ok = json.loads(response_line("abc", {"value": 1}))
        err = json.loads(error_response_line("abc", "boom", "failed"))
        event = json.loads(event_line("status", {"state": "ready"}))
        empty_event = json.loads(event_line("status"))
        ready = ready_line("127.0.0.1", 1234, "secret")

        self.assertEqual(ok, {"id": "abc", "ok": True, "result": {"value": 1}})
        self.assertFalse(err["ok"])
        self.assertEqual(err["error"]["code"], "boom")
        self.assertEqual(event["event"], "status")
        self.assertEqual(empty_event["payload"], {})
        self.assertTrue(ready.startswith(READY_MARKER))
        self.assertEqual(json.loads(ready[len(READY_MARKER):])["port"], 1234)

    def test_decode_rejects_invalid_json(self) -> None:
        with self.assertRaises(RpcProtocolError):
            decode_json_line("{bad")


if __name__ == "__main__":
    unittest.main()
