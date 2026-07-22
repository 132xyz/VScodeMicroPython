"""Minimal REPL semantics helpers for expression echo.

:return: None
"""

from __future__ import annotations

import ast


HELPER_SOURCE_TEMPLATE = """
class __mpy_helper:
    version = __MPY_HELPER_VERSION__

    def __init__(self):
        self.last_non_none_repl_value = None

    def __repr__(self):
        return '<__mpy MicroPython WorkBench REPL helper version=%s>' % self.version

    def safe_repr(self, obj):
        try:
            return repr(obj)
        except RuntimeError as exc:
            if 'recursion' not in str(exc):
                raise
            return self.fallback_repr(obj)

    def fallback_repr(self, obj):
        try:
            obj_type = type(obj).__name__
        except Exception:
            obj_type = 'object'
        try:
            if isinstance(obj, dict):
                return '<dict len=%d keys=%r>' % (len(obj), list(obj.keys()))
        except Exception:
            pass
        try:
            return '<%s len=%d repr failed>' % (obj_type, len(obj))
        except Exception:
            return '<%s repr failed>' % obj_type

    def print_repl_value(self, obj):
        if obj is not None:
            text = self.safe_repr(obj)
            if obj is not globals():
                globals()['_'] = obj
                self.last_non_none_repl_value = obj
            print(text)

__mpy = __mpy_helper()
try:
    del __mpy_repl_helper
except Exception:
    pass
del __mpy_helper
""".strip()


def build_helper_source(helper_version: str = "") -> str:
    """Return the helper source injected into the device session.

    :param helper_version: Version string shown by the injected helper.
    :return: Helper Python source.
    """
    version = str(helper_version or "unknown")
    return HELPER_SOURCE_TEMPLATE.replace("__MPY_HELPER_VERSION__", repr(version))


def instrument_source(source: str) -> str:
    """Wrap top-level expression statements for REPL-style echo.

    :param source: User source code.
    :return: Instrumented source or the original source when parsing fails.
    """
    try:
        tree = ast.parse(source, mode="exec")
    except SyntaxError:
        return source

    changed = False
    instrumented_body = []
    for node in tree.body:
        if isinstance(node, ast.Expr):
            wrapped = ast.Expr(
                value=ast.Call(
                    func=ast.Attribute(
                        value=ast.Name(id="__mpy", ctx=ast.Load()),
                        attr="print_repl_value",
                        ctx=ast.Load(),
                    ),
                    args=[node.value],
                    keywords=[],
                )
            )
            wrapped = ast.copy_location(wrapped, node)
            instrumented_body.append(wrapped)
            changed = True
        else:
            instrumented_body.append(node)

    if not changed:
        return source

    tree.body = instrumented_body
    ast.fix_missing_locations(tree)
    return ast.unparse(tree)
