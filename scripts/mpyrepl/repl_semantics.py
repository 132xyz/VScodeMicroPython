"""Minimal REPL semantics helpers for expression echo.

:return: None
"""

from __future__ import annotations

import ast


HELPER_SOURCE = """
class __mpy_repl_helper:
    last_non_none_repl_value = None

    @classmethod
    def print_repl_value(cls, obj):
        if obj is not None:
            globals()['_'] = obj
            cls.last_non_none_repl_value = obj
            print(repr(obj))
""".strip()


def build_helper_source() -> str:
    """Return the helper source injected into the device session.

    :return: Helper Python source.
    """
    return HELPER_SOURCE


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
                        value=ast.Name(id="__mpy_repl_helper", ctx=ast.Load()),
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
