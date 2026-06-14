"""Track session symbols for host-side REPL completion.

:return: None
"""

from __future__ import annotations

import ast
import re
from dataclasses import dataclass, field


ROOT_PATTERN = re.compile(r"([A-Za-z_][A-Za-z0-9_]*)(.*)$", re.DOTALL)


def _split_expression(expression: str) -> tuple[str, str]:
    """Split a dotted expression into root name and suffix.

    :param expression: Dotted expression.
    :return: Root identifier and dotted suffix.
    """
    if "." not in expression:
        return expression, ""
    root, suffix = expression.split(".", 1)
    return root, "." + suffix


def _split_root_suffix(expression: str) -> tuple[str, str]:
    """Split an expression into its root identifier and raw suffix.

    :param expression: Source expression.
    :return: Root identifier and suffix after that root.
    """
    match = ROOT_PATTERN.match(expression.strip())
    if match is None:
        return expression, ""
    return match.group(1), match.group(2)


def _collect_target_names(target: ast.AST) -> set[str]:
    """Collect assigned names from one assignment target.

    :param target: Assignment target node.
    :return: Collected names.
    """
    if isinstance(target, ast.Name):
        return {target.id}
    if isinstance(target, (ast.Tuple, ast.List)):
        names: set[str] = set()
        for item in target.elts:
            names.update(_collect_target_names(item))
        return names
    return set()


def _root_name(node: ast.AST) -> str | None:
    """Return the left-most root name for one expression.

    :param node: Expression node.
    :return: Root identifier when the expression starts with a name.
    """
    current = node
    while isinstance(current, (ast.Attribute, ast.Subscript, ast.Call)):
        if isinstance(current, ast.Attribute):
            current = current.value
            continue
        if isinstance(current, ast.Subscript):
            current = current.value
            continue
        current = current.func

    if isinstance(current, ast.Name):
        return current.id
    return None


@dataclass(slots=True)
class _CollectedSymbols:
    """Temporary symbol extraction result.

    :return: None
    """

    names: set[str] = field(default_factory=set)
    module_aliases: dict[str, str] = field(default_factory=dict)
    runtime_aliases: dict[str, str] = field(default_factory=dict)
    canonical_aliases: dict[str, str] = field(default_factory=dict)
    expression_aliases: dict[str, str] = field(default_factory=dict)
    dict_key_aliases: dict[str, tuple[str, ...]] = field(default_factory=dict)
    symbol_kinds: dict[str, str] = field(default_factory=dict)
    rebound_roots: set[str] = field(default_factory=set)
    mutated_roots: set[str] = field(default_factory=set)
    deleted_names: set[str] = field(default_factory=set)
    clear_runtime_cache: bool = False


@dataclass(frozen=True, slots=True)
class ReplSourceChangeSummary:
    """Changes inferred from one successfully executed REPL source block.

    :return: None
    """

    rebound_roots: set[str] = field(default_factory=set)
    mutated_roots: set[str] = field(default_factory=set)
    clear_runtime_cache: bool = False

    @classmethod
    def empty(cls) -> "ReplSourceChangeSummary":
        """Return an empty change summary.

        :return: Empty summary.
        """
        return cls()


