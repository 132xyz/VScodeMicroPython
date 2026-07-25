"""VS Code-style paired-character editing for the terminal REPL."""

from __future__ import annotations

from dataclasses import dataclass

from prompt_toolkit.buffer import Buffer
from prompt_toolkit.document import Document
from prompt_toolkit.selection import SelectionType


OPEN_TO_CLOSE = {"(": ")", "[": "]", "{": "}"}
QUOTES = {"'", '"'}


@dataclass(frozen=True)
class CursorContext:
    """Python lexical context immediately before the cursor."""

    kind: str
    quote: str = ""


@dataclass
class _TrackedPair:
    """One closing character inserted by the auto-pair editor."""

    position: int
    opening: str
    closing: str
    expandable_quote: bool = False


def cursor_context(text: str, cursor_position: int) -> CursorContext:
    """Return whether the cursor is in Python code, a string, or a comment."""
    limit = min(max(cursor_position, 0), len(text))
    state = "code"
    delimiter = ""
    index = 0

    while index < limit:
        char = text[index]
        if state == "comment":
            if char == "\n":
                state = "code"
            index += 1
            continue

        if state == "string":
            if char == "\\":
                index += 2
                continue
            if delimiter in QUOTES:
                if char == delimiter:
                    state = "code"
                    delimiter = ""
                elif char == "\n":
                    state = "code"
                    delimiter = ""
                index += 1
                continue
            if text.startswith(delimiter, index):
                state = "code"
                index += len(delimiter)
                delimiter = ""
                continue
            index += 1
            continue

        if char == "#":
            state = "comment"
            index += 1
            continue
        if char in QUOTES:
            triple = char * 3
            if index + len(triple) <= limit and text.startswith(triple, index):
                delimiter = triple
                index += len(triple)
            else:
                delimiter = char
                index += 1
            state = "string"
            continue
        index += 1

    return CursorContext(state, delimiter if state == "string" else "")


def _is_escaped(text: str, position: int) -> bool:
    """Return whether the character at ``position`` follows an odd slash run."""
    slash_count = 0
    index = position - 1
    while index >= 0 and text[index] == "\\":
        slash_count += 1
        index -= 1
    return slash_count % 2 == 1


