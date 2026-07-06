"""Static `.pyi`/`.py` completion index for the custom REPL.

:return: None
"""

from __future__ import annotations

import ast
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path

from completion_state import ReplSessionSymbols


@dataclass(slots=True)
class StubMember:
    """One static stub symbol.

    :return: None
    """

    name: str
    kind: str
    return_path: list[str] = field(default_factory=list)
    return_display: str = ""
    signature: str = ""
    parameters: list[str] = field(default_factory=list)
    parameter_displays: dict[str, str] = field(default_factory=dict)
    children: dict[str, "StubMember"] = field(default_factory=dict)


def _normalize_roots(stub_root: str | Path | Sequence[str | Path] | None) -> list[Path]:
    """Return an ordered list of non-empty completion roots.

    :param stub_root: One path or an iterable of paths.
    :return: Ordered path list with duplicates removed.
    """
    if stub_root is None:
        return []

    values: list[str | Path]
    if isinstance(stub_root, (str, Path)):
        values = [stub_root]
    else:
        values = list(stub_root)

    roots: list[Path] = []
    seen: set[str] = set()
    for value in values:
        if not value:
            continue
        path = Path(value)
        key = str(path).replace("\\", "/").lower()
        if key in seen:
            continue
        seen.add(key)
        roots.append(path)
    return roots


class StubCompletionIndex:
    """Index importable `.pyi` and `.py` files for fast dotted completion.

    :return: None
    """

    def __init__(self, stub_root: str | Path | Sequence[str | Path] | None) -> None:
        """Build an index for one or more completion roots.

        :param stub_root: Root directory or ordered root list containing `.pyi` and `.py` files.
        :return: None
        """
        self._roots = _normalize_roots(stub_root)
        self._modules: dict[tuple[str, ...], StubMember] = {}
        self._load()

    def module_names(self) -> set[str]:
        """Return top-level module names.

        :return: Top-level module names in the stub root.
        """
        return {parts[0] for parts in self._modules if parts}

    def candidates_for_expression(
        self,
        expression: str,
        session_symbols: ReplSessionSymbols,
    ) -> dict[str, str]:
        """Return static candidates for one dotted expression.

        :param expression: Prompt expression before the completion prefix.
        :param session_symbols: Session alias tracker.
        :return: Candidate names mapped to source/type metadata.
        """
        current = self._member_for_expression(expression, session_symbols)
        if current is None:
            return {}

        return {
            name: _display_meta(member)
            for name, member in sorted(current.children.items())
            if name and not name.startswith("_")
        }

    def parameter_candidates_for_call(
        self,
        expression: str,
        used_keywords: frozenset[str],
        session_symbols: ReplSessionSymbols,
    ) -> dict[str, str]:
        """Return keyword parameter completions for one call expression.

        :param expression: Call target expression.
        :param used_keywords: Keyword arguments already present in the call.
        :param session_symbols: Session alias tracker.
        :return: Parameter completions mapped to source/type metadata.
        """
        current = self._member_for_expression(expression, session_symbols)
        if current is None:
            return {}

        return {
            f"{name}=": current.parameter_displays.get(name, "stub parameter")
            for name in current.parameters
            if name not in used_keywords and not name.startswith("_")
        }

    def _load(self) -> None:
        """Load all visible `.pyi` and `.py` modules under the root.

        :return: None
        """
        for root in self._roots:
            if not root.is_dir():
                continue

            for pattern in ("*.pyi", "*.py"):
                for path in sorted(root.rglob(pattern)):
                    if any(part.startswith(".") for part in path.relative_to(root).parts):
                        continue

                    module_parts = self._module_parts(path, root)
                    if not module_parts or module_parts in self._modules:
                        continue

                    self._modules[module_parts] = _parse_stub_file(path, module_parts)

    def _module_parts(self, path: Path, root: Path) -> tuple[str, ...]:
        """Return import path parts for one stub/source file.

        :param path: Stub file path.
        :param root: Completion root containing the file.
        :return: Import path parts.
        """
        relative = path.relative_to(root)
        if relative.name in {"__init__.pyi", "__init__.py"}:
            return tuple(part for part in relative.parent.parts if part)
        return tuple(relative.with_suffix("").parts)

    def _split_module_path(self, path: list[str]) -> tuple[tuple[str, ...], list[str]]:
        """Split a symbol path into module prefix and member suffix.

        :param path: Symbol path.
        :return: Longest module prefix and remaining member path.
        """
        for end in range(len(path), 0, -1):
            module_parts = tuple(path[:end])
            if module_parts in self._modules:
                return module_parts, path[end:]
        return (), []

    def _member_for_expression(
        self,
        expression: str,
        session_symbols: ReplSessionSymbols,
    ) -> StubMember | None:
        """Resolve one prompt expression to a stub member.

        :param expression: Prompt expression.
        :param session_symbols: Session symbol tracker.
        :return: Matching stub member or None.
        """
        expression = session_symbols.resolve_static_expression(expression)
        try:
            tree = ast.parse(expression, mode="eval")
        except SyntaxError:
            path = _path_from_canonical_key(session_symbols.canonical_cache_key(expression))
            return self._member_for_path(path)
        return self._member_for_node(tree.body, session_symbols)

    def _member_for_node(
        self,
        node: ast.AST,
        session_symbols: ReplSessionSymbols,
    ) -> StubMember | None:
        """Resolve one expression node to a stub member.

        :param node: AST expression node.
        :param session_symbols: Session symbol tracker.
        :return: Matching stub member or None.
        """
        if isinstance(node, ast.Name):
            expanded = session_symbols.resolve_static_expression(node.id)
            if expanded != node.id:
                return self._member_for_expression(expanded, session_symbols)

            aliased_module = session_symbols.resolve_module_alias(node.id)
            if aliased_module:
                return self._member_for_path([aliased_module])

            path = _path_from_canonical_key(session_symbols.canonical_cache_key(node.id))
            if path:
                return self._member_for_path(path)
            return self._member_for_path([node.id])

        if isinstance(node, ast.Attribute):
            if not _contains_call_or_subscript(node):
                path = _path_from_node(node)
                if path:
                    aliased_root = session_symbols.resolve_module_alias(path[0])
                    if aliased_root:
                        path = [aliased_root, *path[1:]]
                    member = self._member_for_path(path)
                    if member is not None:
                        return member

            value = self._member_for_node(node.value, session_symbols)
            if value is None:
                return None
            return value.children.get(node.attr)

        if isinstance(node, ast.Call):
            member = self._member_for_node(node.func, session_symbols)
            if member is None:
                return None
            if member.kind == "class":
                return member
            if member.return_path:
                return self._member_for_path(member.return_path)
            return member

        if isinstance(node, ast.Subscript):
            return self._member_for_node(node.value, session_symbols)

        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            return self._member_for_expression(node.value, session_symbols)

        return None

    def _member_for_path(self, path: list[str]) -> StubMember | None:
        """Resolve an import/member path to a stub member.

        :param path: Symbol path.
        :return: Matching stub member or None.
        """
        if not path:
            return None

        module_parts, remainder = self._split_module_path(path)
        if not module_parts:
            return None

        current = self._modules[module_parts]
        for part in remainder:
            child = current.children.get(part)
            if child is None:
                return None
            current = child
        return current