class _SymbolCollector(ast.NodeVisitor):
    """Collect import, assignment, and definition names from executed source.

    :return: None
    """

    def __init__(self, source: str) -> None:
        """Initialize output containers.

        :param source: Source text being analyzed.
        :return: None
        """
        self._source = source
        self.collected = _CollectedSymbols()

    def visit_Import(self, node: ast.Import) -> None:
        """Collect names introduced by plain import statements.

        :param node: Import node.
        :return: None
        """
        for alias in node.names:
            local_name = alias.asname or alias.name.split(".", 1)[0]
            module_name = alias.name.split(".", 1)[0]
            self.collected.names.add(local_name)
            self.collected.symbol_kinds[local_name] = "module"
            self.collected.module_aliases[local_name] = module_name
            self.collected.runtime_aliases[local_name] = f"__import__({module_name!r})"
            self.collected.canonical_aliases[local_name] = f"module:{module_name}"
            self.collected.rebound_roots.add(local_name)

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        """Collect names introduced by from-import statements.

        :param node: ImportFrom node.
        :return: None
        """
        for alias in node.names:
            if alias.name == "*":
                self.collected.clear_runtime_cache = True
                continue
            local_name = alias.asname or alias.name
            self.collected.names.add(local_name)
            self.collected.symbol_kinds[local_name] = "import"
            self.collected.rebound_roots.add(local_name)
            if node.module and "." not in node.module:
                self.collected.runtime_aliases[local_name] = (
                    f"__import__({node.module!r}).{alias.name}"
                )
                self.collected.canonical_aliases[local_name] = (
                    f"module:{node.module}.{alias.name}"
                )

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        """Collect function definitions.

        :param node: FunctionDef node.
        :return: None
        """
        self.collected.names.add(node.name)
        self.collected.symbol_kinds[node.name] = "function"
        self.collected.rebound_roots.add(node.name)

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
        """Collect async function definitions.

        :param node: AsyncFunctionDef node.
        :return: None
        """
        self.collected.names.add(node.name)
        self.collected.symbol_kinds[node.name] = "function"
        self.collected.rebound_roots.add(node.name)

    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        """Collect class definitions.

        :param node: ClassDef node.
        :return: None
        """
        self.collected.names.add(node.name)
        self.collected.symbol_kinds[node.name] = "class"
        self.collected.rebound_roots.add(node.name)

    def visit_Assign(self, node: ast.Assign) -> None:
        """Collect assignment targets.

        :param node: Assign node.
        :return: None
        """
        for target in node.targets:
            self._record_target(target)
            self._record_expression_alias(target, node.value)
            self._record_dict_key_alias(target, node.value)
        self.generic_visit(node)

    def visit_AnnAssign(self, node: ast.AnnAssign) -> None:
        """Collect annotated assignment targets.

        :param node: AnnAssign node.
        :return: None
        """
        self._record_target(node.target)
        if node.value is not None:
            self._record_expression_alias(node.target, node.value)
            self._record_dict_key_alias(node.target, node.value)
        else:
            self._record_expression_alias(node.target, node.annotation)
        self.generic_visit(node)

    def visit_AugAssign(self, node: ast.AugAssign) -> None:
        """Collect augmented assignment targets.

        :param node: AugAssign node.
        :return: None
        """
        self._record_target(node.target)
        self.generic_visit(node)

    def visit_Delete(self, node: ast.Delete) -> None:
        """Collect deleted names and mutated roots.

        :param node: Delete node.
        :return: None
        """
        for target in node.targets:
            names = _collect_target_names(target)
            self.collected.deleted_names.update(names)
            self.collected.rebound_roots.update(names)
            if not names:
                root = _root_name(target)
                if root:
                    self.collected.mutated_roots.add(root)
        self.generic_visit(node)

    def visit_Call(self, node: ast.Call) -> None:
        """Collect dynamic object mutation calls such as setattr/delattr.

        :param node: Call node.
        :return: None
        """
        if (
            isinstance(node.func, ast.Name)
            and node.func.id in {"setattr", "delattr"}
            and node.args
        ):
            root = _root_name(node.args[0])
            if root:
                self.collected.mutated_roots.add(root)
        self.generic_visit(node)

    def visit_For(self, node: ast.For) -> None:
        """Collect loop target names.

        :param node: For node.
        :return: None
        """
        self._record_target(node.target)
        self.generic_visit(node)

    def visit_AsyncFor(self, node: ast.AsyncFor) -> None:
        """Collect async loop target names.

        :param node: AsyncFor node.
        :return: None
        """
        self._record_target(node.target)
        self.generic_visit(node)

    def visit_With(self, node: ast.With) -> None:
        """Collect with-as target names.

        :param node: With node.
        :return: None
        """
        for item in node.items:
            if item.optional_vars is not None:
                self._record_target(item.optional_vars)
        self.generic_visit(node)

    def visit_AsyncWith(self, node: ast.AsyncWith) -> None:
        """Collect async with-as target names.

        :param node: AsyncWith node.
        :return: None
        """
        for item in node.items:
            if item.optional_vars is not None:
                self._record_target(item.optional_vars)
        self.generic_visit(node)

    def visit_ExceptHandler(self, node: ast.ExceptHandler) -> None:
        """Collect exception handler aliases.

        :param node: ExceptHandler node.
        :return: None
        """
        if node.name:
            self.collected.names.add(node.name)
            self.collected.symbol_kinds[node.name] = "variable"
            self.collected.rebound_roots.add(node.name)
        self.generic_visit(node)

    def _record_target(self, target: ast.AST) -> None:
        """Record one assignment-like target.

        :param target: Assignment target.
        :return: None
        """
        names = _collect_target_names(target)
        self.collected.names.update(names)
        for name in names:
            self.collected.symbol_kinds[name] = "variable"
        self.collected.rebound_roots.update(names)
        if names:
            return

        root = _root_name(target)
        if root:
            self.collected.mutated_roots.add(root)

    def _record_expression_alias(self, target: ast.AST, value: ast.AST) -> None:
        """Record static expression aliases from assignment-like statements.

        :param target: Assignment target.
        :param value: Assigned expression or annotation.
        :return: None
        """
        value_source = ast.get_source_segment(self._source, value)
        if value_source is None or not _is_static_expression(value):
            return

        for name in _collect_target_names(target):
            self.collected.expression_aliases[name] = value_source.strip()

    def _record_dict_key_alias(self, target: ast.AST, value: ast.AST) -> None:
        """Record string keys from a simple dict literal assignment.

        :param target: Assignment target.
        :param value: Assigned expression.
        :return: None
        """
        target_name = _single_target_name(target)
        if target_name is None:
            return

        keys = _literal_dict_string_keys(value)
        if keys:
            self.collected.dict_key_aliases[target_name] = keys


