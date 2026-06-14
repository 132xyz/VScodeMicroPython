"""MicroPython-aware prompt lexer and style helpers.

:return: None
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any

from prompt_toolkit.document import Document
from prompt_toolkit.lexers import Lexer, PygmentsLexer
from prompt_toolkit.styles import Style
from pygments.lexers.python import PythonLexer


MICROPYTHON_CORE_MODULES = {
    "gc",
    "json",
    "machine",
    "math",
    "micropython",
    "network",
    "os",
    "struct",
    "sys",
    "time",
    "uasyncio",
}
MICROPYTHON_BUILTINS = {
    "const",
    "help",
    "open",
    "mem8",
    "mem16",
    "mem32",
    "ptr8",
    "ptr16",
    "ptr32",
}


class MicroPythonLexer(Lexer):
    """Wrap PythonLexer and add MicroPython/session-aware name classes.

    :return: None
    """

    def __init__(
        self,
        session_symbols: Any | None = None,
        module_names: Iterable[str] = (),
    ) -> None:
        """Initialize the lexer.

        :param session_symbols: Optional ReplSessionSymbols-like object.
        :param module_names: Additional known module names, usually from stubs.
        :return: None
        """
        self._python_lexer = PygmentsLexer(PythonLexer)
        self._session_symbols = session_symbols
        self._module_names = set(MICROPYTHON_CORE_MODULES)
        self._module_names.update(module_names)

    def lex_document(self, document: Document):
        """Return a line lexer for one prompt document.

        :param document: Prompt document.
        :return: Callable that returns styled fragments for one line.
        """
        get_python_line = self._python_lexer.lex_document(document)

        def get_line(line_number: int):
            session_meta = self._session_meta()
            module_names = self._module_names | {
                name
                for name, meta in session_meta.items()
                if meta == "session module"
            }
            return [
                (
                    _style_for_fragment(style, text, session_meta, module_names),
                    text,
                )
                for style, text in get_python_line(line_number)
            ]

        return get_line

    def invalidation_hash(self):
        """Return a hashable value that changes with known session symbols.

        :return: Invalidation marker.
        """
        return (
            tuple(sorted(self._module_names)),
            tuple(sorted(self._session_meta().items())),
        )

    def _session_meta(self) -> dict[str, str]:
        """Return session completion metadata when the symbol table supports it.

        :return: Session names mapped to metadata labels.
        """
        if self._session_symbols is None:
            return {}

        meta_provider = getattr(self._session_symbols, "bare_candidate_meta", None)
        if meta_provider is None:
            return {}
        return dict(meta_provider())


def build_repl_style() -> Style:
    """Return the prompt-toolkit style used by the custom REPL.

    :return: Prompt style.
    """
    return Style.from_dict(
        {
            "completion-menu.completion": "bg:#202020 #d4d4d4",
            "completion-menu.completion.current": "bg:#264f78 #ffffff",
            "completion-menu.meta.completion": "bg:#202020 #9cdcfe",
            "completion-menu.meta.completion.current": "bg:#264f78 #ffffff",
            "scrollbar.background": "bg:#303030",
            "scrollbar.button": "bg:#606060",
            "mpyrepl.module": "#4ec9b0 bold",
            "mpyrepl.builtin": "#d7ba7d",
            "mpyrepl.session.module": "#4ec9b0 bold",
            "mpyrepl.session.import": "#4ec9b0",
            "mpyrepl.session.variable": "#9cdcfe",
            "mpyrepl.session.function": "#dcdcaa",
            "mpyrepl.session.class": "#4fc1ff bold",
            "pygments.comment": "#6a9955",
            "pygments.keyword": "#c586c0",
            "pygments.keyword.namespace": "#c586c0",
            "pygments.literal.number": "#b5cea8",
            "pygments.literal.string": "#ce9178",
            "pygments.name.class": "#4fc1ff bold",
            "pygments.name.function": "#dcdcaa",
            "pygments.operator": "#d4d4d4",
            "pygments.punctuation": "#d4d4d4",
        }
    )


def _style_for_fragment(
    style: str,
    text: str,
    session_meta: dict[str, str],
    module_names: set[str],
) -> str:
    """Return an enriched style for one lexer fragment.

    :param style: Existing prompt-toolkit style string.
    :param text: Fragment text.
    :param session_meta: Session names mapped to metadata labels.
    :param module_names: Known module names.
    :return: Style with optional MicroPython-specific class.
    """
    if not _is_name_fragment(style, text):
        return style

    if "class:pygments.name.class" in style:
        return _append_style(style, "class:mpyrepl.session.class")
    if "class:pygments.name.function" in style:
        return _append_style(style, "class:mpyrepl.session.function")

    meta_style = _session_style(session_meta.get(text, ""))
    if meta_style:
        return _append_style(style, meta_style)
    if text in module_names:
        return _append_style(style, "class:mpyrepl.module")
    if text in MICROPYTHON_BUILTINS:
        return _append_style(style, "class:mpyrepl.builtin")
    return style


def _is_name_fragment(style: str, text: str) -> bool:
    """Return whether a fragment is an identifier token.

    :param style: Existing style string.
    :param text: Fragment text.
    :return: True for Pygments name tokens.
    """
    return text.isidentifier() and "class:pygments.name" in style


def _session_style(meta: str) -> str:
    """Return a custom style class for one session metadata label.

    :param meta: Completion metadata label.
    :return: Prompt-toolkit style class, or an empty string.
    """
    if meta == "session module":
        return "class:mpyrepl.session.module"
    if meta == "session import":
        return "class:mpyrepl.session.import"
    if meta == "session variable":
        return "class:mpyrepl.session.variable"
    if meta == "session function":
        return "class:mpyrepl.session.function"
    if meta == "session class":
        return "class:mpyrepl.session.class"
    return ""


def _append_style(style: str, custom_style: str) -> str:
    """Append one style class while preserving the original lexer style.

    :param style: Original style string.
    :param custom_style: Custom style class.
    :return: Combined style string.
    """
    if not style:
        return custom_style
    return f"{style} {custom_style}"