def _parse_stub_file(path: Path, module_parts: tuple[str, ...]) -> StubMember:
    """Parse one `.pyi`/`.py` file into a static symbol tree.

    :param path: Stub file path.
    :param module_parts: Import path parts for this module.
    :return: Parsed module symbol.
    """
    module = StubMember(module_parts[-1], "module")
    try:
        tree = ast.parse(path.read_text(encoding="utf-8"))
    except (OSError, SyntaxError, UnicodeDecodeError):
        return module

    _populate_children(module, tree.body, list(module_parts))
    return module


def _populate_children(parent: StubMember, body: list[ast.stmt], module_path: list[str]) -> None:
    """Populate a symbol node from AST statements.

    :param parent: Parent symbol.
    :param body: AST statement list.
    :param module_path: Module path used for relative return annotations.
    :return: None
    """
    for node in body:
        if isinstance(node, ast.ClassDef):
            child = StubMember(node.name, "class")
            _populate_children(child, node.body, module_path)
            init_member = child.children.get("__init__")
            if init_member is not None:
                child.parameters = list(init_member.parameters)
                child.parameter_displays = dict(init_member.parameter_displays)
                child.signature = init_member.signature
            parent.children[node.name] = child
            continue

        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            parent.children[node.name] = StubMember(
                node.name,
                "function",
                return_path=_annotation_path(node.returns, module_path),
                return_display=_annotation_display(node.returns),
                signature=_signature_display(node.args),
                parameters=_parameter_names(node.args),
                parameter_displays=_parameter_displays(node.args),
            )
            continue

        if isinstance(node, ast.AnnAssign):
            for name in _target_names(node.target):
                parent.children[name] = StubMember(name, "attribute")
            continue

        if isinstance(node, ast.Assign):
            for target in node.targets:
                for name in _target_names(target):
                    if name != "__all__":
                        parent.children[name] = StubMember(name, "attribute")
            continue

        if isinstance(node, (ast.Import, ast.ImportFrom)):
            for alias in node.names:
                if alias.name == "*":
                    continue
                local_name = alias.asname or alias.name.split(".", 1)[0]
                parent.children.setdefault(local_name, StubMember(local_name, "import"))


