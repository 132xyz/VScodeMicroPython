from __future__ import annotations

import importlib
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock


CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
if CURRENT_DIR not in sys.path:
    sys.path.insert(0, CURRENT_DIR)

import bootstrap

bootstrap.configure_import_path()

import completion_engine as completion_engine_module
import completion_state as completion_state_module
import session as session_module
import transport as transport_module
from cli import build_parser
from completion_engine import (
    ReplCompleter,
    cursor_in_string_or_comment,
    discover_stub_modules,
    parse_completion_request,
)
from completion_device import (
    _build_dir_query_source,
    _parse_dir_output,
    _resolved_expression,
    _split_expression,
    query_device_attributes,
)
from completion_state import ReplSessionSymbols
from control import ControlRequest, FileControlChannel
from decode import Utf8StreamDecoder
from indent import (
    continuation_default,
    is_block_complete,
    leading_indent_prefix,
    should_start_multiline,
)
from models import ExecResult
from repl_semantics import build_helper_source, instrument_source
from transport import TransportError
from prompt_toolkit.completion import CompleteEvent
from prompt_toolkit.document import Document


class FakeGate:
    def __init__(self, result=None, error: Exception | None = None) -> None:
        self.result = result
        self.error = error
        self.operation = ""
        self.source = ""
        self.timeout = 0.0

    def try_run_blocking(self, operation, func, source, timeout):
        self.operation = operation
        self.source = source
        self.timeout = timeout
        if self.error is not None:
            raise self.error
        return self.result