class ReplSessionSymbols:
    """Maintain names introduced during one device REPL session.

    :return: None
    """

    def __init__(self) -> None:
        """Initialize a fresh symbol table.

        :return: None
        """
        self._names: set[str] = {"_"}
        self._module_aliases: dict[str, str] = {}
        self._runtime_aliases: dict[str, str] = {}
        self._canonical_aliases: dict[str, str] = {}
        self._expression_aliases: dict[str, str] = {}
        self._dict_key_aliases: dict[str, tuple[str, ...]] = {}
        self._symbol_kinds: dict[str, str] = {"_": "variable"}

    def clear(self) -> None:
        """Reset the tracked state after a session reset.

        :return: None
        """
        self._names = {"_"}
        self._module_aliases = {}
        self._runtime_aliases = {}
        self._canonical_aliases = {}
        self._expression_aliases = {}
        self._dict_key_aliases = {}
        self._symbol_kinds = {"_": "variable"}

    def record_successful_source(self, source: str) -> ReplSourceChangeSummary:
        """Update the symbol table from successfully executed user code.

        :param source: Original user source that executed without stderr.
        :return: Summary of cache-relevant changes.
        """
        try:
            tree = ast.parse(source)
        except SyntaxError:
            return ReplSourceChangeSummary.empty()

        collector = _SymbolCollector(source)
        collector.visit(tree)
        self._names.update(collector.collected.names)
        self._names.difference_update(collector.collected.deleted_names)

        for name in collector.collected.rebound_roots:
            self._module_aliases.pop(name, None)
            self._runtime_aliases.pop(name, None)
            self._canonical_aliases.pop(name, None)
            self._expression_aliases.pop(name, None)
            self._dict_key_aliases.pop(name, None)
            self._symbol_kinds.pop(name, None)

        for name in collector.collected.mutated_roots:
            self._dict_key_aliases.pop(name, None)

        self._module_aliases.update(collector.collected.module_aliases)
        self._runtime_aliases.update(collector.collected.runtime_aliases)
        self._canonical_aliases.update(collector.collected.canonical_aliases)
        self._expression_aliases.update(collector.collected.expression_aliases)
        self._dict_key_aliases.update(collector.collected.dict_key_aliases)
        self._symbol_kinds.update(collector.collected.symbol_kinds)
        for name in collector.collected.deleted_names:
            self._symbol_kinds.pop(name, None)

        return ReplSourceChangeSummary(
            rebound_roots=set(collector.collected.rebound_roots),
            mutated_roots=set(collector.collected.mutated_roots),
            clear_runtime_cache=collector.collected.clear_runtime_cache,
        )

    def bare_candidates(self) -> set[str]:
        """Return the session-introduced candidate names.

        :return: Candidate set.
        """
        return set(self._names)

    def bare_candidate_meta(self) -> dict[str, str]:
        """Return session names with completion menu metadata.

        :return: Candidate names mapped to session kind labels.
        """
        return {
            name: _display_meta_for_kind(self._symbol_kinds.get(name, "value"))
            for name in self._names
        }

    def resolve_module_alias(self, name: str) -> str | None:
        """Resolve a local import alias to its root module name.

        :param name: Local symbol.
        :return: Root module name when known.
        """
        return self._module_aliases.get(name)

    def resolve_runtime_expression(self, expression: str) -> str:
        """Resolve a prompt expression through known import aliases.

        :param expression: Prompt expression.
        :return: Runtime expression suitable for evaluation on the device.
        """
        root, suffix = _split_expression(expression)
        runtime_alias = self._runtime_aliases.get(root)
        if runtime_alias is None:
            return expression
        return f"{runtime_alias}{suffix}"

    def resolve_static_expression(self, expression: str) -> str:
        """Resolve a prompt expression through static assignment aliases.

        :param expression: Prompt expression.
        :return: Expression with a known local root expanded.
        """
        root, suffix = _split_root_suffix(expression)
        seen = {root}
        alias = self._expression_aliases.get(root)
        while alias:
            alias_root, alias_suffix = _split_root_suffix(alias)
            expression = f"{alias}{suffix}"
            if alias_root in seen:
                return expression
            seen.add(alias_root)
            suffix = f"{alias_suffix}{suffix}"
            alias = self._expression_aliases.get(alias_root)
        return expression

    def dict_key_candidates(self, expression: str) -> list[str]:
        """Return known string keys for a simple dict expression.

        :param expression: Expression inside the subscript before ``[``.
        :return: Known string keys in source order.
        """
        expanded_expression = self.resolve_static_expression(expression)
        root, suffix = _split_root_suffix(expanded_expression)
        if suffix:
            return []
        return list(self._dict_key_aliases.get(root, ()))

    def canonical_cache_key(self, expression: str) -> str:
        """Return a stable cache key for one runtime expression.

        :param expression: Prompt expression.
        :return: Cache key that shares imported module aliases.
        """
        root, suffix = _split_expression(expression)
        canonical_alias = self._canonical_aliases.get(root)
        if canonical_alias is None:
            return f"expr:{expression}"
        return f"{canonical_alias}{suffix}"