def _target_names(target: ast.AST) -> set[str]:
    """Return names assigned by one target.

    :param target: Assignment target.
    :return: Assigned names.
    """
    if isinstance(target, ast.Name):
        return {target.id}
    if isinstance(target, (ast.Tuple, ast.List)):
        names: set[str] = set()
        for item in target.elts:
            names.update(_target_names(item))
        return names
    return set()


def _parameter_names(args: ast.arguments) -> list[str]:
    """Return keyword-completable parameter names for one function.

    :param args: Function argument node.
    :return: Parameter names in signature order.
    """
    names = [arg.arg for arg in args.args]
    if names and names[0] in {"self", "cls"}:
        names = names[1:]

    keyword_only = [arg.arg for arg in args.kwonlyargs]
    return [
        name
        for name in [*names, *keyword_only]
        if name not in {"self", "cls"}
    ]


def _parameter_displays(args: ast.arguments) -> dict[str, str]:
    """Return menu details for keyword-completable parameters.

    :param args: Function argument node.
    :return: Parameter name to typed/default display text.
    """
    positional = [*args.posonlyargs, *args.args]
    default_offset = len(positional) - len(args.defaults)
    defaults_by_name = {
        arg.arg: args.defaults[index - default_offset]
        for index, arg in enumerate(positional)
        if index >= default_offset
    }

    displays: dict[str, str] = {}
    for arg in args.args:
        if arg.arg in {"self", "cls"}:
            continue
        display = _argument_display(arg, defaults_by_name.get(arg.arg))
        displays[arg.arg] = display if display != arg.arg else "stub parameter"

    for index, arg in enumerate(args.kwonlyargs):
        if arg.arg in {"self", "cls"}:
            continue
        display = _argument_display(arg, args.kw_defaults[index])
        displays[arg.arg] = display if display != arg.arg else "stub parameter"

    return displays


def _signature_display(args: ast.arguments) -> str:
    """Return a compact function signature for the completion menu.

    :param args: Function argument node.
    :return: Compact signature text.
    """
    parts = _signature_parts(args)
    if parts and _parameter_name(parts[0]) in {"self", "cls"}:
        parts = parts[1:]
        if parts and parts[0] == "/":
            parts = parts[1:]
    return f"({', '.join(parts)})"


def _signature_parts(args: ast.arguments) -> list[str]:
    """Return display parts for a function argument list.

    :param args: Function argument node.
    :return: Argument display parts including markers such as ``*``.
    """
    parts: list[str] = []
    positional = [*args.posonlyargs, *args.args]
    default_offset = len(positional) - len(args.defaults)

    for index, arg in enumerate(positional):
        default = args.defaults[index - default_offset] if index >= default_offset else None
        parts.append(_argument_display(arg, default))
        if args.posonlyargs and index == len(args.posonlyargs) - 1:
            parts.append("/")

    if args.vararg is not None:
        parts.append(f"*{args.vararg.arg}")
    elif args.kwonlyargs:
        parts.append("*")

    for index, arg in enumerate(args.kwonlyargs):
        parts.append(_argument_display(arg, args.kw_defaults[index]))

    if args.kwarg is not None:
        parts.append(f"**{args.kwarg.arg}")

    return parts


def _argument_display(arg: ast.arg, default: ast.AST | None) -> str:
    """Return one argument's menu display text.

    :param arg: Argument node.
    :param default: Optional default value node.
    :return: Argument display text.
    """
    annotation = _annotation_display(arg.annotation)
    if annotation:
        display = f"{arg.arg}: {annotation}"
        if default is not None:
            display = f"{display} = {_default_display(default)}"
        return display
    if default is None:
        return arg.arg
    return f"{arg.arg}={_default_display(default)}"


def _default_display(node: ast.AST) -> str:
    """Return a concise display value for a default expression.

    :param node: Default value node.
    :return: Short display text.
    """
    if isinstance(node, ast.Constant):
        if node.value is Ellipsis:
            return "..."
        value = repr(node.value)
        return value if len(value) <= 24 else f"{value[:21]}..."
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        path = _path_from_node(node)
        if path:
            return ".".join(path)
    return "..."