class SupportModuleTests(unittest.TestCase):
    def test_bootstrap_configure_import_path_adds_current_and_vendor_dirs(self) -> None:
        current_dir = os.path.dirname(os.path.abspath(bootstrap.__file__))
        vendor_dir = os.path.join(current_dir, "_vendor")

        with mock.patch.object(bootstrap.sys, "path", ["existing"]):
            bootstrap.configure_import_path()

            self.assertEqual(bootstrap.sys.path[0], vendor_dir)
            self.assertEqual(bootstrap.sys.path[1], current_dir)
            self.assertIn("existing", bootstrap.sys.path)

        importlib.reload(bootstrap)

    def test_cli_async_repl_parses_completion_options(self) -> None:
        parser = build_parser()
        args = parser.parse_args(
            [
                "--port",
                "COM4",
                "--baudrate",
                "230400",
                "async-repl",
                "--control-file",
                "control.json",
                "--stub-root",
                "stubs",
                "--dir-query-timeout",
                "3.5",
            ]
        )

        self.assertEqual(args.port, "COM4")
        self.assertEqual(args.baudrate, 230400)
        self.assertEqual(args.command, "async-repl")
        self.assertEqual(args.control_file, "control.json")
        self.assertEqual(args.stub_root, "stubs")
        self.assertEqual(args.dir_query_timeout, 3.5)

    def test_cli_exec_parses_follow_timeout(self) -> None:
        parser = build_parser()
        args = parser.parse_args(
            [
                "--port",
                "COM4",
                "exec",
                "--code",
                "print(1)",
                "--follow-timeout",
                "4.25",
            ]
        )

        self.assertEqual(args.command, "exec")
        self.assertEqual(args.code, "print(1)")
        self.assertEqual(args.follow_timeout, 4.25)

    def test_completion_state_tracks_symbols_and_aliases(self) -> None:
        symbols = ReplSessionSymbols()
        symbols.record_successful_source(
            """
import machine as hw
import xml.etree.ElementTree as etree
from math import sin as sine, cos
from pkg import *
value = 1
left, (middle, right) = (1, (2, 3))
counter: int = 0
counter += 1
for index, item in []:
    pass
with open('demo') as handle:
    pass
try:
    pass
except Exception as err:
    pass
class Demo:
    pass
def func():
    pass
async def coro():
    async for stream_item in agen():
        pass
    async with ctx() as resource:
        pass
""".strip()
        )

        candidates = symbols.bare_candidates()
        for name in (
            "_",
            "hw",
            "etree",
            "sine",
            "cos",
            "value",
            "left",
            "middle",
            "right",
            "counter",
            "index",
            "item",
            "handle",
            "err",
            "Demo",
            "func",
            "coro",
        ):
            self.assertIn(name, candidates)

        self.assertEqual(symbols.resolve_module_alias("hw"), "machine")
        self.assertEqual(symbols.resolve_module_alias("etree"), "xml")

        symbols.record_successful_source("def broken(:\n")

        symbols.clear()
        self.assertEqual(symbols.bare_candidates(), {"_"})
        self.assertIsNone(symbols.resolve_module_alias("hw"))

    def test_completion_engine_discovers_stubs_and_caches_runtime_results(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            stub_root = Path(tmp_dir)
            (stub_root / "machine.pyi").write_text("", encoding="utf-8")
            (stub_root / "pkg").mkdir()
            (stub_root / "pkg" / "__init__.pyi").write_text("", encoding="utf-8")
            (stub_root / ".hidden.pyi").write_text("", encoding="utf-8")

            self.assertEqual(discover_stub_modules(str(stub_root)), {"machine", "pkg"})

            calls: list[tuple[str, str]] = []

            def dotted_provider(expression: str, prefix: str):
                calls.append((expression, prefix))
                return ["Pin", "PWM", "Pin"]

            symbols = ReplSessionSymbols()
            symbols.record_successful_source("alias_name = 1")
            completer = ReplCompleter(
                symbols,
                stub_root=str(stub_root),
                dotted_provider=dotted_provider,
            )

            dotted_document = Document("machine.P", cursor_position=len("machine.P"))
            auto_before_cache = list(
                completer.get_completions(
                    dotted_document,
                    CompleteEvent(text_inserted=True),
                )
            )
            self.assertEqual([item.text for item in auto_before_cache], ["PWM", "Pin"])
            self.assertEqual(calls, [("machine", "P")])

            first = [item.text for item in completer.get_completions(dotted_document, None)]
            second = [item.text for item in completer.get_completions(dotted_document, None)]
            self.assertEqual(first, ["PWM", "Pin"])
            self.assertEqual(second, ["PWM", "Pin"])
            self.assertEqual(calls, [("machine", "P")])

            narrower_document = Document("machine.Pi", cursor_position=len("machine.Pi"))
            narrower = [
                item.text
                for item in completer.get_completions(
                    narrower_document,
                    CompleteEvent(text_inserted=True),
                )
            ]
            self.assertEqual(narrower, ["Pin"])
            self.assertEqual(calls, [("machine", "P")])

            completer.clear_runtime_cache()
            auto_after_clear = list(
                completer.get_completions(
                    dotted_document,
                    CompleteEvent(text_inserted=True),
                )
            )
            self.assertEqual([item.text for item in auto_after_clear], ["PWM", "Pin"])
            self.assertEqual(calls, [("machine", "P"), ("machine", "P")])
            third = [item.text for item in completer.get_completions(dotted_document, None)]
            self.assertEqual(third, ["PWM", "Pin"])
            self.assertEqual(calls, [("machine", "P"), ("machine", "P")])

            bare_document = Document("ali", cursor_position=3)
            bare_names = {item.text for item in completer.get_completions(bare_document, None)}
            self.assertIn("alias_name", bare_names)

            meta_document = Document(":q", cursor_position=2)
            meta_names = [item.text for item in completer.get_completions(meta_document, None)]
            self.assertEqual(meta_names, [":q", ":quit"])

    def test_completion_engine_request_parsing_respects_strings_comments_and_patterns(self) -> None:
        self.assertTrue(cursor_in_string_or_comment("'unterminated"))
        self.assertFalse(cursor_in_string_or_comment("machine.P"))
        self.assertFalse(cursor_in_string_or_comment("fun(machine.P"))
        self.assertIsNone(parse_completion_request(Document("'unterminated", cursor_position=13)))

        dotted = parse_completion_request(Document("machine.P", cursor_position=9))
        self.assertEqual((dotted.kind, dotted.expression, dotted.prefix), ("dotted", "machine", "P"))

        nested_dotted = parse_completion_request(Document("fun(machine.P", cursor_position=13))
        self.assertEqual((nested_dotted.kind, nested_dotted.expression, nested_dotted.prefix), ("dotted", "machine", "P"))

        list_dotted = parse_completion_request(Document("[machine.P", cursor_position=10))
        self.assertEqual((list_dotted.kind, list_dotted.expression, list_dotted.prefix), ("dotted", "machine", "P"))

        meta = parse_completion_request(Document(":qu", cursor_position=3))
        self.assertEqual((meta.kind, meta.prefix), ("meta", ":qu"))

        bare = parse_completion_request(Document("prin", cursor_position=4))
        self.assertEqual((bare.kind, bare.prefix), ("bare", "prin"))

        self.assertIsNone(parse_completion_request(Document("1 + 2", cursor_position=5)))

    def test_completion_device_helpers_resolve_alias_and_parse_output(self) -> None:
        symbols = ReplSessionSymbols()
        symbols.record_successful_source("import machine as hw")

        self.assertEqual(_split_expression("hw.Pin"), ("hw", ".Pin"))
        self.assertEqual(_split_expression("machine"), ("machine", ""))
        self.assertEqual(_resolved_expression("hw.Pin", symbols), "__import__('machine').Pin")

        source = _build_dir_query_source("hw.Pin", symbols)
        self.assertIn("_mpy_target = __import__('machine').Pin", source)
        self.assertIn("except NameError:", source)

        names = _parse_dir_output(b"'Pin'\n'_hidden'\nnot-a-repr\n123\n'UART'\n")
        self.assertEqual(names, ["Pin", "UART"])

    def test_query_device_attributes_handles_success_busy_and_errors(self) -> None:
        symbols = ReplSessionSymbols()
        symbols.record_successful_source("import machine as hw")
        transport = SimpleNamespace(exec_raw=lambda *args, **kwargs: None)

        gate = FakeGate(ExecResult(stdout=b"'Pin'\n'UART'\n", stderr=b""))
        names = query_device_attributes(transport, gate, symbols, "hw", timeout=1.25)
        self.assertEqual(names, ["Pin", "UART"])
        self.assertEqual(gate.operation, "dir-query")
        self.assertIn("__import__('machine')", gate.source)
        self.assertEqual(gate.timeout, 1.25)

        self.assertEqual(
            query_device_attributes(transport, FakeGate(None), symbols, "hw"),
            [],
        )
        self.assertEqual(
            query_device_attributes(
                transport,
                FakeGate(ExecResult(stdout=b"'Pin'\n", stderr=b"boom")),
                symbols,
                "hw",
            ),
            [],
        )
        self.assertEqual(
            query_device_attributes(
                transport,
                FakeGate(error=TransportError("broken")),
                symbols,
                "hw",
            ),
            [],
        )

    def test_repl_semantics_wraps_top_level_expressions(self) -> None:
        helper_source = build_helper_source()
        self.assertIn("last_non_none_repl_value", helper_source)

        source = instrument_source("1\nx = 2\nx")
        self.assertIn("__mpy_repl_helper.print_repl_value(1)", source)
        self.assertIn("x = 2", source)
        self.assertIn("__mpy_repl_helper.print_repl_value(x)", source)

        self.assertEqual(instrument_source("x = 1"), "x = 1")
        self.assertEqual(instrument_source("def broken(:\n"), "def broken(:\n")

    def test_file_control_channel_accepts_supported_commands_once(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            control_path = Path(tmp_dir) / "nested" / "control.json"
            channel = FileControlChannel(str(control_path))
            channel.prepare()
            self.assertFalse(control_path.exists())

            control_path.write_text("{bad json", encoding="utf-8")
            self.assertIsNone(channel.read_next())

            control_path.write_text(
                json.dumps({"sequence": 1, "command": "unsupported"}),
                encoding="utf-8",
            )
            self.assertIsNone(channel.read_next())

            control_path.write_text(
                json.dumps({"sequence": 1, "command": "exit"}),
                encoding="utf-8",
            )
            self.assertIsNone(channel.read_next())

            control_path.write_text(
                json.dumps({"sequence": 2, "command": "exit"}),
                encoding="utf-8",
            )
            self.assertEqual(channel.read_next(), ControlRequest(sequence=2, command="exit"))
            self.assertIsNone(channel.read_next())

            channel.clear()
            self.assertFalse(control_path.exists())

    def test_file_control_channel_handles_non_dict_and_io_failures(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            control_path = Path(tmp_dir) / "control.json"
            channel = FileControlChannel(str(control_path))
            control_path.write_text(json.dumps([1, 2, 3]), encoding="utf-8")
            self.assertIsNone(channel.read_next())

            with mock.patch.object(Path, "read_text", side_effect=OSError("boom")):
                self.assertIsNone(channel.read_next())

    def test_utf8_stream_decoder_handles_split_code_points(self) -> None:
        decoder = Utf8StreamDecoder()
        payload = "中A".encode("utf-8")

        self.assertEqual(decoder.feed(payload[:1]), "")
        self.assertEqual(decoder.feed(payload[1:3]), "中")
        self.assertEqual(decoder.feed(payload[3:]), "A")
        self.assertEqual(decoder.flush(), "")

        import decode as decode_module

        reloaded_decode = importlib.reload(decode_module)
        self.assertEqual(reloaded_decode.Utf8StreamDecoder().feed(b"A"), "A")

    def test_indent_helpers_cover_block_detection(self) -> None:
        self.assertEqual(leading_indent_prefix("    value = 1"), "    ")
        self.assertEqual(continuation_default(["if True:"]), "    ")
        self.assertEqual(continuation_default(["    value = 1"]), "    ")
        self.assertTrue(should_start_multiline("if True:"))
        self.assertFalse(should_start_multiline("value = 1"))
        self.assertTrue(is_block_complete(""))
        self.assertFalse(is_block_complete("if True:"))
        self.assertTrue(is_block_complete("if True:\n    pass\n"))

    def test_models_exec_result_and_repl_config_hold_values(self) -> None:
        import models as models_module

        reloaded_models = importlib.reload(models_module)
        result = ExecResult(stdout=b"out", stderr=b"err")
        self.assertEqual(result.stdout, b"out")
        self.assertEqual(result.stderr, b"err")

        repl_config = reloaded_models.ReplConfig(
            port="COM4",
            baudrate=230400,
            soft_reset_on_connect=True,
        )
        self.assertEqual(repl_config.port, "COM4")
        self.assertEqual(repl_config.baudrate, 230400)
        self.assertTrue(repl_config.soft_reset_on_connect)

    def test_reload_heavy_modules_for_import_smoke(self) -> None:
        self.assertTrue(hasattr(importlib.reload(session_module), "build_prompt_session"))
        self.assertTrue(hasattr(importlib.reload(completion_engine_module), "ReplCompleter"))
        self.assertTrue(hasattr(importlib.reload(completion_state_module), "ReplSessionSymbols"))
        self.assertTrue(hasattr(importlib.reload(transport_module), "SerialReplTransport"))


if __name__ == "__main__":
    unittest.main()
