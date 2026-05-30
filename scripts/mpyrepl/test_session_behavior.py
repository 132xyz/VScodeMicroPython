"""Unit tests for REPL session behavior.

:return: None
"""

from __future__ import annotations

import os
import sys
import unittest


CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
if CURRENT_DIR not in sys.path:
    sys.path.insert(0, CURRENT_DIR)

import bootstrap

bootstrap.configure_import_path()

from prompt_toolkit.buffer import Buffer
from prompt_toolkit.document import Document
from prompt_toolkit.input import create_pipe_input
from prompt_toolkit.history import InMemoryHistory
from prompt_toolkit.output import DummyOutput

from completion_engine import ReplCompleter
from completion_state import ReplSessionSymbols
from session import PROMPT_EXIT, build_prompt_session


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


if __name__ == "__main__":
    unittest.main()