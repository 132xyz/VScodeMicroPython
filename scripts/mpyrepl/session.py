"""Prompt toolkit session helpers for Spike B.

:return: None
"""

from __future__ import annotations

from prompt_toolkit import PromptSession
from prompt_toolkit.completion import CompleteEvent, get_common_complete_suffix
from prompt_toolkit.document import Document
from prompt_toolkit.key_binding import KeyBindings
from prompt_toolkit.history import InMemoryHistory
from prompt_toolkit.lexers import PygmentsLexer
from pygments.lexers.python import PythonLexer

from indent import INDENT, continuation_default, is_block_complete


PROMPT_SOFT_RESET = "__mpyrepl_soft_reset__"
PROMPT_EXIT = "__mpyrepl_exit__"


def _should_insert_indent(document: Document) -> bool:
    """Return whether Tab should insert spaces instead of requesting completion.

    :param document: Prompt document.
    :return: True when the cursor is still inside leading whitespace.
    """
    line_before_cursor = document.current_line_before_cursor
    return not line_before_cursor or line_before_cursor.isspace()


def _dedent_backspace_count(document: Document) -> int:
    """Return how many spaces Backspace should delete for one dedent step.

    :param document: Prompt document.
    :return: Delete count, or zero for normal Backspace handling.
    """
    line_before_cursor = document.current_line_before_cursor
    if not line_before_cursor or not line_before_cursor.isspace():
        return 0

    indent_width = len(line_before_cursor)
    indent_step = len(INDENT)
    remainder = indent_width % indent_step
    return remainder or indent_step


def _continuation_after_newline(document: Document) -> str:
    """Return the indent that should be inserted after Enter.

    :param document: Prompt document.
    :return: Indentation prefix for the new line.
    """
    lines = document.text_before_cursor.split("\n")
    return continuation_default(lines)


def _should_accept_on_enter(document: Document) -> bool:
    """Return whether Enter should submit the buffer instead of inserting a newline.

    :param document: Prompt document.
    :return: True when the current buffer should be accepted.
    """
    text = document.text
    if not text:
        return True

    if "\n" not in text:
        return document.cursor_position == len(text) and is_block_complete(text)

    if document.cursor_position != len(text):
        return False
    return document.current_line.strip() == ""


def build_prompt_session(completer=None, history=None, input=None, output=None) -> PromptSession:
    """Create the minimal prompt_toolkit session for the prompt spike.

    :param completer: Optional prompt_toolkit completer.
    :param history: Optional prompt_toolkit history object.
    :param input: Optional prompt_toolkit input object for tests.
    :param output: Optional prompt_toolkit output object for tests.
    :return: Prompt session instance.
    """
    bindings = KeyBindings()

    @bindings.add("c-d")
    def _request_soft_reset(event) -> None:
        event.app.exit(result=PROMPT_SOFT_RESET)

    @bindings.add("c-]")
    def _request_exit(event) -> None:
        event.app.exit(result=PROMPT_EXIT)

    @bindings.add("c-x")
    def _request_exit_via_ctrl_x(event) -> None:
        event.app.exit(result=PROMPT_EXIT)

    @bindings.add("up")
    def _handle_up(event) -> None:
        event.current_buffer.load_history_if_not_yet_loaded()
        event.current_buffer.auto_up()

    @bindings.add("down")
    def _handle_down(event) -> None:
        event.current_buffer.load_history_if_not_yet_loaded()
        event.current_buffer.auto_down()

    @bindings.add("enter")
    def _handle_enter(event) -> None:
        buffer = event.current_buffer
        if buffer.complete_state and buffer.complete_state.current_completion is not None:
            buffer.apply_completion(buffer.complete_state.current_completion)
            return

        document = buffer.document
        if _should_accept_on_enter(document):
            accepted_text = buffer.text.rstrip()
            if accepted_text != buffer.text:
                buffer.document = Document(accepted_text, cursor_position=len(accepted_text))
            buffer.append_to_history()
            event.app.exit(result=accepted_text)
            return

        buffer.insert_text("\n" + _continuation_after_newline(document))

    @bindings.add("tab")
    def _handle_tab(event) -> None:
        buffer = event.current_buffer
        if buffer.complete_state:
            buffer.complete_next()
            return

        document = buffer.document
        if _should_insert_indent(document):
            buffer.insert_text(INDENT)
            return

        if completer is not None and getattr(completer, "has_completion_target", None):
            if completer.has_completion_target(document):
                completions = list(
                    completer.get_completions(
                        document,
                        CompleteEvent(completion_requested=True),
                    )
                )
                if len(completions) == 1:
                    buffer.apply_completion(completions[0])
                    return

                common_suffix = get_common_complete_suffix(document, completions)
                if common_suffix:
                    buffer.insert_text(common_suffix)
                    return

                if completions:
                    buffer._set_completions(completions)
                    return

                buffer.insert_text(INDENT)
                return

        buffer.insert_text(INDENT)

    @bindings.add("backspace")
    def _handle_backspace(event) -> None:
        buffer = event.current_buffer
        delete_count = _dedent_backspace_count(buffer.document)
        if delete_count > 0:
            buffer.delete_before_cursor(count=delete_count)
            return
        buffer.delete_before_cursor(count=1)

    return PromptSession(
        lexer=PygmentsLexer(PythonLexer),
        multiline=True,
        prompt_continuation=lambda width, line_number, wrap_count: "... ",
        history=history or InMemoryHistory(),
        key_bindings=bindings,
        completer=completer,
        complete_in_thread=False,
        input=input,
        output=output,
    )
