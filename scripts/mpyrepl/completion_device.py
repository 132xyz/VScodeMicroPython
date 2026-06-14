"""Device-backed dotted completion helpers.

:return: None
"""

from __future__ import annotations

import ast
import textwrap

from completion_state import ReplSessionSymbols
from transport import SerialReplTransport, TransportError


DEFAULT_DIR_QUERY_TIMEOUT = 2.0


def _split_expression(expression: str) -> tuple[str, str]:
    """Split a dotted expression into root name and suffix.

    :param expression: Dotted expression.
    :return: Root identifier and dotted suffix.
    """
    if "." not in expression:
        return expression, ""
    root, suffix = expression.split(".", 1)
    return root, "." + suffix


def _resolved_expression(expression: str, session_symbols: ReplSessionSymbols) -> str:
    """Rewrite known import aliases to their real module roots.

    :param expression: Raw dotted expression from the prompt.
    :param session_symbols: Tracked REPL symbols.
    :return: Expression suitable for `dir()` probing.
    """
    return session_symbols.resolve_runtime_expression(expression)


def _build_dir_query_source(expression: str, session_symbols: ReplSessionSymbols) -> str:
    """Build one safe raw-REPL snippet for `dir()` lookup.

    :param expression: Prompt expression before the final attribute prefix.
    :param session_symbols: Tracked REPL symbols.
    :return: Python source executed on the device.
    """
    root, suffix = _split_expression(expression)
    resolved_expression = _resolved_expression(expression, session_symbols)
    fallback_name = session_symbols.resolve_module_alias(root) or root
    fallback_clause = ""
    if root.isidentifier():
        fallback_clause = (
            f"except NameError:\n"
            f"    try:\n"
            f"        _mpy_target = __import__({fallback_name!r}){suffix}\n"
            f"    except Exception:\n"
            f"        _mpy_target = None\n"
        )

    source = (
        "_mpy_target = None\n"
        "try:\n"
        f"    _mpy_target = {resolved_expression}\n"
        f"{fallback_clause}"
        "except Exception:\n"
        "    _mpy_target = None\n\n"
        "if _mpy_target is not None:\n"
        "    for _mpy_name in dir(_mpy_target):\n"
        "        if not str(_mpy_name).startswith('_'):\n"
        "            print(repr(_mpy_name))\n"
    )
    return textwrap.dedent(source).strip()


def _parse_dir_output(stdout: bytes) -> list[str]:
    """Parse newline-delimited repr(name) output from the device.

    :param stdout: Raw stdout bytes.
    :return: Parsed attribute names.
    """
    names: list[str] = []
    for line in stdout.decode("utf-8", errors="replace").splitlines():
        raw_value = line.strip()
        if not raw_value:
            continue
        try:
            value = ast.literal_eval(raw_value)
        except (SyntaxError, ValueError):
            continue
        if isinstance(value, str) and not value.startswith("_"):
            names.append(value)
    return names


def query_device_attributes(
    transport: SerialReplTransport,
    gate,
    session_symbols: ReplSessionSymbols,
    expression: str,
    timeout: float = DEFAULT_DIR_QUERY_TIMEOUT,
) -> list[str]:
    """Query device attribute names for one dotted completion request.

    :param transport: Active raw REPL transport.
    :param gate: Shared raw REPL operation gate.
    :param session_symbols: Tracked REPL symbols.
    :param expression: Prompt expression before the final attribute prefix.
    :param timeout: Device query timeout.
    :return: Parsed attribute names or an empty list.
    """
    source = _build_dir_query_source(expression, session_symbols)
    try:
        result = gate.try_run_blocking("dir-query", transport.exec_raw, source, timeout)
    except TransportError:
        return []

    if result is None or result.stderr:
        return []
    return _parse_dir_output(result.stdout)
