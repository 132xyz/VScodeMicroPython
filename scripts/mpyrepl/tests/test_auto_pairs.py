"""Unit tests for REPL paired-character editing."""

from __future__ import annotations

import os
import sys
import unittest


SCRIPTS_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

from mpyrepl import bootstrap

bootstrap.configure_import_path()

from prompt_toolkit.buffer import Buffer
from prompt_toolkit.document import Document
from prompt_toolkit.input import create_pipe_input
from prompt_toolkit.output import DummyOutput
from prompt_toolkit.selection import SelectionState, SelectionType

from mpyrepl.repl.auto_pairs import AutoPairEditor, AutoPairEditors, cursor_context
from mpyrepl.repl.session import PROMPT_EXIT, build_prompt_session


class AutoPairContextTests(unittest.TestCase):
    """Cover lightweight Python lexical context detection."""

    def test_cursor_context_recognizes_code_strings_and_comments(self) -> None:
        self.assertEqual(cursor_context("value = ", 8).kind, "code")
        self.assertEqual(cursor_context("'value", 6).kind, "string")
        self.assertEqual(cursor_context('"value', 6).quote, '"')
        self.assertEqual(cursor_context("# comment", 9).kind, "comment")
        self.assertEqual(cursor_context("# comment\nvalue", 15).kind, "code")

    def test_cursor_context_handles_escapes_and_triple_strings(self) -> None:
        self.assertEqual(cursor_context("'a\\'b'", 6).kind, "code")
        self.assertEqual(cursor_context('"""value', 8).quote, '"""')
        self.assertEqual(cursor_context('"""value"""', 11).kind, "code")
        self.assertEqual(cursor_context("'unfinished\nvalue", 17).kind, "code")


