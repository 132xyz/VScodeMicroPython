"""Indentation helpers for the custom REPL.

:return: None
"""

from __future__ import annotations

import codeop


INDENT = "    "


def leading_indent_prefix(line: str) -> str:
    """Return the leading whitespace prefix of one line.

    :param line: Source line.
    :return: Leading whitespace prefix.
    """
    indent_width = len(line) - len(line.lstrip(" \t"))
    return line[:indent_width]


def continuation_default(lines: list[str]) -> str:
    """Compute the suggested indent prefix for the next line.

    :param lines: Buffered source lines.
    :return: Suggested indent prefix.
    """
    if not lines:
        return ""

    previous = lines[-1].rstrip()
    prefix = leading_indent_prefix(previous)
    if previous.endswith(":"):
        return prefix + INDENT
    return prefix


def should_start_multiline(line: str) -> bool:
    """Return whether a single entered line opens a multi-line block.

    :param line: Source line without a trailing newline.
    :return: True when more input is required.
    """
    try:
        return codeop.compile_command(line, symbol="exec") is None
    except (OverflowError, SyntaxError, ValueError):
        return False


def is_block_complete(source: str) -> bool:
    """Return whether the current source can be submitted as one block.

    :param source: Full source block.
    :return: True when compile_command considers the block complete.
    """
    if not source.strip():
        return True

    try:
        return codeop.compile_command(source, symbol="exec") is not None
    except (OverflowError, SyntaxError, ValueError):
        return True