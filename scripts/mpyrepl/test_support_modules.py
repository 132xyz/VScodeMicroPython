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
import completion_fallbacks as completion_fallbacks_module
import completion_parser as completion_parser_module
import completion_state as completion_state_module
import completion_stubs as completion_stubs_module
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
from completion_fallbacks import fallback_candidates_for_expression
from completion_state import ReplSessionSymbols
from completion_state import _display_meta_for_kind
from completion_stubs import StubCompletionIndex
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
from repl_lexer import MicroPythonLexer, _append_style, build_repl_style
from transport import TransportError
from prompt_toolkit.completion import CompleteEvent
from prompt_toolkit.document import Document
from prompt_toolkit.output import DummyOutput


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


def _line_has_style(line, text: str, style_fragment: str) -> bool:
    return any(fragment == text and style_fragment in style for style, fragment in line)


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
                "--completion-root",
                "mpy",
                "--completion-root",
                "mpy/lib",
                "--dir-query-timeout",
                "3.5",
            ]
        )

        self.assertEqual(args.port, "COM4")
        self.assertEqual(args.baudrate, 230400)
        self.assertEqual(args.command, "async-repl")
        self.assertEqual(args.control_file, "control.json")
        self.assertEqual(args.stub_root, "stubs")
        self.assertEqual(args.completion_roots, ["mpy", "mpy/lib"])
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

    def test_cli_fs_parses_progress_flag(self) -> None:
        parser = build_parser()
        args = parser.parse_args(
            [
                "--port",
                "COM4",
                "fs",
                "--op",
                "write_file",
                "--path",
                "/main.py",
                "--local-path",
                "main.py",
                "--progress",
            ]
        )

        self.assertEqual(args.command, "fs")
        self.assertEqual(args.op, "write_file")
        self.assertTrue(args.progress)

    def test_cli_manager_and_repl_client_parse_rpc_options(self) -> None:
        parser = build_parser()
        manager_args = parser.parse_args(
            [
                "--port",
                "COM21",
                "manager",
                "--host",
                "127.0.0.1",
                "--manager-port",
                "50123",
                "--token",
                "tok",
                "--stub-root",
                "stubs",
                "--completion-root",
                "mpy",
                "--dir-query-timeout",
                "1.5",
            ]
        )
        client_args = parser.parse_args(
            [
                "repl-client",
                "--endpoint",
                "127.0.0.1:50123",
                "--token",
                "tok",
            ]
        )

        self.assertEqual(manager_args.command, "manager")
        self.assertEqual(manager_args.port, "COM21")
        self.assertEqual(manager_args.manager_port, 50123)
        self.assertEqual(manager_args.token, "tok")
        self.assertEqual(manager_args.stub_root, "stubs")
        self.assertEqual(manager_args.completion_roots, ["mpy"])
        self.assertEqual(manager_args.dir_query_timeout, 1.5)
        self.assertEqual(client_args.command, "repl-client")
        self.assertEqual(client_args.endpoint, "127.0.0.1:50123")
        self.assertEqual(client_args.token, "tok")

    def test_completion_state_tracks_symbols_and_aliases(self) -> None:
        symbols = ReplSessionSymbols()
        changes = symbols.record_successful_source(
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
        self.assertEqual(symbols.resolve_runtime_expression("hw.Pin"), "__import__('machine').Pin")
        self.assertEqual(symbols.canonical_cache_key("hw.Pin"), "module:machine.Pin")
        candidate_meta = symbols.bare_candidate_meta()
        self.assertEqual(candidate_meta["hw"], "session module")
        self.assertEqual(candidate_meta["sine"], "session import")
        self.assertEqual(candidate_meta["func"], "session function")
        self.assertEqual(candidate_meta["Demo"], "session class")
        self.assertEqual(candidate_meta["value"], "session variable")
        self.assertTrue(changes.clear_runtime_cache)

        rebind_changes = symbols.record_successful_source("hw = object()")
        self.assertIn("hw", rebind_changes.rebound_roots)
        self.assertIsNone(symbols.resolve_module_alias("hw"))
        self.assertEqual(symbols.resolve_runtime_expression("hw.Pin"), "hw.Pin")
        self.assertEqual(symbols.canonical_cache_key("hw.Pin"), "expr:hw.Pin")

        delete_changes = symbols.record_successful_source("del value")
        self.assertIn("value", delete_changes.rebound_roots)
        self.assertNotIn("value", symbols.bare_candidates())
        self.assertNotIn("value", symbols.bare_candidate_meta())

        attr_delete_changes = symbols.record_successful_source("del hw.attr")
        self.assertIn("hw", attr_delete_changes.mutated_roots)

        symbols.record_successful_source("pin = machine.Pin()\nalias_pin = pin")
        self.assertEqual(symbols.resolve_static_expression("pin.value"), "machine.Pin().value")
        self.assertEqual(symbols.resolve_static_expression("alias_pin.value"), "machine.Pin().value")

        symbols.record_successful_source(
            """
config = {"wifi": 1, "mode": 2, 1: "skip", "wifi": 3}
alias_config = config
""".strip()
        )
        self.assertEqual(symbols.dict_key_candidates("config"), ["wifi", "mode"])
        self.assertEqual(symbols.dict_key_candidates("alias_config"), ["wifi", "mode"])
        self.assertEqual(symbols.dict_key_candidates("config['wifi']"), [])

        dict_changes = symbols.record_successful_source('config["new"] = 1')
        self.assertIn("config", dict_changes.mutated_roots)
        self.assertEqual(symbols.dict_key_candidates("config"), [])

        symbols.record_successful_source('config = {"again": 1}')
        self.assertEqual(symbols.dict_key_candidates("config"), ["again"])
        symbols.record_successful_source("config = {}")
        self.assertEqual(symbols.dict_key_candidates("config"), [])

        symbols.record_successful_source(
            """
typed_pin: machine.Pin
indexed_item = items[0]
quoted_pin: "machine.Pin"
loop_a = loop_b
loop_b = loop_a
with ctx():
    pass
""".strip()
        )
        self.assertEqual(symbols.resolve_static_expression("typed_pin.value"), "machine.Pin.value")
        self.assertEqual(symbols.resolve_static_expression("indexed_item.value"), "items[0].value")
        self.assertEqual(symbols.resolve_static_expression("quoted_pin.value"), '"machine.Pin".value')
        self.assertEqual(symbols.resolve_static_expression("loop_a.value"), "loop_a.value")
        self.assertEqual(_display_meta_for_kind("unknown"), "session")

        symbols.record_successful_source("def broken(:\n")

        symbols.clear()
        self.assertEqual(symbols.bare_candidates(), {"_"})
        self.assertIsNone(symbols.resolve_module_alias("hw"))

    def test_repl_lexer_marks_micropython_and_session_names(self) -> None:
        symbols = ReplSessionSymbols()
        symbols.record_successful_source(
            """
import lvgl as lv
from math import sin as sine
value = 1
class Widget:
    pass
def make():
    pass
""".strip()
        )

        lexer = MicroPythonLexer(session_symbols=symbols, module_names={"lvgl"})
        document = Document(
            "lvgl.obj()\nlv.obj()\nmake(value)\nWidget()\nsine(1)\nconst(1)\nunknown",
            cursor_position=0,
        )
        get_line = lexer.lex_document(document)

        self.assertTrue(_line_has_style(get_line(0), "lvgl", "class:mpyrepl.module"))
        self.assertTrue(_line_has_style(get_line(1), "lv", "class:mpyrepl.session.module"))
        self.assertTrue(
            _line_has_style(get_line(2), "make", "class:mpyrepl.session.function")
        )
        self.assertTrue(
            _line_has_style(get_line(2), "value", "class:mpyrepl.session.variable")
        )
        self.assertTrue(
            _line_has_style(get_line(3), "Widget", "class:mpyrepl.session.class")
        )
        self.assertTrue(
            _line_has_style(get_line(4), "sine", "class:mpyrepl.session.import")
        )
        self.assertTrue(_line_has_style(get_line(5), "const", "class:mpyrepl.builtin"))
        self.assertFalse(_line_has_style(get_line(6), "unknown", "class:mpyrepl."))

        definition_lexer = MicroPythonLexer()
        definition_line = definition_lexer.lex_document(
            Document("class LocalWidget:\n    pass\ndef create_widget():\n    pass")
        )
        self.assertTrue(
            _line_has_style(
                definition_line(0),
                "LocalWidget",
                "class:mpyrepl.session.class",
            )
        )
        self.assertTrue(
            _line_has_style(
                definition_line(2),
                "create_widget",
                "class:mpyrepl.session.function",
            )
        )
        self.assertTrue(
            _line_has_style(
                MicroPythonLexer().lex_document(Document("machine.Pin"))(0),
                "machine",
                "class:mpyrepl.module",
            )
        )
        self.assertEqual(MicroPythonLexer(session_symbols=object())._session_meta(), {})
        self.assertIsInstance(lexer.invalidation_hash(), tuple)
        self.assertEqual(_append_style("", "class:custom"), "class:custom")

        self.assertIsNotNone(build_repl_style())
        session = session_module.build_prompt_session(
            session_symbols=symbols,
            stub_modules={"lvgl"},
            output=DummyOutput(),
        )
        self.assertIsInstance(session.lexer, MicroPythonLexer)

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
            self.assertEqual(completer.stub_modules(), {"machine", "pkg"})

            dotted_document = Document("dynamic.P", cursor_position=len("dynamic.P"))
            auto_before_cache = list(
                completer.get_completions(
                    dotted_document,
                    CompleteEvent(text_inserted=True),
                )
            )
            self.assertEqual([item.text for item in auto_before_cache], ["Pin", "PWM"])
            self.assertEqual(
                [item.display_meta_text for item in auto_before_cache],
                ["device", "device"],
            )
            self.assertEqual(calls, [("dynamic", "P")])

            first = [item.text for item in completer.get_completions(dotted_document, None)]
            second = [item.text for item in completer.get_completions(dotted_document, None)]
            self.assertEqual(first, ["Pin", "PWM"])
            self.assertEqual(second, ["Pin", "PWM"])
            self.assertEqual(calls, [("dynamic", "P")])

            narrower_document = Document("dynamic.Pi", cursor_position=len("dynamic.Pi"))
            narrower = [
                item.text
                for item in completer.get_completions(
                    narrower_document,
                    CompleteEvent(text_inserted=True),
                )
            ]
            self.assertEqual(narrower, ["Pin"])
            self.assertEqual(calls, [("dynamic", "P")])

            completer.clear_runtime_cache()
            auto_after_clear = list(
                completer.get_completions(
                    dotted_document,
                    CompleteEvent(text_inserted=True),
                )
            )
            self.assertEqual([item.text for item in auto_after_clear], ["Pin", "PWM"])
            self.assertEqual(calls, [("dynamic", "P"), ("dynamic", "P")])
            third = [item.text for item in completer.get_completions(dotted_document, None)]
            self.assertEqual(third, ["Pin", "PWM"])
            self.assertEqual(calls, [("dynamic", "P"), ("dynamic", "P")])

            bare_document = Document("ali", cursor_position=3)
            bare_items = list(completer.get_completions(bare_document, None))
            bare_meta = {item.text: item.display_meta_text for item in bare_items}
            self.assertIn("alias_name", bare_meta)
            self.assertEqual(bare_meta["alias_name"], "session variable")

            meta_document = Document(":q", cursor_position=2)
            meta_items = list(completer.get_completions(meta_document, None))
            meta_names = [item.text for item in meta_items]
            self.assertEqual(meta_names, [":q", ":quit"])
            self.assertEqual([item.display_meta_text for item in meta_items], ["meta", "meta"])

    def test_completion_engine_ranks_candidates_for_interactive_use(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            stub_root = Path(tmp_dir)
            (stub_root / "lvgl.pyi").write_text(
                """
class _private: ...
class zzz: ...
class arc: ...
class obj: ...
class label: ...
def align() -> None: ...
def set_text(value) -> None: ...
""".strip(),
                encoding="utf-8",
            )

            symbols = ReplSessionSymbols()
            symbols.record_successful_source("time = 1\nprint = 2")
            completer = ReplCompleter(symbols, stub_root=str(stub_root))

            bare_items = list(
                completer.get_completions(Document("ti", cursor_position=len("ti")), None)
            )
            self.assertEqual(bare_items[0].text, "time")
            self.assertEqual(bare_items[0].display_meta_text, "session variable")

            print_items = list(
                completer.get_completions(Document("pri", cursor_position=len("pri")), None)
            )
            self.assertEqual(print_items[0].text, "print")
            self.assertEqual(print_items[0].display_meta_text, "session variable")

            lvgl_items = list(
                completer.get_completions(Document("lvgl.", cursor_position=len("lvgl.")), None)
            )
            lvgl_names = [item.text for item in lvgl_items]
            self.assertEqual(lvgl_names[:5], ["obj", "label", "arc", "align", "set_text"])
            self.assertIn("zzz", lvgl_names)
            self.assertIn("btn", lvgl_names)

    def test_completion_engine_ranks_large_device_candidates_from_cache(self) -> None:
        calls: list[tuple[str, str]] = []

        def dotted_provider(expression: str, prefix: str):
            calls.append((expression, prefix))
            return [
                *(f"a{i:04d}" for i in range(200)),
                "align",
                "arc",
                "Pin",
                "_private",
            ]

        completer = ReplCompleter(ReplSessionSymbols(), dotted_provider=dotted_provider)

        all_items = list(
            completer.get_completions(
                Document("dynamic.", cursor_position=len("dynamic.")),
                CompleteEvent(text_inserted=True),
            )
        )
        first_items = list(
            completer.get_completions(
                Document("dynamic.a", cursor_position=len("dynamic.a")),
                CompleteEvent(text_inserted=True),
            )
        )
        second_items = list(
            completer.get_completions(
                Document("dynamic.al", cursor_position=len("dynamic.al")),
                CompleteEvent(text_inserted=True),
            )
        )

        self.assertEqual(all_items[0].text, "Pin")
        self.assertEqual(all_items[-1].text, "_private")
        self.assertEqual([item.text for item in first_items[:2]], ["arc", "align"])
        self.assertEqual([item.text for item in second_items], ["align"])
        self.assertEqual(calls, [("dynamic", "")])

    def test_completion_engine_uses_common_module_fallbacks_without_stub_or_device(self) -> None:
        calls: list[tuple[str, str]] = []

        def dotted_provider(expression: str, prefix: str):
            calls.append((expression, prefix))
            return ["device_only"]

        symbols = ReplSessionSymbols()
        symbols.record_successful_source("import lvgl as lv")
        completer = ReplCompleter(symbols, dotted_provider=dotted_provider)

        lvgl_items = list(
            completer.get_completions(
                Document("lvgl.", cursor_position=len("lvgl.")),
                CompleteEvent(text_inserted=True),
            )
        )
        lvgl_names = [item.text for item in lvgl_items]
        self.assertIn("obj", lvgl_names)
        self.assertIn("label", lvgl_names)
        self.assertIn("arc", lvgl_names)
        self.assertEqual(calls, [])

        alias_items = list(
            completer.get_completions(
                Document("lv.a", cursor_position=len("lv.a")),
                CompleteEvent(text_inserted=True),
            )
        )
        self.assertEqual([item.text for item in alias_items[:2]], ["arc", "anim_t"])
        self.assertEqual(calls, [])

        t_items = list(
            completer.get_completions(
                Document("lv.t", cursor_position=len("lv.t")),
                CompleteEvent(text_inserted=True),
            )
        )
        t_names = [item.text for item in t_items]
        self.assertIn("textarea", t_names)
        self.assertIn("tick_get", t_names)
        self.assertIn("tileview", t_names)
        self.assertEqual(calls, [])

        object_items = list(
            completer.get_completions(
                Document("lvgl.obj().a", cursor_position=len("lvgl.obj().a")),
                CompleteEvent(text_inserted=True),
            )
        )
        self.assertEqual([item.text for item in object_items], ["align", "add_event_cb", "add_flag"])
        self.assertEqual(calls, [])

        from_import_items = list(
            completer.get_completions(
                Document("from lvgl import la", cursor_position=len("from lvgl import la")),
                CompleteEvent(text_inserted=True),
            )
        )
        self.assertEqual([item.text for item in from_import_items], ["label"])
        self.assertEqual(calls, [])

        manual_items = list(
            completer.get_completions(
                Document("lvgl.device", cursor_position=len("lvgl.device")),
                CompleteEvent(completion_requested=True),
            )
        )
        self.assertEqual([item.text for item in manual_items], ["device_only"])
        self.assertEqual(calls, [("lvgl", "device")])

    def test_completion_fallbacks_cover_modules_aliases_classes_and_invalid_expressions(self) -> None:
        reloaded = importlib.reload(completion_fallbacks_module)
        symbols = ReplSessionSymbols()
        symbols.record_successful_source("import lvgl as lv")

        lv_candidates = reloaded.fallback_candidates_for_expression("lv", symbols)
        self.assertEqual(lv_candidates["label"], "fallback class")
        self.assertEqual(lv_candidates["screen_active"], "fallback function")

        obj_call_candidates = fallback_candidates_for_expression("lv.obj()", symbols)
        self.assertEqual(obj_call_candidates["set_size"], "fallback function")
        self.assertEqual(obj_call_candidates["get_width"], "fallback function")
        self.assertEqual(
            fallback_candidates_for_expression("lv.obj", symbols)["align"],
            "fallback function",
        )
        self.assertEqual(
            fallback_candidates_for_expression("lv.label()", symbols)["set_text"],
            "fallback function",
        )
        self.assertEqual(fallback_candidates_for_expression("machine.Pin()", symbols), {})
        self.assertEqual(fallback_candidates_for_expression("1 +", symbols), {})
        self.assertEqual(fallback_candidates_for_expression("(1 + 2)", symbols), {})

    def test_completion_engine_merges_device_cache_with_sparse_fallbacks(self) -> None:
        calls: list[tuple[str, str]] = []

        def dotted_provider(expression: str, prefix: str):
            calls.append((expression, prefix))
            return [
                "textarea",
                "tick_elaps",
                "tick_get",
                "tick_inc",
                "tick_set_cb",
                "tick_state_t",
                "tileview",
                "tileview_class",
                "theme_apply",
                "timer_handler",
            ]

        symbols = ReplSessionSymbols()
        symbols.record_successful_source("import lvgl as vl")
        completer = ReplCompleter(symbols, dotted_provider=dotted_provider)

        manual_ti_items = list(
            completer.get_completions(
                Document("vl.ti", cursor_position=len("vl.ti")),
                CompleteEvent(completion_requested=True),
            )
        )
        self.assertIn("tick_get", [item.text for item in manual_ti_items])
        self.assertEqual(calls, [("vl", "ti")])

        auto_t_items = list(
            completer.get_completions(
                Document("vl.t", cursor_position=len("vl.t")),
                CompleteEvent(text_inserted=True),
            )
        )
        auto_t_names = [item.text for item in auto_t_items]
        self.assertIn("textarea", auto_t_names)
        self.assertIn("tick_get", auto_t_names)
        self.assertIn("timer_handler", auto_t_names)
        self.assertEqual(calls, [("vl", "ti")])

    def test_completion_engine_completes_known_dict_keys_inside_subscript_strings(self) -> None:
        calls: list[tuple[str, str]] = []

        def dotted_provider(expression: str, prefix: str):
            calls.append((expression, prefix))
            return ["should_not_query"]

        symbols = ReplSessionSymbols()
        symbols.record_successful_source(
            """
config = {"wifi": 1, "mode": 2, "host-name": "demo"}
alias_config = config
""".strip()
        )
        completer = ReplCompleter(symbols, dotted_provider=dotted_provider)

        double_quote_items = list(
            completer.get_completions(
                Document('config["w', cursor_position=len('config["w')),
                CompleteEvent(text_inserted=True),
            )
        )
        self.assertEqual([item.text for item in double_quote_items], ['wifi"]'])
        self.assertEqual([item.display_text for item in double_quote_items], ["wifi"])
        self.assertEqual([item.display_meta_text for item in double_quote_items], ["session key"])

        single_quote_items = list(
            completer.get_completions(
                Document("alias_config['m", cursor_position=len("alias_config['m")),
                CompleteEvent(text_inserted=True),
            )
        )
        self.assertEqual([item.text for item in single_quote_items], ["mode']"])

        hyphen_items = list(
            completer.get_completions(
                Document('config["host', cursor_position=len('config["host')),
                CompleteEvent(text_inserted=True),
            )
        )
        self.assertEqual([item.text for item in hyphen_items], ['host-name"]'])

        changes = symbols.record_successful_source('config["new"] = 1')
        completer.invalidate_runtime_cache(
            rebound_roots=changes.rebound_roots,
            mutated_roots=changes.mutated_roots,
            clear_all=changes.clear_runtime_cache,
        )
        self.assertEqual(
            list(
                completer.get_completions(
                    Document('config["w', cursor_position=len('config["w')),
                    CompleteEvent(text_inserted=True),
                )
            ),
            [],
        )
        self.assertEqual(calls, [])

    def test_runtime_cache_survives_unrelated_execution_and_invalidates_precisely(self) -> None:
        calls: list[tuple[str, str]] = []

        def dotted_provider(expression: str, prefix: str):
            calls.append((expression, prefix))
            return ["Pin", "PWM"]

        symbols = ReplSessionSymbols()
        changes = symbols.record_successful_source("import customhw\nimport customhw as hw")
        completer = ReplCompleter(symbols, dotted_provider=dotted_provider)

        hw_document = Document("hw.P", cursor_position=len("hw.P"))
        module_document = Document("customhw.Pi", cursor_position=len("customhw.Pi"))
        self.assertEqual(
            [item.text for item in completer.get_completions(hw_document, None)],
            ["Pin", "PWM"],
        )
        self.assertEqual(calls, [("hw", "P")])

        self.assertEqual(
            [item.text for item in completer.get_completions(module_document, None)],
            ["Pin"],
        )
        self.assertEqual(calls, [("hw", "P")])

        changes = symbols.record_successful_source("value = 1")
        completer.invalidate_runtime_cache(
            rebound_roots=changes.rebound_roots,
            mutated_roots=changes.mutated_roots,
            clear_all=changes.clear_runtime_cache,
        )
        self.assertEqual(
            [item.text for item in completer.get_completions(module_document, None)],
            ["Pin"],
        )
        self.assertEqual(calls, [("hw", "P")])

        changes = symbols.record_successful_source("customhw = object()")
        completer.invalidate_runtime_cache(
            rebound_roots=changes.rebound_roots,
            mutated_roots=changes.mutated_roots,
            clear_all=changes.clear_runtime_cache,
        )
        self.assertEqual(
            [item.text for item in completer.get_completions(module_document, None)],
            ["Pin"],
        )
        self.assertEqual(calls, [("hw", "P"), ("customhw", "Pi")])

        changes = symbols.record_successful_source("import customhw")
        completer.invalidate_runtime_cache(
            rebound_roots=changes.rebound_roots,
            mutated_roots=changes.mutated_roots,
            clear_all=changes.clear_runtime_cache,
        )
        self.assertEqual(
            [item.text for item in completer.get_completions(module_document, None)],
            ["Pin"],
        )
        self.assertEqual(calls, [("hw", "P"), ("customhw", "Pi")])

        changes = symbols.record_successful_source("setattr(customhw, 'Pin', object())")
        completer.invalidate_runtime_cache(
            rebound_roots=changes.rebound_roots,
            mutated_roots=changes.mutated_roots,
            clear_all=changes.clear_runtime_cache,
        )
        self.assertEqual(
            [item.text for item in completer.get_completions(module_document, None)],
            ["Pin"],
        )
        self.assertEqual(calls, [("hw", "P"), ("customhw", "Pi"), ("customhw", "Pi")])

    def test_runtime_cache_invalidates_subscript_and_call_expressions_by_root(self) -> None:
        calls: list[tuple[str, str]] = []

        def dotted_provider(expression: str, prefix: str):
            calls.append((expression, prefix))
            return ["value"]

        symbols = ReplSessionSymbols()
        completer = ReplCompleter(symbols, dotted_provider=dotted_provider)

        item_document = Document("items[0].v", cursor_position=len("items[0].v"))
        factory_document = Document("factory().v", cursor_position=len("factory().v"))
        self.assertEqual(
            [item.text for item in completer.get_completions(item_document, None)],
            ["value"],
        )
        self.assertEqual(
            [item.text for item in completer.get_completions(factory_document, None)],
            ["value"],
        )
        self.assertEqual(calls, [("items[0]", "v"), ("factory()", "v")])

        changes = symbols.record_successful_source("items = []\nfactory = lambda: None")
        completer.invalidate_runtime_cache(
            rebound_roots=changes.rebound_roots,
            mutated_roots=changes.mutated_roots,
            clear_all=changes.clear_runtime_cache,
        )
        self.assertEqual(
            [item.text for item in completer.get_completions(item_document, None)],
            ["value"],
        )
        self.assertEqual(
            [item.text for item in completer.get_completions(factory_document, None)],
            ["value"],
        )
        self.assertEqual(
            calls,
            [
                ("items[0]", "v"),
                ("factory()", "v"),
                ("items[0]", "v"),
                ("factory()", "v"),
            ],
        )

    def test_stub_index_serves_dotted_candidates_without_device_query(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            stub_root = Path(tmp_dir)
            (stub_root / "machine.pyi").write_text(
                """
from other import imported_name
CONST: int
class NeoPixel:
    def __init__(self, pin: int, n: int, bpp: int = 3, timing: int = 1) -> None: ...
class Pin:
    def __init__(self, id, mode=None, *, pull=None, value=None) -> None: ...
    value: int
    def init(self) -> None: ...
class PWM:
    pass
def create_pin() -> Pin: ...
def create_pwm() -> "PWM": ...
def optional_pin() -> Optional[Pin]: ...
def reset(pin: Pin, hard=False) -> None: ...
""".strip(),
                encoding="utf-8",
            )
            (stub_root / "pkg").mkdir()
            (stub_root / "pkg" / "__init__.pyi").write_text(
                "class Device:\n    def open(self) -> None: ...\n",
                encoding="utf-8",
            )
            (stub_root / "pkg" / "sub.pyi").write_text(
                "class Helper:\n    attr: int\n",
                encoding="utf-8",
            )
            (stub_root / "localmod.py").write_text(
                """
VALUE = 1
class LocalDevice:
    def open(self) -> None:
        pass
def create_device() -> LocalDevice:
    return LocalDevice()
""".strip(),
                encoding="utf-8",
            )
            (stub_root / "broken.pyi").write_text("def broken(:\n", encoding="utf-8")

            index = StubCompletionIndex(str(stub_root))
            self.assertEqual(index.module_names(), {"broken", "localmod", "machine", "pkg"})

            symbols = ReplSessionSymbols()
            symbols.record_successful_source("import machine as hw")
            self.assertEqual(
                index.candidates_for_expression("hw", symbols),
                {
                    "CONST": "stub attribute",
                    "NeoPixel": "stub class (pin: int, n: int, bpp: int = 3, timing: int = 1)",
                    "PWM": "stub class",
                    "Pin": "stub class (id, mode=None, *, pull=None, value=None)",
                    "create_pin": "stub function () -> Pin",
                    "create_pwm": "stub function () -> PWM",
                    "imported_name": "stub import",
                    "optional_pin": "stub function () -> Optional[Pin]",
                    "reset": "stub function (pin: Pin, hard=False) -> None",
                },
            )
            self.assertEqual(
                index.candidates_for_expression("machine.Pin", symbols),
                {"init": "stub function () -> None", "value": "stub attribute"},
            )
            self.assertEqual(
                index.parameter_candidates_for_call("machine.Pin", frozenset({"id"}), symbols),
                {
                    "mode=": "mode=None",
                    "pull=": "pull=None",
                    "value=": "value=None",
                },
            )
            self.assertEqual(
                index.parameter_candidates_for_call("machine.NeoPixel", frozenset({"pin"}), symbols),
                {
                    "n=": "n: int",
                    "bpp=": "bpp: int = 3",
                    "timing=": "timing: int = 1",
                },
            )
            self.assertEqual(
                index.parameter_candidates_for_call("machine.reset", frozenset(), symbols),
                {"pin=": "pin: Pin", "hard=": "hard=False"},
            )
            self.assertEqual(
                index.candidates_for_expression("machine.Pin()", symbols),
                {"init": "stub function () -> None", "value": "stub attribute"},
            )
            self.assertEqual(
                index.candidates_for_expression("machine.create_pin()", symbols),
                {"init": "stub function () -> None", "value": "stub attribute"},
            )
            self.assertEqual(
                index.candidates_for_expression("machine.create_pwm()", symbols),
                {},
            )
            self.assertEqual(
                index.candidates_for_expression("machine.optional_pin()", symbols),
                {"init": "stub function () -> None", "value": "stub attribute"},
            )
            symbols.record_successful_source("pin = machine.create_pin()")
            self.assertEqual(
                index.candidates_for_expression("pin", symbols),
                {"init": "stub function () -> None", "value": "stub attribute"},
            )
            self.assertEqual(
                index.candidates_for_expression("pkg.Device", symbols),
                {"open": "stub function () -> None"},
            )
            self.assertEqual(
                index.candidates_for_expression("pkg.sub.Helper", symbols),
                {"attr": "stub attribute"},
            )
            self.assertEqual(
                index.candidates_for_expression("localmod", symbols),
                {
                    "LocalDevice": "stub class",
                    "VALUE": "stub attribute",
                    "create_device": "stub function () -> LocalDevice",
                },
            )
            self.assertEqual(
                index.candidates_for_expression("localmod.create_device()", symbols),
                {"open": "stub function () -> None"},
            )
            self.assertEqual(index.candidates_for_expression("missing", symbols), {})

    def test_stub_index_reads_multiple_completion_roots_without_overlay_copy(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            base_dir = Path(tmp_dir)
            stub_root = base_dir / "stubs"
            source_root = base_dir / "mpy"
            stub_root.mkdir()
            source_root.mkdir()
            (stub_root / "machine.pyi").write_text("class Pin:\n    pass\n", encoding="utf-8")
            (stub_root / "dupe.pyi").write_text("class StubOnly:\n    pass\n", encoding="utf-8")
            (source_root / "project.py").write_text(
                "class ProjectDevice:\n    def start(self) -> None:\n        pass\n",
                encoding="utf-8",
            )
            (source_root / "dupe.py").write_text("class SourceOnly:\n    pass\n", encoding="utf-8")

            index = StubCompletionIndex([str(stub_root), str(source_root)])
            symbols = ReplSessionSymbols()

            self.assertEqual(index.module_names(), {"dupe", "machine", "project"})
            self.assertEqual(
                index.candidates_for_expression("project.ProjectDevice", symbols),
                {"start": "stub function () -> None"},
            )
            self.assertEqual(
                index.candidates_for_expression("dupe", symbols),
                {"StubOnly": "stub class"},
            )

    def test_repl_completer_prefers_stub_dotted_candidates_and_uses_device_fallback(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            stub_root = Path(tmp_dir)
            (stub_root / "machine.pyi").write_text(
                """
class Pin:
    def __init__(self, id, mode=None, *, pull=None, value=None) -> None: ...
    value: int
    def init(self) -> None: ...
class PWM:
    pass
def create_pin() -> Pin: ...
""".strip(),
                encoding="utf-8",
            )

            calls: list[tuple[str, str]] = []

            def dotted_provider(expression: str, prefix: str):
                calls.append((expression, prefix))
                return ["Zero"]

            symbols = ReplSessionSymbols()
            symbols.record_successful_source("import machine as hw")
            completer = ReplCompleter(
                symbols,
                stub_root=str(stub_root),
                dotted_provider=dotted_provider,
            )

            stub_document = Document("hw.P", cursor_position=len("hw.P"))
            stub_items = list(
                completer.get_completions(
                    stub_document,
                    CompleteEvent(text_inserted=True),
                )
            )
            self.assertEqual([item.text for item in stub_items], ["Pin", "PWM"])
            self.assertEqual(
                [item.display_meta_text for item in stub_items],
                ["stub class (id, mode=None, *, pull=None, value=None)", "stub class"],
            )
            self.assertEqual(calls, [])

            call_items = list(
                completer.get_completions(
                    Document("machine.Pin(", cursor_position=len("machine.Pin(")),
                    CompleteEvent(text_inserted=True),
                )
            )
            self.assertEqual([item.text for item in call_items], ["id=", "mode=", "pull=", "value="])
            self.assertEqual(
                [item.display_meta_text for item in call_items],
                ["stub parameter", "mode=None", "pull=None", "value=None"],
            )

            prefixed_call_items = list(
                completer.get_completions(
                    Document("machine.Pin(id=1, m", cursor_position=len("machine.Pin(id=1, m")),
                    CompleteEvent(text_inserted=True),
                )
            )
            self.assertEqual([item.text for item in prefixed_call_items], ["mode="])

            member_document = Document("machine.Pin.v", cursor_position=len("machine.Pin.v"))
            member_items = list(completer.get_completions(member_document, None))
            self.assertEqual([item.text for item in member_items], ["value"])
            self.assertEqual([item.display_meta_text for item in member_items], ["stub attribute"])
            self.assertEqual(calls, [])

            returned_document = Document("machine.create_pin().v", cursor_position=len("machine.create_pin().v"))
            returned_items = list(completer.get_completions(returned_document, None))
            self.assertEqual([item.text for item in returned_items], ["value"])
            self.assertEqual(calls, [])

            symbols.record_successful_source("pin = machine.create_pin()")
            variable_document = Document("pin.v", cursor_position=len("pin.v"))
            variable_items = list(completer.get_completions(variable_document, None))
            self.assertEqual([item.text for item in variable_items], ["value"])
            self.assertEqual([item.display_meta_text for item in variable_items], ["stub attribute"])
            self.assertEqual(calls, [])

            auto_miss_document = Document("machine.Z", cursor_position=len("machine.Z"))
            self.assertEqual(
                list(
                    completer.get_completions(
                        auto_miss_document,
                        CompleteEvent(text_inserted=True),
                    )
                ),
                [],
            )
            self.assertEqual(calls, [])

            tab_miss_items = list(
                completer.get_completions(
                    auto_miss_document,
                    CompleteEvent(completion_requested=True),
                )
            )
            self.assertEqual([item.text for item in tab_miss_items], ["Zero"])
            self.assertEqual([item.display_meta_text for item in tab_miss_items], ["device"])
            self.assertEqual(calls, [("machine", "Z")])

            no_stub_document = Document("dynamic.Z", cursor_position=len("dynamic.Z"))
            no_stub_items = list(completer.get_completions(no_stub_document, None))
            self.assertEqual([item.text for item in no_stub_items], ["Zero"])
            self.assertEqual(calls, [("machine", "Z"), ("dynamic", "Z")])

    def test_repl_completer_completes_from_import_members(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            stub_root = Path(tmp_dir)
            (stub_root / "machine.pyi").write_text(
                """
class Pin:
    def __init__(self, id, mode=None, *, pull=None, value=None) -> None: ...
class PWM:
    pass
def reset(pin: Pin, hard=False) -> None: ...
""".strip(),
                encoding="utf-8",
            )

            calls: list[tuple[str, str]] = []

            def dotted_provider(expression: str, prefix: str):
                calls.append((expression, prefix))
                return ["Zero"]

            completer = ReplCompleter(
                ReplSessionSymbols(),
                stub_root=str(stub_root),
                dotted_provider=dotted_provider,
            )

            stub_items = list(
                completer.get_completions(
                    Document("from machine import P", cursor_position=len("from machine import P")),
                    CompleteEvent(text_inserted=True),
                )
            )
            self.assertEqual([item.text for item in stub_items], ["Pin", "PWM"])
            self.assertEqual(
                [item.display_meta_text for item in stub_items],
                ["stub class (id, mode=None, *, pull=None, value=None)", "stub class"],
            )
            self.assertEqual(calls, [])

            filtered_items = list(
                completer.get_completions(
                    Document(
                        "from machine import Pin, P",
                        cursor_position=len("from machine import Pin, P"),
                    ),
                    CompleteEvent(text_inserted=True),
                )
            )
            self.assertEqual([item.text for item in filtered_items], ["PWM"])
            self.assertEqual(calls, [])

            auto_miss_items = list(
                completer.get_completions(
                    Document("from machine import Z", cursor_position=len("from machine import Z")),
                    CompleteEvent(text_inserted=True),
                )
            )
            self.assertEqual(auto_miss_items, [])
            self.assertEqual(calls, [])

            tab_miss_items = list(
                completer.get_completions(
                    Document("from machine import Z", cursor_position=len("from machine import Z")),
                    CompleteEvent(completion_requested=True),
                )
            )
            self.assertEqual([item.text for item in tab_miss_items], ["Zero"])
            self.assertEqual([item.display_meta_text for item in tab_miss_items], ["device"])
            self.assertEqual(calls, [("machine", "Z")])

    def test_stub_index_handles_edge_roots_and_annotation_forms(self) -> None:
        self.assertEqual(StubCompletionIndex(None).module_names(), set())
        self.assertEqual(StubCompletionIndex("missing-stub-root").module_names(), set())

        with tempfile.TemporaryDirectory() as tmp_dir:
            stub_root = Path(tmp_dir)
            hidden_dir = stub_root / ".hidden"
            hidden_dir.mkdir()
            (hidden_dir / "ignored.pyi").write_text("VALUE: int\n", encoding="utf-8")
            (stub_root / "bad.pyi").write_text("def broken(:\n", encoding="utf-8")
            (stub_root / "lvgl.pyi").write_text(
                """
class obj:
    def align(self) -> None: ...
class label:
    def set_text(self, value: str) -> None: ...
def create_obj() -> obj | None: ...
def create_label() -> "label": ...
def external() -> other.Widget: ...
""".strip(),
                encoding="utf-8",
            )

            index = StubCompletionIndex(str(stub_root))
            symbols = ReplSessionSymbols()
            self.assertEqual(index.module_names(), {"bad", "lvgl"})
            self.assertEqual(index.candidates_for_expression("bad", symbols), {})
            self.assertEqual(
                index.candidates_for_expression("lvgl.create_obj()", symbols),
                {"align": "stub function () -> None"},
            )
            self.assertEqual(
                index.candidates_for_expression("lvgl.create_label()", symbols),
                {"set_text": "stub function (value: str) -> None"},
            )
            self.assertEqual(
                index.candidates_for_expression('"lvgl.obj"', symbols),
                {"align": "stub function () -> None"},
            )
            self.assertEqual(index.candidates_for_expression("lvgl.external()", symbols), {})
            self.assertEqual(index.candidates_for_expression("bad syntax(", symbols), {})

    def test_runtime_negative_cache_throttles_repeated_empty_results(self) -> None:
        calls: list[tuple[str, str]] = []
        now = [10.0]

        def dotted_provider(expression: str, prefix: str):
            calls.append((expression, prefix))
            return []

        completer = ReplCompleter(
            ReplSessionSymbols(),
            dotted_provider=dotted_provider,
            clock=lambda: now[0],
        )

        first_document = Document("missing.a", cursor_position=len("missing.a"))
        second_document = Document("missing.ab", cursor_position=len("missing.ab"))
        self.assertEqual(list(completer.get_completions(first_document, None)), [])
        self.assertEqual(list(completer.get_completions(second_document, None)), [])
        self.assertEqual(calls, [("missing", "a")])

        now[0] += 2.1
        self.assertEqual(list(completer.get_completions(second_document, None)), [])
        self.assertEqual(calls, [("missing", "a"), ("missing", "ab")])

    def test_device_completion_uses_short_auto_timeout_and_manual_refresh(self) -> None:
        calls: list[tuple[str, str, float | None]] = []

        def dotted_provider(expression: str, prefix: str, timeout: float | None):
            calls.append((expression, prefix, timeout))
            if timeout is not None and timeout < 1.0:
                return []
            return ["Pin"]

        completer = ReplCompleter(
            ReplSessionSymbols(),
            dotted_provider=dotted_provider,
            auto_device_timeout=0.25,
            manual_device_timeout=3.0,
            clock=lambda: 10.0,
        )

        first_document = Document("dynamic.P", cursor_position=len("dynamic.P"))
        second_document = Document("dynamic.Pi", cursor_position=len("dynamic.Pi"))
        self.assertEqual(
            list(
                completer.get_completions(
                    first_document,
                    CompleteEvent(text_inserted=True),
                )
            ),
            [],
        )
        self.assertEqual(
            list(
                completer.get_completions(
                    second_document,
                    CompleteEvent(text_inserted=True),
                )
            ),
            [],
        )
        self.assertEqual(calls, [("dynamic", "P", 0.25)])

        manual_items = list(
            completer.get_completions(
                second_document,
                CompleteEvent(completion_requested=True),
            )
        )
        self.assertEqual([item.text for item in manual_items], ["Pin"])
        self.assertEqual(calls, [("dynamic", "P", 0.25), ("dynamic", "Pi", 3.0)])

        cached_items = list(
            completer.get_completions(
                second_document,
                CompleteEvent(text_inserted=True),
            )
        )
        self.assertEqual([item.text for item in cached_items], ["Pin"])
        self.assertEqual(calls, [("dynamic", "P", 0.25), ("dynamic", "Pi", 3.0)])

    def test_completion_engine_covers_metadata_and_cache_edge_paths(self) -> None:
        self.assertEqual(discover_stub_modules(None), set())
        self.assertEqual(discover_stub_modules("missing-stub-root"), set())

        no_provider = ReplCompleter(ReplSessionSymbols())
        dotted_document = Document("machine.P", cursor_position=len("machine.P"))
        self.assertTrue(no_provider.has_completion_target(dotted_document))
        self.assertFalse(no_provider.has_completion_target(Document("1 + 2", cursor_position=5)))
        machine_fallback_items = list(no_provider.get_completions(dotted_document, None))
        self.assertEqual([item.text for item in machine_fallback_items], ["Pin", "PWM"])
        self.assertEqual(
            [item.display_meta_text for item in machine_fallback_items],
            ["fallback class", "fallback class"],
        )
        self.assertEqual(
            list(
                no_provider.get_completions(
                    Document("dynamic.P", cursor_position=len("dynamic.P")),
                    None,
                )
            ),
            [],
        )

        with tempfile.TemporaryDirectory() as tmp_dir:
            stub_root = Path(tmp_dir)
            (stub_root / "custom_mod.pyi").write_text("", encoding="utf-8")

            symbols = ReplSessionSymbols()
            symbols.record_successful_source("session_name = 1")
            completer = ReplCompleter(symbols, stub_root=str(stub_root))

            checks = {
                "de": ("def", "keyword"),
                "ra": ("range", "builtin"),
                "mach": ("machine", "module"),
                "custom": ("custom_mod", "stub module"),
                "session": ("session_name", "session variable"),
            }
            for text, expected in checks.items():
                items = list(completer.get_completions(Document(text, cursor_position=len(text)), None))
                meta = {item.text: item.display_meta_text for item in items}
                self.assertEqual(meta[expected[0]], expected[1])

            fallback_document = Document(
                "missing(session",
                cursor_position=len("missing(session"),
            )
            fallback_items = list(completer.get_completions(fallback_document, None))
            self.assertEqual([item.text for item in fallback_items], ["session_name"])

        calls: list[tuple[str, str]] = []

        def dotted_provider(expression: str, prefix: str):
            calls.append((expression, prefix))
            return ["alpha"]

        completer = ReplCompleter(ReplSessionSymbols(), dotted_provider=dotted_provider)
        document = Document("obj.a", cursor_position=len("obj.a"))
        self.assertEqual([item.text for item in completer.get_completions(document, None)], ["alpha"])
        completer.invalidate_runtime_cache(clear_all=True)
        self.assertEqual([item.text for item in completer.get_completions(document, None)], ["alpha"])
        self.assertEqual(calls, [("obj", "a"), ("obj", "a")])

    def test_completion_state_tracks_from_imports_and_object_mutations(self) -> None:
        symbols = ReplSessionSymbols()
        changes = symbols.record_successful_source("from machine import Pin as BoardPin")
        self.assertIn("BoardPin", changes.rebound_roots)
        self.assertEqual(
            symbols.resolve_runtime_expression("BoardPin.value"),
            "__import__('machine').Pin.value",
        )
        self.assertEqual(symbols.canonical_cache_key("BoardPin.value"), "module:machine.Pin.value")

        changes = symbols.record_successful_source(
            """
obj.attr = 1
items[0].value = 2
factory().value = 3
del obj.attr
delattr(items, 'value')
""".strip()
        )
        self.assertEqual(changes.rebound_roots, set())
        self.assertEqual(changes.mutated_roots, {"factory", "items", "obj"})

    def test_completion_engine_request_parsing_respects_strings_comments_and_patterns(self) -> None:
        self.assertTrue(cursor_in_string_or_comment("'unterminated"))
        self.assertFalse(cursor_in_string_or_comment("machine.P"))
        self.assertFalse(cursor_in_string_or_comment("fun(machine.P"))
        self.assertIsNone(parse_completion_request(Document("'unterminated", cursor_position=13)))

        dict_key_cases = {
            'config["wi': ("config", "wi", '"]'),
            "fun(config['m": ("config", "m", "']"),
            'config[ "mo': ("config", "mo", '"]'),
            'settings["network"]["ho': ('settings["network"]', "ho", '"]'),
        }
        for source, expected in dict_key_cases.items():
            with self.subTest(source=source):
                request = parse_completion_request(Document(source, cursor_position=len(source)))
                self.assertEqual(
                    (request.kind, request.expression, request.prefix, request.insert_suffix),
                    ("dict_key", *expected),
                )

        from_import_cases = {
            "from machine import P": ("machine", "P", frozenset()),
            "from machine import Pin, P": ("machine", "P", frozenset({"Pin"})),
            "from machine import (P": ("machine", "P", frozenset()),
            "from pkg.sub import ": ("pkg.sub", "", frozenset()),
        }
        for source, expected in from_import_cases.items():
            with self.subTest(source=source):
                request = parse_completion_request(Document(source, cursor_position=len(source)))
                self.assertEqual(
                    (request.kind, request.expression, request.prefix, request.used_keywords),
                    ("from_import", *expected),
                )

        self.assertIsNone(
            parse_completion_request(
                Document("from machine import Pin as ", cursor_position=len("from machine import Pin as "))
            )
        )
        self.assertIsNone(
            parse_completion_request(
                Document("from machine import *", cursor_position=len("from machine import *"))
            )
        )

        dotted = parse_completion_request(Document("machine.P", cursor_position=9))
        self.assertEqual((dotted.kind, dotted.expression, dotted.prefix), ("dotted", "machine", "P"))

        dotted_cases = {
            "fun(machine.P": ("machine", "P"),
            "[machine.P": ("machine", "P"),
            "foo(machine.Pin.": ("machine.Pin", ""),
            "items[0].v": ("items[0]", "v"),
            "obj['key'].v": ("obj['key']", "v"),
            'obj["key"].v': ('obj["key"]', "v"),
            "lvgl.obj().a": ("lvgl.obj()", "a"),
            "factory().value": ("factory()", "value"),
            "foo().bar.b": ("foo().bar", "b"),
            "target = lvgl.obj().a": ("lvgl.obj()", "a"),
            "call(arg, items[0].v": ("items[0]", "v"),
        }
        for source, expected in dotted_cases.items():
            with self.subTest(source=source):
                request = parse_completion_request(Document(source, cursor_position=len(source)))
                self.assertEqual((request.kind, request.expression, request.prefix), ("dotted", *expected))

        call_keyword_cases = {
            "machine.Pin(": ("machine.Pin", "", frozenset()),
            "machine.Pin(m": ("machine.Pin", "m", frozenset()),
            "machine.Pin(1, p": ("machine.Pin", "p", frozenset()),
            "factory().make(mode=1, va": ("factory().make", "va", frozenset({"mode"})),
            "fun(inner(a, b), ke": ("fun", "ke", frozenset()),
            "fun(')', key": ("fun", "key", frozenset()),
        }
        for source, expected in call_keyword_cases.items():
            with self.subTest(source=source):
                request = parse_completion_request(Document(source, cursor_position=len(source)))
                self.assertEqual(
                    (request.kind, request.expression, request.prefix, request.used_keywords),
                    ("call_keyword", *expected),
                )

        value_argument_source = "machine.Pin(mode=v"
        value_argument = parse_completion_request(
            Document(value_argument_source, cursor_position=len(value_argument_source))
        )
        self.assertEqual(value_argument.kind, "bare")

        star_argument_source = "machine.Pin(*"
        self.assertIsNone(
            parse_completion_request(
                Document(star_argument_source, cursor_position=len(star_argument_source))
            )
        )

        meta = parse_completion_request(Document(":qu", cursor_position=3))
        self.assertEqual((meta.kind, meta.prefix), ("meta", ":qu"))

        bare = parse_completion_request(Document("prin", cursor_position=4))
        self.assertEqual((bare.kind, bare.prefix), ("bare", "prin"))

        self.assertIsNone(parse_completion_request(Document("1 + 2", cursor_position=5)))
        self.assertIsNone(parse_completion_request(Document("obj.1", cursor_position=5)))
        self.assertIsNone(parse_completion_request(Document("(a + b).", cursor_position=8)))

    def test_completion_device_helpers_resolve_alias_and_parse_output(self) -> None:
        symbols = ReplSessionSymbols()
        symbols.record_successful_source("import machine as hw")

        self.assertEqual(_split_expression("hw.Pin"), ("hw", ".Pin"))
        self.assertEqual(_split_expression("machine"), ("machine", ""))
        self.assertEqual(_resolved_expression("hw.Pin", symbols), "__import__('machine').Pin")

        source = _build_dir_query_source("hw.Pin", symbols)
        self.assertIn("_mpy_target = __import__('machine').Pin", source)
        self.assertIn("except NameError:", source)

        missing_module_source = _build_dir_query_source("missing_module", ReplSessionSymbols())
        exec(missing_module_source, {})

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
            self.assertTrue(control_path.exists())
            self.assertIsNone(channel.read_next())

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

            control_path.write_text(
                json.dumps({"sequence": 3, "command": "exec", "source": "print('中')", "label": "main.py"}),
                encoding="utf-8",
            )
            self.assertEqual(
                channel.read_next(),
                ControlRequest(sequence=3, command="exec", source="print('中')", label="main.py"),
            )

            control_path.write_text(
                json.dumps(
                    {
                        "sequence": 4,
                        "command": "fs",
                        "request_id": "req-4",
                        "response_file": "response.json",
                        "progress_file": "progress.json",
                        "payload": {"op": "write_file"},
                    }
                ),
                encoding="utf-8",
            )
            self.assertEqual(
                channel.read_next(),
                ControlRequest(
                    sequence=4,
                    command="fs",
                    request_id="req-4",
                    response_file="response.json",
                    progress_file="progress.json",
                    payload={"op": "write_file"},
                ),
            )

            control_path.write_text(
                json.dumps({"sequence": 5, "command": "exec", "source": 1}),
                encoding="utf-8",
            )
            self.assertIsNone(channel.read_next())

            control_path.write_text(
                json.dumps({"sequence": "6", "command": "exit"}),
                encoding="utf-8",
            )
            self.assertIsNone(channel.read_next())

            control_path.write_text(
                json.dumps({"sequence": 6}),
                encoding="utf-8",
            )
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

        import codeop

        with mock.patch.object(codeop, "compile_command", side_effect=SyntaxError):
            self.assertFalse(should_start_multiline("if True:"))
            self.assertTrue(is_block_complete("if True:"))

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
        self.assertTrue(hasattr(importlib.reload(completion_fallbacks_module), "fallback_candidates_for_expression"))
        self.assertTrue(hasattr(importlib.reload(completion_parser_module), "parse_completion_request"))
        self.assertTrue(hasattr(importlib.reload(completion_stubs_module), "StubCompletionIndex"))
        self.assertTrue(hasattr(importlib.reload(completion_engine_module), "ReplCompleter"))
        self.assertTrue(hasattr(importlib.reload(completion_state_module), "ReplSessionSymbols"))
        self.assertTrue(hasattr(importlib.reload(transport_module), "SerialReplTransport"))


if __name__ == "__main__":
    unittest.main()