class AutoPairEditor:
    """Manage paired-character edits for one prompt-toolkit buffer."""

    def __init__(self, buffer: Buffer) -> None:
        self._buffer = buffer
        self._previous_text = buffer.text
        self._pairs: list[_TrackedPair] = []
        self._recent_empty_quote: tuple[int, str] | None = None
        buffer.on_text_changed.add_handler(self._handle_text_changed)
        buffer.on_cursor_position_changed.add_handler(self._handle_cursor_changed)

    def insert_opening(self, opening: str) -> None:
        """Insert an opening delimiter and, in code, its matching closer."""
        closing = OPEN_TO_CLOSE[opening]
        if self._wrap_selection(opening, closing):
            return

        buffer = self._buffer
        if cursor_context(buffer.text, buffer.cursor_position).kind != "code":
            buffer.insert_text(opening)
            return
        self._insert_pair(opening, closing)

    def insert_quote(self, quote: str) -> None:
        """Insert or overtype one single/double quote."""
        if self._wrap_selection(quote, quote):
            return
        if self._consume_tracked_closer(quote):
            return
        if self._expand_recent_quote_pair(quote):
            return

        buffer = self._buffer
        context = cursor_context(buffer.text, buffer.cursor_position)
        if context.kind != "code" or _is_escaped(buffer.text, buffer.cursor_position):
            buffer.insert_text(quote)
            return
        self._insert_pair(quote, quote)

    def insert_closing(self, closing: str) -> None:
        """Overtype an automatic closer, otherwise insert a literal closer."""
        if self._replace_selection(closing):
            return
        if self._consume_tracked_closer(closing):
            return
        self._buffer.insert_text(closing)

    def delete_pair_or_selection(self) -> bool:
        """Delete a selection or both sides of an empty automatic pair."""
        buffer = self._buffer
        if buffer.selection_state is not None:
            buffer.cut_selection()
            return True

        pair = self._pair_at(buffer.cursor_position)
        if pair is None or buffer.cursor_position == 0:
            return False
        if buffer.text[buffer.cursor_position - 1] != pair.opening:
            return False

        buffer.cancel_completion()
        buffer.delete(count=1)
        buffer.delete_before_cursor(count=1)
        return True

    def _insert_pair(self, opening: str, closing: str) -> None:
        buffer = self._buffer
        buffer.insert_text(opening + closing)
        buffer.cursor_left(count=1)
        self._pairs.append(
            _TrackedPair(
                buffer.cursor_position,
                opening,
                closing,
                expandable_quote=opening == closing and closing in QUOTES,
            )
        )

    def _consume_tracked_closer(self, closing: str) -> bool:
        buffer = self._buffer
        pair = self._pair_at(buffer.cursor_position)
        if pair is None or pair.closing != closing:
            return False
        buffer.cancel_completion()
        buffer.cursor_right(count=1)
        self._pairs.remove(pair)
        if pair.expandable_quote:
            self._recent_empty_quote = (buffer.cursor_position, closing)
        return True

    def _expand_recent_quote_pair(self, quote: str) -> bool:
        buffer = self._buffer
        if self._recent_empty_quote != (buffer.cursor_position, quote):
            return False
        if buffer.text[max(0, buffer.cursor_position - 2) : buffer.cursor_position] != quote * 2:
            return False

        self._recent_empty_quote = None
        buffer.insert_text(quote * 4)
        buffer.cursor_left(count=3)
        for offset in range(3):
            self._pairs.append(
                _TrackedPair(buffer.cursor_position + offset, quote, quote)
            )
        return True

    def _wrap_selection(self, opening: str, closing: str) -> bool:
        bounds = self._selection_bounds()
        if bounds is None:
            return False

        buffer = self._buffer
        start, end = bounds
        selected = buffer.text[start:end]
        wrapped = buffer.text[:start] + opening + selected + closing + buffer.text[end:]
        closing_position = start + len(opening) + len(selected)
        buffer.document = Document(wrapped, cursor_position=closing_position + len(closing))
        self._pairs.append(_TrackedPair(closing_position, opening, closing))
        return True

    def _replace_selection(self, text: str) -> bool:
        if self._selection_bounds() is None:
            return False
        self._buffer.cut_selection()
        self._buffer.insert_text(text)
        return True

    def _selection_bounds(self) -> tuple[int, int] | None:
        buffer = self._buffer
        selection = buffer.selection_state
        if selection is None or selection.type != SelectionType.CHARACTERS:
            return None
        start, end = sorted((selection.original_cursor_position, buffer.cursor_position))
        if start == end:
            return None
        return start, end

    def _pair_at(self, position: int) -> _TrackedPair | None:
        for pair in reversed(self._pairs):
            if pair.position == position:
                return pair
        return None

    def _handle_text_changed(self, buffer: Buffer) -> None:
        old_text = self._previous_text
        new_text = buffer.text
        self._previous_text = new_text
        self._recent_empty_quote = None
        if old_text == new_text or not self._pairs:
            return

        start = 0
        shared_limit = min(len(old_text), len(new_text))
        while start < shared_limit and old_text[start] == new_text[start]:
            start += 1

        old_end = len(old_text)
        new_end = len(new_text)
        while (
            old_end > start
            and new_end > start
            and old_text[old_end - 1] == new_text[new_end - 1]
        ):
            old_end -= 1
            new_end -= 1

        delta = len(new_text) - len(old_text)
        updated: list[_TrackedPair] = []
        for pair in self._pairs:
            if pair.position < start:
                new_position = pair.position
            elif old_end == start or pair.position >= old_end:
                new_position = pair.position + delta
            else:
                continue
            if 0 <= new_position < len(new_text) and new_text[new_position] == pair.closing:
                pair.position = new_position
                updated.append(pair)
        self._pairs = updated

    def _handle_cursor_changed(self, buffer: Buffer) -> None:
        self._recent_empty_quote = None


class AutoPairEditors:
    """Lazily create one auto-pair editor for each prompt buffer."""

    def __init__(self) -> None:
        self._editors: dict[int, AutoPairEditor] = {}

    def for_buffer(self, buffer: Buffer) -> AutoPairEditor:
        """Return the editor associated with ``buffer``."""
        key = id(buffer)
        editor = self._editors.get(key)
        if editor is None:
            editor = AutoPairEditor(buffer)
            self._editors[key] = editor
        return editor