def _parameter_name(part: str) -> str:
    """Return the parameter name from one signature display part.

    :param part: Signature part.
    :return: Bare parameter name or an empty string for markers.
    """
    if part in {"/", "*"}:
        return ""
    name = part.lstrip("*").split("=", 1)[0].strip()
    return name.split(":", 1)[0].strip()


def _expression_path(expression: str) -> list[str]:
    """Return an attribute path for a primary expression.

    :param expression: Prompt expression.
    :return: Attribute path parts, with calls/subscripts folded into their base.
    """
    try:
        tree = ast.parse(expression, mode="eval")
    except SyntaxError:
        return []
    return _path_from_node(tree.body)


def _path_from_node(node: ast.AST) -> list[str]:
    """Return static path parts from one expression node.

    :param node: AST expression node.
    :return: Path parts.
    """
    if isinstance(node, ast.Name):
        return [node.id]
    if isinstance(node, ast.Attribute):
        base = _path_from_node(node.value)
        return [*base, node.attr] if base else []
    if isinstance(node, ast.Call):
        return _path_from_node(node.func)
    if isinstance(node, ast.Subscript):
        return _path_from_node(node.value)
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return [part for part in node.value.split(".") if part]
    return []


def _annotation_path(annotation: ast.AST | None, module_path: list[str]) -> list[str]:
    """Return a static path from a return annotation.

    :param annotation: Return annotation node.
    :param module_path: Current module path for relative names.
    :return: Static path or an empty list.
    """
    if annotation is None:
        return []

    if isinstance(annotation, ast.Name):
        if annotation.id in {"None", "Any", "Self"}:
            return []
        return [*module_path, annotation.id]

    if isinstance(annotation, ast.Attribute):
        return _path_from_node(annotation)

    if isinstance(annotation, ast.Constant) and isinstance(annotation.value, str):
        parts = [part for part in annotation.value.split(".") if part]
        if len(parts) == 1:
            return [*module_path, parts[0]]
        return parts

    if isinstance(annotation, ast.Subscript):
        slice_path = _annotation_path(annotation.slice, module_path)
        if slice_path:
            return slice_path
        return _annotation_path(annotation.value, module_path)

    if isinstance(annotation, ast.BinOp) and isinstance(annotation.op, ast.BitOr):
        return _annotation_path(annotation.left, module_path) or _annotation_path(
            annotation.right,
            module_path,
        )

    return []


def _annotation_display(annotation: ast.AST | None) -> str:
    """Return concise annotation text for the completion menu.

    :param annotation: Annotation node.
    :return: Annotation display text.
    """
    if annotation is None:
        return ""

    if isinstance(annotation, ast.Name):
        return annotation.id

    if isinstance(annotation, ast.Attribute):
        path = _path_from_node(annotation)
        return ".".join(path) if path else ""

    if isinstance(annotation, ast.Constant):
        if annotation.value is None:
            return "None"
        if isinstance(annotation.value, str):
            return annotation.value
        return repr(annotation.value)

    if isinstance(annotation, ast.Subscript):
        value = _annotation_display(annotation.value)
        slice_value = _annotation_display(annotation.slice)
        if value and slice_value:
            return f"{value}[{slice_value}]"
        return value or slice_value

    if isinstance(annotation, ast.Tuple):
        return ", ".join(
            display
            for display in (_annotation_display(item) for item in annotation.elts)
            if display
        )

    if isinstance(annotation, ast.BinOp) and isinstance(annotation.op, ast.BitOr):
        left = _annotation_display(annotation.left)
        right = _annotation_display(annotation.right)
        if left and right:
            return f"{left} | {right}"
        return left or right

    return ""


def _contains_call_or_subscript(node: ast.AST) -> bool:
    """Return whether a node contains a call or subscript.

    :param node: AST node.
    :return: True when expression resolution needs dynamic traversal.
    """
    return any(isinstance(child, (ast.Call, ast.Subscript)) for child in ast.walk(node))


def _path_from_canonical_key(cache_key: str) -> list[str]:
    """Return a module path from a canonical cache key.

    :param cache_key: Canonical cache key from session symbols.
    :return: Module path parts.
    """
    if not cache_key.startswith("module:"):
        return []
    return [part for part in cache_key.removeprefix("module:").split(".") if part]


def _display_meta(member: StubMember) -> str:
    """Return completion menu metadata for one stub kind.

    :param member: Stub member.
    :return: Display metadata.
    """
    base = "stub module" if member.kind == "module" else f"stub {member.kind}"
    detail = ""
    if member.signature:
        detail = member.signature
    if member.return_display:
        detail = f"{detail} -> {member.return_display}" if detail else f"-> {member.return_display}"
    return f"{base} {detail}" if detail else base