def _display_meta_for_kind(kind: str) -> str:
    """Return completion menu metadata for one session symbol kind.

    :param kind: Session symbol kind.
    :return: Display metadata.
    """
    if kind in {"module", "import", "function", "class", "variable"}:
        return f"session {kind}"
    return "session"


def _single_target_name(target: ast.AST) -> str | None:
    """Return a target name only for direct name assignment.

    :param target: Assignment target.
    :return: Target identifier or None.
    """
    if isinstance(target, ast.Name):
        return target.id
    return None


def _literal_dict_string_keys(node: ast.AST) -> tuple[str, ...]:
    """Return string keys from a dict literal in source order.

    :param node: AST value node.
    :return: Deduplicated string keys.
    """
    if not isinstance(node, ast.Dict):
        return ()

    keys: list[str] = []
    for key_node in node.keys:
        if isinstance(key_node, ast.Constant) and isinstance(key_node.value, str):
            keys.append(key_node.value)
    return tuple(dict.fromkeys(keys))


def _is_static_expression(node: ast.AST) -> bool:
    """Return whether an expression is useful for static completion aliasing.

    :param node: AST expression.
    :return: True when the expression is a primary expression or annotation.
    """
    if isinstance(node, ast.Name):
        return True
    if isinstance(node, ast.Attribute):
        return _is_static_expression(node.value)
    if isinstance(node, ast.Call):
        return _is_static_expression(node.func)
    if isinstance(node, ast.Subscript):
        return _is_static_expression(node.value)
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return True
    return False
