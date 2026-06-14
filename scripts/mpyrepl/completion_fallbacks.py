"""Curated local fallback completions for common MicroPython modules.

:return: None
"""

from __future__ import annotations

import ast

from completion_state import ReplSessionSymbols


FALLBACK_MODULE_MEMBERS: dict[str, dict[str, str]] = {
    "lvgl": {
        "ALIGN": "fallback enum",
        "EVENT": "fallback enum",
        "FLEX_ALIGN": "fallback enum",
        "GRID_ALIGN": "fallback enum",
        "OPA": "fallback enum",
        "PART": "fallback enum",
        "STATE": "fallback enum",
        "STYLE": "fallback enum",
        "SYMBOL": "fallback enum",
        "anim_t": "fallback class",
        "arc": "fallback class",
        "bar": "fallback class",
        "btn": "fallback class",
        "chart": "fallback class",
        "checkbox": "fallback class",
        "color_hex": "fallback function",
        "dropdown": "fallback class",
        "event_t": "fallback class",
        "img": "fallback class",
        "label": "fallback class",
        "line": "fallback class",
        "list": "fallback class",
        "obj": "fallback class",
        "palette_main": "fallback function",
        "scr_act": "fallback function",
        "screen_active": "fallback function",
        "slider": "fallback class",
        "style_t": "fallback class",
        "textarea": "fallback class",
        "theme_apply": "fallback function",
        "tick_elaps": "fallback function",
        "tick_get": "fallback function",
        "tick_inc": "fallback function",
        "tick_set_cb": "fallback function",
        "tick_state_t": "fallback class",
        "tileview": "fallback class",
        "tileview_class": "fallback class",
    },
    "machine": {
        "ADC": "fallback class",
        "I2C": "fallback class",
        "Pin": "fallback class",
        "PWM": "fallback class",
        "RTC": "fallback class",
        "SPI": "fallback class",
        "Signal": "fallback class",
        "Timer": "fallback class",
        "UART": "fallback class",
        "freq": "fallback function",
        "reset": "fallback function",
        "soft_reset": "fallback function",
        "unique_id": "fallback function",
    },
    "os": {
        "chdir": "fallback function",
        "getcwd": "fallback function",
        "ilistdir": "fallback function",
        "listdir": "fallback function",
        "mkdir": "fallback function",
        "remove": "fallback function",
        "rename": "fallback function",
        "rmdir": "fallback function",
        "stat": "fallback function",
        "statvfs": "fallback function",
        "sync": "fallback function",
        "uname": "fallback function",
    },
    "time": {
        "localtime": "fallback function",
        "mktime": "fallback function",
        "sleep": "fallback function",
        "sleep_ms": "fallback function",
        "sleep_us": "fallback function",
        "ticks_add": "fallback function",
        "ticks_cpu": "fallback function",
        "ticks_diff": "fallback function",
        "ticks_ms": "fallback function",
        "ticks_us": "fallback function",
        "time": "fallback function",
    },
}

FALLBACK_CLASS_MEMBERS: dict[tuple[str, str], dict[str, str]] = {
    ("lvgl", "obj"): {
        "add_event_cb": "fallback function",
        "add_flag": "fallback function",
        "align": "fallback function",
        "clear_flag": "fallback function",
        "get_height": "fallback function",
        "get_parent": "fallback function",
        "get_width": "fallback function",
        "set_height": "fallback function",
        "set_pos": "fallback function",
        "set_size": "fallback function",
        "set_style_bg_color": "fallback function",
        "set_style_text_color": "fallback function",
        "set_width": "fallback function",
    },
    ("lvgl", "label"): {
        "align": "fallback function",
        "set_text": "fallback function",
        "set_long_mode": "fallback function",
        "set_style_text_color": "fallback function",
    },
}


def fallback_candidates_for_expression(
    expression: str,
    session_symbols: ReplSessionSymbols,
) -> dict[str, str]:
    """Return curated fallback candidates for common module expressions.

    :param expression: Prompt expression before the completion prefix.
    :param session_symbols: Session symbol tracker.
    :return: Candidate names mapped to display metadata.
    """
    expression = session_symbols.resolve_static_expression(expression)
    try:
        tree = ast.parse(expression, mode="eval")
    except SyntaxError:
        return {}
    return _fallback_candidates_for_node(tree.body, session_symbols)


def _fallback_candidates_for_node(
    node: ast.AST,
    session_symbols: ReplSessionSymbols,
) -> dict[str, str]:
    """Return fallback candidates for a parsed expression node.

    :param node: Expression AST node.
    :param session_symbols: Session symbol tracker.
    :return: Candidate names mapped to display metadata.
    """
    if isinstance(node, ast.Name):
        module_name = session_symbols.resolve_module_alias(node.id) or node.id
        return dict(FALLBACK_MODULE_MEMBERS.get(module_name, {}))

    if isinstance(node, ast.Call):
        path = _path_from_node(node.func)
        if len(path) >= 2:
            module_name = session_symbols.resolve_module_alias(path[0]) or path[0]
            class_name = path[-1]
            return dict(FALLBACK_CLASS_MEMBERS.get((module_name, class_name), {}))
        return {}

    if isinstance(node, ast.Attribute):
        value_candidates = _fallback_candidates_for_node(node.value, session_symbols)
        if node.attr in value_candidates:
            module_path = _path_from_node(node)
            if len(module_path) >= 2:
                module_name = session_symbols.resolve_module_alias(module_path[0]) or module_path[0]
                return dict(FALLBACK_CLASS_MEMBERS.get((module_name, module_path[-1]), {}))
        return {}

    return {}


def _path_from_node(node: ast.AST) -> list[str]:
    """Return a simple dotted path for names and attributes.

    :param node: Expression node.
    :return: Dotted path parts.
    """
    if isinstance(node, ast.Name):
        return [node.id]
    if isinstance(node, ast.Attribute):
        base = _path_from_node(node.value)
        return [*base, node.attr] if base else []
    if isinstance(node, ast.Call):
        return _path_from_node(node.func)
    return []
