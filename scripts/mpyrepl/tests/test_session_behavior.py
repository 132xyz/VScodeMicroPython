"""Unit tests for REPL session behavior.

:return: None
"""

from __future__ import annotations

from types import SimpleNamespace
import os
import sys
import unittest


SCRIPTS_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

from mpyrepl import bootstrap

bootstrap.configure_import_path()

from prompt_toolkit.buffer import Buffer
from prompt_toolkit.completion import Completion
from prompt_toolkit.document import Document
from prompt_toolkit.input import create_pipe_input
from prompt_toolkit.history import InMemoryHistory
from prompt_toolkit.output import DummyOutput

from mpyrepl.completion.engine import ReplCompleter
from mpyrepl.completion.state import ReplSessionSymbols
from mpyrepl.repl.indent import INDENT
from mpyrepl.repl.session import (
    PROMPT_EXIT,
    PROMPT_SOFT_RESET,
    _continuation_after_newline,
    _dedent_backspace_count,
    _safe_exit,
    _should_accept_on_enter,
    _should_insert_indent,
    build_prompt_session,
)


class SessionBehaviorTests(unittest.TestCase):
    """Cover core REPL editing and completion behavior.

    :return: None
    """

    def test_bare_completion_includes_builtin_and_core_names(self) -> None:
        """Builtins like range and core names like sys should be available.

        :return: None
        """
        completer = ReplCompleter(ReplSessionSymbols())

        range_candidates = {
            item.text
            for item in completer.get_completions(Document(text="ran", cursor_position=3), None)
        }
        sys_candidates = {
            item.text
            for item in completer.get_completions(Document(text="sy", cursor_position=2), None)
        }

        self.assertIn("range", range_candidates)
        self.assertIn("sys", sys_candidates)

    def test_auto_up_recalls_whole_multiline_history_entry(self) -> None:
        """Up on the first line should recall the previous whole block.

        :return: None
        """
        history = InMemoryHistory()
        block = "def f():\n    return 1"
        history.append_string(block)

        buffer = Buffer(history=history, multiline=True)
        buffer._working_lines.appendleft(block)
        buffer.working_index = 1
        buffer.text = ""

        buffer.auto_up()

        self.assertEqual(buffer.text, block)
        self.assertEqual(buffer.document.cursor_position, len(block))

    def test_auto_up_moves_inside_current_multiline_block_before_history(self) -> None:
        """Up inside a multiline block should move the cursor, not swap history.

        :return: None
        """
        block = "def f():\n    return 1"
        buffer = Buffer(
            history=InMemoryHistory(),
            multiline=True,
            document=Document(block, cursor_position=len(block)),
        )

        original_text = buffer.text
        original_row = buffer.document.cursor_position_row
        buffer.auto_up()

        self.assertEqual(buffer.text, original_text)
        self.assertEqual(original_row, 1)
        self.assertEqual(buffer.document.cursor_position_row, 0)

    def test_up_key_recalls_whole_history_block_in_prompt_session(self) -> None:
        """Up on a new block should recall the previous whole block.

        :return: None
        """
        history = InMemoryHistory()
        block = "def f():\n    return 1"
        history.append_string(block)

        with create_pipe_input() as pipe:
            session = build_prompt_session(history=history, input=pipe, output=DummyOutput())
            pipe.send_bytes(b"\x1b[A\x18")
            result = session.prompt(
                ">>> ",
                pre_run=lambda: session.default_buffer.load_history_if_not_yet_loaded(),
            )

        self.assertEqual(result, PROMPT_EXIT)
        self.assertEqual(session.default_buffer.text, block)

    def test_submitted_multiline_block_is_recorded_into_history(self) -> None:
        """Accepted multiline input should be available to the next Up key recall.

        :return: None
        """
        history = InMemoryHistory()

        with create_pipe_input() as pipe:
            session = build_prompt_session(history=history, input=pipe, output=DummyOutput())
            pipe.send_text("def f():\rreturn 1\r\r")
            first = session.prompt(">>> ")

            pipe.send_bytes(b"\x1b[A\x18")
            second = session.prompt(
                ">>> ",
                pre_run=lambda: session.default_buffer.load_history_if_not_yet_loaded(),
            )

        self.assertEqual(first, "def f():\n    return 1")
        self.assertEqual(second, PROMPT_EXIT)
        self.assertEqual(session.default_buffer.text, "def f():\n    return 1")

    def test_session_helpers_cover_indent_and_accept_logic(self) -> None:
        self.assertTrue(_should_insert_indent(Document("    ", cursor_position=4)))
        self.assertFalse(_should_insert_indent(Document("value", cursor_position=5)))
        self.assertEqual(_dedent_backspace_count(Document("    ", cursor_position=4)), 4)
        self.assertEqual(_dedent_backspace_count(Document("      ", cursor_position=6)), 2)
        self.assertEqual(_dedent_backspace_count(Document("value", cursor_position=5)), 0)
        self.assertEqual(
            _continuation_after_newline(Document("if True:", cursor_position=len("if True:"))),
            INDENT,
        )
        self.assertTrue(_should_accept_on_enter(Document("", cursor_position=0)))
        self.assertTrue(_should_accept_on_enter(Document("value = 1", cursor_position=9)))
        self.assertFalse(_should_accept_on_enter(Document("value = 1", cursor_position=3)))
        self.assertTrue(
            _should_accept_on_enter(
                Document("if True:\n    pass\n", cursor_position=len("if True:\n    pass\n"))
            )
        )

    def test_control_bindings_return_soft_reset_and_exit(self) -> None:
        with create_pipe_input() as pipe:
            session = build_prompt_session(input=pipe, output=DummyOutput())
            pipe.send_bytes(b"\x04")
            self.assertEqual(session.prompt(">>> "), PROMPT_SOFT_RESET)

            pipe.send_bytes(b"\x1d")
            self.assertEqual(session.prompt(">>> "), PROMPT_EXIT)

            pipe.send_bytes(b"\x18")
            self.assertEqual(session.prompt(">>> "), PROMPT_EXIT)

    def test_safe_exit_ignores_duplicate_prompt_exit(self) -> None:
        class _App:
            def __init__(self) -> None:
                self.calls = 0

            def exit(self, result: str) -> None:
                self.calls += 1
                if self.calls > 1:
                    raise Exception("Return value already set. Application.exit() failed.")

        app = _App()
        _safe_exit(app, PROMPT_EXIT)
        _safe_exit(app, PROMPT_EXIT)

        self.assertEqual(app.calls, 2)

    def test_tab_indent_and_backspace_dedent_modify_buffer(self) -> None:
        with create_pipe_input() as pipe:
            session = build_prompt_session(input=pipe, output=DummyOutput())
            pipe.send_bytes(b"\t\x18")
            result = session.prompt(">>> ")

        self.assertEqual(result, PROMPT_EXIT)
        self.assertEqual(session.default_buffer.text, INDENT)

        with create_pipe_input() as pipe:
            session = build_prompt_session(input=pipe, output=DummyOutput())
            pipe.send_text("    ")
            pipe.send_bytes(b"\x7f\x18")
            result = session.prompt(">>> ")

        self.assertEqual(result, PROMPT_EXIT)
        self.assertEqual(session.default_buffer.text, "")

    def test_tab_completion_and_plain_backspace_paths(self) -> None:
        class _SimpleCompleter:
            def has_completion_target(self, document) -> bool:
                return True

            def get_completions(self, document, event):
                return [Completion("print", start_position=-2)]

            async def get_completions_async(self, document, event):
                for completion in self.get_completions(document, event):
                    yield completion

        completer = _SimpleCompleter()

        with create_pipe_input() as pipe:
            session = build_prompt_session(completer=completer, input=pipe, output=DummyOutput())
            pipe.send_text("pr")
            pipe.send_bytes(b"\t\x18")
            result = session.prompt(">>> ")

        self.assertEqual(result, PROMPT_EXIT)
        self.assertEqual(session.default_buffer.text, "print")

        with create_pipe_input() as pipe:
            session = build_prompt_session(input=pipe, output=DummyOutput())
            pipe.send_text("ab")
            pipe.send_bytes(b"\x7f\x18")
            result = session.prompt(">>> ")

        self.assertEqual(result, PROMPT_EXIT)
        self.assertEqual(session.default_buffer.text, "a")


if __name__ == "__main__":
    unittest.main()