class AutoPairEditorTests(unittest.TestCase):
    """Cover the stateful paired-character editor."""

    def test_opening_pair_tracks_closer_across_nested_edits(self) -> None:
        buffer = Buffer()
        editor = AutoPairEditor(buffer)

        editor.insert_opening("(")
        buffer.insert_text("item")
        editor.insert_opening("[")
        buffer.insert_text("0")
        editor.insert_closing("]")
        editor.insert_closing(")")

        self.assertEqual(buffer.text, "(item[0])")
        self.assertEqual(buffer.cursor_position, len(buffer.text))

    def test_closer_only_overtypes_an_automatically_inserted_character(self) -> None:
        buffer = Buffer(document=Document(")", cursor_position=0))
        editor = AutoPairEditor(buffer)

        editor.insert_closing(")")

        self.assertEqual(buffer.text, "))")
        self.assertEqual(buffer.cursor_position, 1)

    def test_opening_delimiters_stay_literal_in_strings_and_comments(self) -> None:
        string_buffer = Buffer(document=Document("'text", cursor_position=5))
        string_editor = AutoPairEditor(string_buffer)
        string_editor.insert_opening("(")

        comment_buffer = Buffer(document=Document("# note ", cursor_position=7))
        comment_editor = AutoPairEditor(comment_buffer)
        comment_editor.insert_opening("[")

        self.assertEqual(string_buffer.text, "'text(")
        self.assertEqual(comment_buffer.text, "# note [")

    def test_quote_pairing_overtype_and_literal_conflict_rules(self) -> None:
        buffer = Buffer()
        editor = AutoPairEditor(buffer)
        editor.insert_quote("'")
        buffer.insert_text("value")
        editor.insert_quote("'")
        self.assertEqual(buffer.text, "'value'")

        escaped = Buffer(document=Document("\\", cursor_position=1))
        AutoPairEditor(escaped).insert_quote('"')
        self.assertEqual(escaped.text, '\\"')

        inside_string = Buffer(document=Document("'value", cursor_position=6))
        AutoPairEditor(inside_string).insert_quote('"')
        self.assertEqual(inside_string.text, "'value\"")

    def test_third_quote_expands_an_empty_pair_into_triple_quotes(self) -> None:
        buffer = Buffer()
        editor = AutoPairEditor(buffer)

        editor.insert_quote('"')
        editor.insert_quote('"')
        editor.insert_quote('"')
        buffer.insert_text("value")
        editor.insert_quote('"')
        editor.insert_quote('"')
        editor.insert_quote('"')

        self.assertEqual(buffer.text, '"""value"""')
        self.assertEqual(buffer.cursor_position, len(buffer.text))

    def test_triple_quote_expansion_requires_an_immediate_third_quote(self) -> None:
        buffer = Buffer()
        editor = AutoPairEditor(buffer)

        editor.insert_quote("'")
        editor.insert_quote("'")
        buffer.cursor_left()
        buffer.cursor_right()
        editor.insert_quote("'")

        self.assertEqual(buffer.text, "''''")
        self.assertEqual(buffer.cursor_position, 3)

    def test_empty_triple_quote_closers_are_only_overtyped(self) -> None:
        buffer = Buffer()
        editor = AutoPairEditor(buffer)

        for _ in range(3):
            editor.insert_quote("'")
        for _ in range(3):
            editor.insert_quote("'")

        self.assertEqual(buffer.text, "''''''")
        self.assertEqual(buffer.cursor_position, len(buffer.text))

    def test_selected_text_is_wrapped_or_replaced(self) -> None:
        buffer = Buffer(document=Document("value", cursor_position=5))
        buffer.selection_state = SelectionState(0)
        editor = AutoPairEditor(buffer)
        editor.insert_opening("(")

        self.assertEqual(buffer.text, "(value)")
        self.assertEqual(buffer.cursor_position, len("(value)"))
        self.assertIsNone(buffer.selection_state)

        buffer.document = Document("value", cursor_position=5)
        buffer.selection_state = SelectionState(0)
        editor.insert_closing(")")
        self.assertEqual(buffer.text, ")")

    def test_backspace_deletes_empty_pair_and_regular_selection(self) -> None:
        buffer = Buffer()
        editor = AutoPairEditor(buffer)
        editor.insert_opening("{")
        self.assertTrue(editor.delete_pair_or_selection())
        self.assertEqual(buffer.text, "")

        selected = Buffer(document=Document("value", cursor_position=5))
        selected.selection_state = SelectionState(0)
        selected_editor = AutoPairEditor(selected)
        self.assertTrue(selected_editor.delete_pair_or_selection())
        self.assertEqual(selected.text, "")

        plain = Buffer(document=Document("value", cursor_position=5))
        self.assertFalse(AutoPairEditor(plain).delete_pair_or_selection())

    def test_pair_marker_is_removed_when_closer_is_overwritten(self) -> None:
        buffer = Buffer()
        editor = AutoPairEditor(buffer)
        editor.insert_opening("(")
        buffer.delete(count=1)
        buffer.insert_text("]")

        editor.insert_closing(")")

        self.assertEqual(buffer.text, "(])")

    def test_editor_registry_reuses_the_buffer_editor(self) -> None:
        registry = AutoPairEditors()
        first = Buffer()
        second = Buffer()

        self.assertIs(registry.for_buffer(first), registry.for_buffer(first))
        self.assertIsNot(registry.for_buffer(first), registry.for_buffer(second))

    def test_line_selection_is_not_treated_as_character_selection(self) -> None:
        buffer = Buffer(document=Document("value", cursor_position=5))
        buffer.selection_state = SelectionState(0, SelectionType.LINES)
        editor = AutoPairEditor(buffer)

        editor.insert_closing(")")

        self.assertEqual(buffer.text, "value)")


class AutoPairSessionTests(unittest.TestCase):
    """Exercise the actual prompt key bindings."""

    def test_nested_pairs_overtype_and_backspace_in_prompt(self) -> None:
        with create_pipe_input() as pipe:
            session = build_prompt_session(input=pipe, output=DummyOutput())
            pipe.send_text("([x")
            pipe.send_bytes(b"\x7f\x7f\x7f\x18")
            result = session.prompt(">>> ")

        self.assertEqual(result, PROMPT_EXIT)
        self.assertEqual(session.default_buffer.text, "")

    def test_quotes_and_string_contents_in_prompt(self) -> None:
        with create_pipe_input() as pipe:
            session = build_prompt_session(input=pipe, output=DummyOutput())
            pipe.send_text("'(text)'")
            pipe.send_bytes(b"\x18")
            result = session.prompt(">>> ")

        self.assertEqual(result, PROMPT_EXIT)
        self.assertEqual(session.default_buffer.text, "'(text)'")

    def test_bracketed_paste_is_not_auto_paired(self) -> None:
        with create_pipe_input() as pipe:
            session = build_prompt_session(input=pipe, output=DummyOutput())
            pipe.send_bytes(b"\x1b[200~(\x1b[201~\x18")
            result = session.prompt(">>> ")

        self.assertEqual(result, PROMPT_EXIT)
        self.assertEqual(session.default_buffer.text, "(")


if __name__ == "__main__":
    unittest.main()
