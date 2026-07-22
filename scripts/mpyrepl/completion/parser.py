"""Completion target parsing for the custom REPL.

:return: None
"""

from __future__ import annotations

import ast
import io
import re
import tokenize
from dataclasses import dataclass, field

from prompt_toolkit.document import Document


BARE_PATTERN = re.compile(r"([A-Za-z_][A-Za-z0-9_]*)$")
META_PATTERN = re.compile(r"(:[A-Za-z]*)$")
FROM_IMPORT_PATTERN = re.compile(
    r"^\s*from\s+"
    r"(?P<module>[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)"
    r"\s+import\s*(?P<items>.*)$"
)
EXPRESSION_BOUNDARY_CHARS = set("([{,;:=+-*/%@&|^~<>")
EXPRESSION_TRAILERS = ".(["
KEYWORD_NAME_PATTERN = re.compile(r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=")
DICT_KEY_STRING_PATTERN = re.compile(r"(?P<quote>['\"])(?P<prefix>[^'\"\r\n]*)$")


@dataclass(frozen=True, slots=True)
class CompletionRequest:
    """Parsed completion target at the cursor.

    :return: None
    """

    kind: str
    expression: str
    prefix: str
    used_keywords: frozenset[str] = field(default_factory=frozenset)
    insert_suffix: str = ""


def has_unterminated_string_or_comment(line_before_cursor: str) -> bool:
    """Return whether a lightweight scan sees an open string or comment.

    :param line_before_cursor: Current line text before the cursor.
    :return: True when the cursor appears to be inside a string or comment.
    """
    quote_char: str | None = None
    triple_quote = False
    escaped = False
    index = 0
    length = len(line_before_cursor)

    while index < length:
        char = line_before_cursor[index]

        if quote_char is None:
            if char == "#":
                return True

            if line_before_cursor.startswith("'''", index) or line_before_cursor.startswith('"""', index):
                quote_char = char
                triple_quote = True
                index += 3
                continue

            if char in ("'", '"'):
                quote_char = char
                triple_quote = False
                escaped = False
                index += 1
                continue

            index += 1
            continue

        if escaped:
            escaped = False
            index += 1
            continue

        if char == "\\":
            escaped = True
            index += 1
            continue

        if triple_quote:
            if line_before_cursor.startswith(quote_char * 3, index):
                quote_char = None
                triple_quote = False
                index += 3
                continue
            index += 1
            continue

        if char == quote_char:
            quote_char = None

        index += 1

    return quote_char is not None


def cursor_in_string_or_comment(line_before_cursor: str) -> bool:
    """Return whether the cursor is currently inside a string or comment.

    :param line_before_cursor: Current line text before the cursor.
    :return: True when completion should be disabled.
    """
    if not line_before_cursor:
        return False

    try:
        tokens = list(tokenize.generate_tokens(io.StringIO(line_before_cursor).readline))
    except tokenize.TokenError:
        return has_unterminated_string_or_comment(line_before_cursor)

    if not tokens:
        return has_unterminated_string_or_comment(line_before_cursor)

    if tokens[-1].type in (tokenize.STRING, tokenize.COMMENT):
        return True

    return has_unterminated_string_or_comment(line_before_cursor)


def parse_completion_request(document: Document) -> CompletionRequest | None:
    """Parse the completion target at the current cursor position.

    :param document: Prompt document.
    :return: Parsed completion request or None.
    """
    line_before_cursor = document.current_line_before_cursor
    dict_key_request = _parse_dict_key_request(line_before_cursor)
    if dict_key_request is not None:
        return dict_key_request

    if cursor_in_string_or_comment(line_before_cursor):
        return None

    from_import_request = _parse_from_import_request(line_before_cursor)
    if from_import_request is not None:
        return from_import_request

    dotted_request = _parse_dotted_request(line_before_cursor)
    if dotted_request is not None:
        return dotted_request

    call_keyword_request = _parse_call_keyword_request(line_before_cursor)
    if call_keyword_request is not None:
        return call_keyword_request

    meta_match = META_PATTERN.search(line_before_cursor)
    if meta_match is not None:
        return CompletionRequest(kind="meta", expression="", prefix=meta_match.group(1))

    bare_match = BARE_PATTERN.search(line_before_cursor)
    if bare_match is not None:
        return CompletionRequest(kind="bare", expression="", prefix=bare_match.group(1))

    return None


def _parse_dotted_request(line_before_cursor: str) -> CompletionRequest | None:
    """Parse a dotted completion request from one line suffix.

    :param line_before_cursor: Current line before the cursor.
    :return: Dotted request or None.
    """
    prefix_start = len(line_before_cursor)
    while prefix_start > 0 and _is_identifier_char(line_before_cursor[prefix_start - 1]):
        prefix_start -= 1

    prefix = line_before_cursor[prefix_start:]
    if prefix and not _is_identifier_start(prefix[0]):
        return None

    dot_index = prefix_start - 1
    if dot_index < 0 or line_before_cursor[dot_index] != ".":
        return None

    expression = _find_completion_expression(line_before_cursor[:dot_index])
    if expression is None:
        return None

    return CompletionRequest(kind="dotted", expression=expression, prefix=prefix)


def _parse_from_import_request(line_before_cursor: str) -> CompletionRequest | None:
    """Parse a ``from module import name`` member completion request.

    :param line_before_cursor: Current line before the cursor.
    :return: From-import request or None.
    """
    match = FROM_IMPORT_PATTERN.match(line_before_cursor)
    if match is None:
        return None

    module = match.group("module")
    import_items = _normalized_from_import_items(match.group("items"))
    segments = _top_level_comma_segments(import_items)
    current_segment = segments[-1] if segments else ""
    prefix = _from_import_prefix(current_segment)
    if prefix is None:
        return None

    return CompletionRequest(
        kind="from_import",
        expression=module,
        prefix=prefix,
        used_keywords=frozenset(_used_from_import_names(segments[:-1])),
    )


def _parse_dict_key_request(line_before_cursor: str) -> CompletionRequest | None:
    """Parse a string-literal dict key completion request.

    :param line_before_cursor: Current line before the cursor.
    :return: Dict key request or None.
    """
    match = DICT_KEY_STRING_PATTERN.search(line_before_cursor)
    if match is None:
        return None

    prefix = match.group("prefix")
    if "\\" in prefix:
        return None

    before_quote = line_before_cursor[: match.start("quote")].rstrip()
    if not before_quote.endswith("["):
        return None

    bracket_index = len(before_quote) - 1
    expression = _find_completion_expression(line_before_cursor[:bracket_index])
    if expression is None:
        return None

    quote = match.group("quote")
    return CompletionRequest(
        kind="dict_key",
        expression=expression,
        prefix=prefix,
        insert_suffix=f"{quote}]",
    )


def _parse_call_keyword_request(line_before_cursor: str) -> CompletionRequest | None:
    """Parse a function-call keyword argument completion request.

    :param line_before_cursor: Current line before the cursor.
    :return: Call keyword request or None.
    """
    prefix_start = len(line_before_cursor)
    while prefix_start > 0 and _is_identifier_char(line_before_cursor[prefix_start - 1]):
        prefix_start -= 1

    prefix = line_before_cursor[prefix_start:]
    if prefix and not _is_identifier_start(prefix[0]):
        return None

    open_index = _innermost_unclosed_call_open(line_before_cursor[:prefix_start])
    if open_index is None:
        return None

    expression = _find_completion_expression(line_before_cursor[:open_index])
    if expression is None:
        return None

    argument_prefix = line_before_cursor[open_index + 1:prefix_start]
    current_argument = _current_top_level_argument(argument_prefix)
    stripped_argument = current_argument.strip()
    if (
        _has_top_level_equal(current_argument)
        or stripped_argument.startswith("*")
        or stripped_argument.startswith("**")
    ):
        return None

    return CompletionRequest(
        kind="call_keyword",
        expression=expression,
        prefix=prefix,
        used_keywords=frozenset(_used_keyword_arguments(argument_prefix)),
    )


def _find_completion_expression(text: str) -> str | None:
    """Find the right-most primary expression ending at the end of text.

    :param text: Source text before the final completion dot.
    :return: Parsed expression text or None.
    """
    for start in _candidate_start_indexes(text):
        candidate = text[start:].strip()
        if not candidate:
            continue
        if _is_completion_expression(candidate):
            return candidate
    return None


def _candidate_start_indexes(text: str) -> list[int]:
    """Return candidate start indexes from right to left.

    :param text: Source text before the final completion dot.
    :return: Candidate start indexes.
    """
    starts = {0}
    for index, char in enumerate(text):
        if char.isspace() or char in EXPRESSION_BOUNDARY_CHARS:
            starts.add(index + 1)
    return sorted(starts, reverse=True)


def _is_completion_expression(candidate: str) -> bool:
    """Return whether a candidate is safe enough for dotted probing.

    :param candidate: Candidate expression.
    :return: True for a primary expression and its trailers.
    """
    try:
        tree = ast.parse(candidate, mode="eval")
    except SyntaxError:
        return False
    return _is_primary_expression(tree.body)


def _is_primary_expression(node: ast.AST) -> bool:
    """Return whether an AST node is a primary expression.

    :param node: Expression node.
    :return: True for names with attribute, call, or subscript trailers.
    """
    if isinstance(node, ast.Name):
        return True
    if isinstance(node, ast.Attribute):
        return _is_primary_expression(node.value)
    if isinstance(node, ast.Subscript):
        return _is_primary_expression(node.value)
    if isinstance(node, ast.Call):
        return _is_primary_expression(node.func)
    return False


def _innermost_unclosed_call_open(text: str) -> int | None:
    """Return the innermost unmatched ``(`` index before the cursor.

    :param text: Source text before the current argument prefix.
    :return: Index of the innermost unmatched call opener, or None.
    """
    stack: list[tuple[str, int]] = []
    for index, char in _iter_code_chars(text):
        if char in "([{":
            stack.append((char, index))
            continue
        if char in ")]}":
            if not stack:
                continue
            opener, _ = stack[-1]
            if _matching_bracket(opener) == char:
                stack.pop()

    for opener, index in reversed(stack):
        if opener == "(":
            return index
    return None


def _current_top_level_argument(text: str) -> str:
    """Return the current argument segment after the last top-level comma.

    :param text: Call text before the current prefix.
    :return: Current argument text.
    """
    last_comma = -1
    depth = 0
    for index, char in _iter_code_chars(text):
        if char in "([{":
            depth += 1
            continue
        if char in ")]}":
            depth = max(0, depth - 1)
            continue
        if char == "," and depth == 0:
            last_comma = index
    return text[last_comma + 1:]


def _has_top_level_equal(text: str) -> bool:
    """Return whether one argument segment already contains ``=``.

    :param text: Argument segment.
    :return: True when keyword completion should not trigger.
    """
    depth = 0
    for _, char in _iter_code_chars(text):
        if char in "([{":
            depth += 1
            continue
        if char in ")]}":
            depth = max(0, depth - 1)
            continue
        if char == "=" and depth == 0:
            return True
    return False


def _used_keyword_arguments(text: str) -> set[str]:
    """Return keyword argument names already present in call text.

    :param text: Call argument text before the current prefix.
    :return: Used keyword names.
    """
    used: set[str] = set()
    for segment in _top_level_comma_segments(text):
        match = KEYWORD_NAME_PATTERN.match(segment)
        if match is not None:
            used.add(match.group(1))
    return used


def _normalized_from_import_items(text: str) -> str:
    """Return import item text with a leading wrapper parenthesis removed.

    :param text: Text after the ``import`` keyword.
    :return: Normalized import items.
    """
    stripped = text.lstrip()
    if stripped.startswith("("):
        return stripped[1:]
    return text


def _from_import_prefix(segment: str) -> str | None:
    """Return the active import-name prefix from one comma segment.

    :param segment: Current comma-delimited import item segment.
    :return: Prefix, an empty prefix, or None when not completable.
    """
    stripped = segment.strip()
    if stripped.startswith("*") or re.search(r"\bas\b", stripped):
        return None

    prefix_start = len(segment)
    while prefix_start > 0 and _is_identifier_char(segment[prefix_start - 1]):
        prefix_start -= 1

    prefix = segment[prefix_start:]
    if prefix and not _is_identifier_start(prefix[0]):
        return None

    leading = segment[:prefix_start].strip()
    if leading and leading != "(":
        return None
    return prefix


def _used_from_import_names(segments: list[str]) -> set[str]:
    """Return already typed names in a from-import statement.

    :param segments: Completed comma-delimited import item segments.
    :return: Imported names that should be omitted from suggestions.
    """
    used: set[str] = set()
    for segment in segments:
        name = segment.strip().rstrip(")").split(" as ", 1)[0].strip()
        if not name or name.startswith("*"):
            continue
        if _is_identifier_name(name):
            used.add(name)
    return used


def _top_level_comma_segments(text: str) -> list[str]:
    """Split text into top-level comma separated segments.

    :param text: Text to split.
    :return: Top-level segments.
    """
    segments: list[str] = []
    segment_start = 0
    depth = 0
    for index, char in _iter_code_chars(text):
        if char in "([{":
            depth += 1
            continue
        if char in ")]}":
            depth = max(0, depth - 1)
            continue
        if char == "," and depth == 0:
            segments.append(text[segment_start:index])
            segment_start = index + 1
    segments.append(text[segment_start:])
    return segments


def _iter_code_chars(text: str):
    """Yield source characters outside strings and comments.

    :param text: Source text.
    :return: Iterator of ``(index, char)`` pairs.
    """
    quote_char: str | None = None
    triple_quote = False
    escaped = False
    index = 0
    length = len(text)

    while index < length:
        char = text[index]

        if quote_char is None:
            if char == "#":
                return
            if text.startswith("'''", index) or text.startswith('"""', index):
                quote_char = char
                triple_quote = True
                index += 3
                continue
            if char in ("'", '"'):
                quote_char = char
                triple_quote = False
                escaped = False
                index += 1
                continue
            yield index, char
            index += 1
            continue

        if escaped:
            escaped = False
            index += 1
            continue
        if char == "\\":
            escaped = True
            index += 1
            continue
        if triple_quote:
            if text.startswith(quote_char * 3, index):
                quote_char = None
                triple_quote = False
                index += 3
                continue
            index += 1
            continue
        if char == quote_char:
            quote_char = None
        index += 1


def _matching_bracket(opener: str) -> str:
    """Return the closing bracket for one opener.

    :param opener: Opening bracket.
    :return: Matching closing bracket.
    """
    return {"(": ")", "[": "]", "{": "}"}[opener]


def _is_identifier_char(char: str) -> bool:
    """Return whether a character can appear in a Python identifier.

    :param char: Character to inspect.
    :return: True for ASCII identifier characters.
    """
    return char.isalnum() or char == "_"


def _is_identifier_start(char: str) -> bool:
    """Return whether a character can start a Python identifier.

    :param char: Character to inspect.
    :return: True for ASCII identifier start characters.
    """
    return char.isalpha() or char == "_"


def _is_identifier_name(text: str) -> bool:
    """Return whether text is a plain Python identifier.

    :param text: Text to inspect.
    :return: True when text is identifier-shaped.
    """
    return bool(text) and _is_identifier_start(text[0]) and all(
        _is_identifier_char(char)
        for char in text[1:]
    )
