"""Track session symbols for host-side REPL completion.

:return: None
"""

from __future__ import annotations

import ast
from dataclasses import dataclass, field


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


@dataclass(slots=True)
class _CollectedSymbols:
    """Temporary symbol extraction result.

    :return: None
    """

    names: set[str] = field(default_factory=set)
    module_aliases: dict[str, str] = field(default_factory=dict)


class _SymbolCollector(ast.NodeVisitor):
    """Collect import, assignment, and definition names from executed source.

    :return: None
    """

    def __init__(self) -> None:
        """Initialize output containers.

        :return: None
        """
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
            self.collected.module_aliases[local_name] = module_name

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        """Collect names introduced by from-import statements.

        :param node: ImportFrom node.
        :return: None
        """
        for alias in node.names:
            if alias.name == "*":
                continue
            self.collected.names.add(alias.asname or alias.name)

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        """Collect function definitions.

        :param node: FunctionDef node.
        :return: None
        """
        self.collected.names.add(node.name)

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
        """Collect async function definitions.

        :param node: AsyncFunctionDef node.
        :return: None
        """
        self.collected.names.add(node.name)

    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        """Collect class definitions.

        :param node: ClassDef node.
        :return: None
        """
        self.collected.names.add(node.name)

    def visit_Assign(self, node: ast.Assign) -> None:
        """Collect assignment targets.

        :param node: Assign node.
        :return: None
        """
        for target in node.targets:
            self.collected.names.update(_collect_target_names(target))

    def visit_AnnAssign(self, node: ast.AnnAssign) -> None:
        """Collect annotated assignment targets.

        :param node: AnnAssign node.
        :return: None
        """
        self.collected.names.update(_collect_target_names(node.target))

    def visit_AugAssign(self, node: ast.AugAssign) -> None:
        """Collect augmented assignment targets.

        :param node: AugAssign node.
        :return: None
        """
        self.collected.names.update(_collect_target_names(node.target))

    def visit_For(self, node: ast.For) -> None:
        """Collect loop target names.

        :param node: For node.
        :return: None
        """
        self.collected.names.update(_collect_target_names(node.target))
        self.generic_visit(node)

    def visit_AsyncFor(self, node: ast.AsyncFor) -> None:
        """Collect async loop target names.

        :param node: AsyncFor node.
        :return: None
        """
        self.collected.names.update(_collect_target_names(node.target))
        self.generic_visit(node)

    def visit_With(self, node: ast.With) -> None:
        """Collect with-as target names.

        :param node: With node.
        :return: None
        """
        for item in node.items:
            if item.optional_vars is not None:
                self.collected.names.update(_collect_target_names(item.optional_vars))
        self.generic_visit(node)

    def visit_AsyncWith(self, node: ast.AsyncWith) -> None:
        """Collect async with-as target names.

        :param node: AsyncWith node.
        :return: None
        """
        for item in node.items:
            if item.optional_vars is not None:
                self.collected.names.update(_collect_target_names(item.optional_vars))
        self.generic_visit(node)

    def visit_ExceptHandler(self, node: ast.ExceptHandler) -> None:
        """Collect exception handler aliases.

        :param node: ExceptHandler node.
        :return: None
        """
        if node.name:
            self.collected.names.add(node.name)
        self.generic_visit(node)


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

    def clear(self) -> None:
        """Reset the tracked state after a session reset.

        :return: None
        """
        self._names = {"_"}
        self._module_aliases = {}

    def record_successful_source(self, source: str) -> None:
        """Update the symbol table from successfully executed user code.

        :param source: Original user source that executed without stderr.
        :return: None
        """
        try:
            tree = ast.parse(source)
        except SyntaxError:
            return

        collector = _SymbolCollector()
        collector.visit(tree)
        self._names.update(collector.collected.names)
        self._module_aliases.update(collector.collected.module_aliases)

    def bare_candidates(self) -> set[str]:
        """Return the session-introduced candidate names.

        :return: Candidate set.
        """
        return set(self._names)

    def resolve_module_alias(self, name: str) -> str | None:
        """Resolve a local import alias to its root module name.

        :param name: Local symbol.
        :return: Root module name when known.
        """
        return self._module_aliases.get(name)