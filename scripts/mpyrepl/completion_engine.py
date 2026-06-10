"""Prompt-toolkit completer for the custom REPL.

:return: None
"""

from __future__ import annotations

import builtins as py_builtins
import io
import keyword
import re
import tokenize
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable

from prompt_toolkit.completion import Completer, Completion
from prompt_toolkit.document import Document

from completion_state import ReplSessionSymbols


META_COMMANDS = (":q", ":quit", ":exit")
DEFAULT_CORE_MODULES = {
    "gc",
    "json",
    "machine",
    "math",
    "micropython",
    "os",
    "struct",
    "sys",
    "time",
}
BARE_PATTERN = re.compile(r"([A-Za-z_][A-Za-z0-9_]*)$")
META_PATTERN = re.compile(r"(:[A-Za-z]*)$")
DOTTED_PATTERN = re.compile(r"([A-Za-z_][A-Za-z0-9_\.]*)\.([A-Za-z0-9_]*)$")


@dataclass(frozen=True, slots=True)
class CompletionRequest:
    """Parsed completion target at the cursor.

    :return: None
    """

    kind: str
    expression: str
    prefix: str


def discover_stub_modules(stub_root: str | None) -> set[str]:
    """Return top-level module names exposed by one stub root.

    :param stub_root: Root directory containing MicroPython stubs.
    :return: Discovered top-level module names.
    """
    if not stub_root:
        return set()

    root = Path(stub_root)
    if not root.is_dir():
        return set()

    modules: set[str] = set()
    for child in root.iterdir():
        if child.name.startswith("."):
            continue
        if child.is_file() and child.suffix == ".pyi" and child.stem != "__init__":
            modules.add(child.stem)
            continue
        if child.is_dir() and (child / "__init__.pyi").is_file():
            modules.add(child.name)
    return modules


def builtin_candidates() -> set[str]:
    """Return host-side builtin names suitable for REPL bare completion.

    :return: Builtin candidate set.
    """
    return {
        name
        for name in dir(py_builtins)
        if name and not name.startswith("__")
    }


BUILTIN_CANDIDATES = builtin_candidates()


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
    if cursor_in_string_or_comment(line_before_cursor):
        return None

    dotted_match = DOTTED_PATTERN.search(line_before_cursor)
    if dotted_match is not None:
        return CompletionRequest(
            kind="dotted",
            expression=dotted_match.group(1),
            prefix=dotted_match.group(2),
        )

    meta_match = META_PATTERN.search(line_before_cursor)
    if meta_match is not None:
        return CompletionRequest(kind="meta", expression="", prefix=meta_match.group(1))

    bare_match = BARE_PATTERN.search(line_before_cursor)
    if bare_match is not None:
        return CompletionRequest(kind="bare", expression="", prefix=bare_match.group(1))

    return None


class ReplCompleter(Completer):
    """Serve local and optional device-backed completions for the custom REPL.

    :return: None
    """

    def __init__(
        self,
        session_symbols: ReplSessionSymbols,
        stub_root: str | None = None,
        dotted_provider: Callable[[str, str], Iterable[str]] | None = None,
    ) -> None:
        """Initialize completion sources.

        :param session_symbols: Mutable session symbol table.
        :param stub_root: Optional stub root for top-level modules.
        :param dotted_provider: Optional provider for dotted member lookups.
        :return: None
        """
        self._session_symbols = session_symbols
        self._stub_modules = discover_stub_modules(stub_root)
        self._dotted_provider = dotted_provider
        self._runtime_cache: dict[str, list[str]] = {}

    def has_completion_target(self, document: Document) -> bool:
        """Return whether completion should be attempted at the cursor.

        :param document: Prompt document.
        :return: True when completion parsing succeeds.
        """
        return parse_completion_request(document) is not None

    def clear_runtime_cache(self) -> None:
        """Clear cached runtime data between executions.

        :return: None
        """
        self._runtime_cache.clear()

    def get_completions(self, document: Document, complete_event):
        """Yield completions for the current cursor location.

        :param document: Prompt document.
        :param complete_event: Prompt-toolkit completion event.
        :return: Iterator of Completion values.
        """
        request = parse_completion_request(document)
        if request is None:
            return

        if request.kind == "dotted":
            if self._dotted_provider is None:
                return
            candidates = self._runtime_cache.get(request.expression)
            if candidates is None:
                candidates = sorted(
                    dict.fromkeys(self._dotted_provider(request.expression, request.prefix))
                )
                self._runtime_cache[request.expression] = candidates
        else:
            candidates = sorted(self._bare_candidates(request))

        prefix = request.prefix
        start_position = -len(prefix)
        for candidate in candidates:
            if not candidate.startswith(prefix):
                continue
            yield Completion(candidate, start_position=start_position, display=candidate)

    def _bare_candidates(self, request: CompletionRequest) -> set[str]:
        """Return local completion candidates for bare or meta prefixes.

        :param request: Parsed completion request.
        :return: Candidate set.
        """
        if request.kind == "meta":
            return set(META_COMMANDS)

        candidates = set(keyword.kwlist)
        candidates.update(BUILTIN_CANDIDATES)
        candidates.update(DEFAULT_CORE_MODULES)
        candidates.update(self._session_symbols.bare_candidates())
        candidates.update(self._stub_modules)
        return candidates
