"""Prompt-toolkit completer for the custom REPL.

:return: None
"""

from __future__ import annotations

import builtins as py_builtins
import inspect
import keyword
import time
from dataclasses import dataclass
from typing import Callable, Iterable

from prompt_toolkit.completion import Completer, Completion
from prompt_toolkit.document import Document

from completion_parser import (
    CompletionRequest,
    cursor_in_string_or_comment,
    has_unterminated_string_or_comment,
    parse_completion_request,
)
from completion_fallbacks import fallback_candidates_for_expression
from completion_state import ReplSessionSymbols
from completion_stubs import StubCompletionIndex


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
NEGATIVE_CACHE_TTL_SECONDS = 2.0
AUTO_DEVICE_QUERY_TIMEOUT_SECONDS = 0.35
UNCOMMON_NAME_RANK = 1000
SOURCE_PRIORITY = {
    "meta": 0,
    "session": 0,
    "session variable": 0,
    "session function": 0,
    "session class": 0,
    "session module": 1,
    "session import": 1,
    "stub class": 2,
    "stub function": 2,
    "stub attribute": 2,
    "stub import": 2,
    "stub parameter": 2,
    "module": 3,
    "stub module": 3,
    "keyword": 4,
    "fallback class": 4,
    "fallback enum": 4,
    "fallback function": 4,
    "fallback attribute": 4,
    "builtin": 5,
    "session key": 5,
    "device": 6,
}
COMMON_BARE_NAME_RANK = {
    "machine": 0,
    "time": 1,
    "os": 2,
    "sys": 3,
    "gc": 4,
    "lvgl": 5,
    "print": 20,
    "len": 21,
    "range": 22,
}
COMMON_DOTTED_NAME_RANK = {
    "Pin": 0,
    "PWM": 1,
    "UART": 2,
    "I2C": 3,
    "SPI": 4,
    "ADC": 5,
    "Timer": 6,
    "sleep_ms": 20,
    "sleep_us": 21,
    "ticks_ms": 22,
    "ticks_us": 23,
    "ticks_diff": 24,
    "obj": 40,
    "label": 41,
    "btn": 42,
    "arc": 43,
    "align": 44,
    "set_text": 45,
    "set_style_text_color": 46,
}


@dataclass(frozen=True, slots=True)
class RuntimeCacheEntry:
    """Cached runtime completion candidates.

    :return: None
    """

    candidates: list[str]
    expires_at: float | None = None


def discover_stub_modules(stub_root: str | None) -> set[str]:
    """Return top-level module names exposed by one stub root.

    :param stub_root: Root directory containing MicroPython stubs.
    :return: Discovered top-level module names.
    """
    return StubCompletionIndex(stub_root).module_names()


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


class ReplCompleter(Completer):
    """Serve local and optional device-backed completions for the custom REPL.

    :return: None
    """

    def __init__(
        self,
        session_symbols: ReplSessionSymbols,
        stub_root: str | None = None,
        dotted_provider: Callable[..., Iterable[str]] | None = None,
        clock: Callable[[], float] = time.monotonic,
        auto_device_timeout: float | None = AUTO_DEVICE_QUERY_TIMEOUT_SECONDS,
        manual_device_timeout: float | None = None,
    ) -> None:
        """Initialize completion sources.

        :param session_symbols: Mutable session symbol table.
        :param stub_root: Optional stub root for top-level modules.
        :param dotted_provider: Optional provider for dotted member lookups.
        :param clock: Monotonic clock used for short negative-cache expiry.
        :param auto_device_timeout: Timeout for automatic device queries.
        :param manual_device_timeout: Timeout for explicit completion requests.
        :return: None
        """
        self._session_symbols = session_symbols
        self._stub_index = StubCompletionIndex(stub_root)
        self._stub_modules = self._stub_index.module_names()
        self._dotted_provider = dotted_provider
        self._dotted_provider_accepts_timeout = _accepts_timeout_argument(dotted_provider)
        self._runtime_cache: dict[str, RuntimeCacheEntry] = {}
        self._clock = clock
        self._auto_device_timeout = auto_device_timeout
        self._manual_device_timeout = manual_device_timeout

    def has_completion_target(self, document: Document) -> bool:
        """Return whether completion should be attempted at the cursor.

        :param document: Prompt document.
        :return: True when completion parsing succeeds.
        """
        return parse_completion_request(document) is not None

    def clear_runtime_cache(self) -> None:
        """Clear all cached runtime data.

        :return: None
        """
        self._runtime_cache.clear()

    def stub_modules(self) -> set[str]:
        """Return top-level stub module names used by this completer.

        :return: Stub module names.
        """
        return set(self._stub_modules)

    def invalidate_runtime_cache(
        self,
        rebound_roots: Iterable[str] = (),
        mutated_roots: Iterable[str] = (),
        clear_all: bool = False,
    ) -> None:
        """Invalidate cache entries affected by one executed code block.

        :param rebound_roots: Local names whose binding changed.
        :param mutated_roots: Root objects whose members may have changed.
        :param clear_all: Whether to clear all runtime entries.
        :return: None
        """
        if clear_all:
            self.clear_runtime_cache()
            return

        keys_to_remove: set[str] = set()
        for root in rebound_roots:
            keys_to_remove.update(self._matching_cache_keys_for_root(f"expr:{root}"))

        for root in mutated_roots:
            keys_to_remove.update(self._matching_cache_keys_for_root(f"expr:{root}"))
            keys_to_remove.update(
                self._matching_cache_keys_for_root(
                    self._session_symbols.canonical_cache_key(root)
                )
            )

        for key in keys_to_remove:
            self._runtime_cache.pop(key, None)

    def _matching_cache_keys_for_root(self, expression_key: str) -> set[str]:
        """Return cache keys for one expression key and its dotted children.

        :param expression_key: Canonical or local expression cache key.
        :return: Matching cache keys.
        """
        return {
            key
            for key in self._runtime_cache
            if key == expression_key
            or (
                key.startswith(expression_key)
                and len(key) > len(expression_key)
                and key[len(expression_key)] in ".(["
            )
        }

    def get_completions(self, document: Document, complete_event):
        """Yield completions for the current cursor location.

        :param document: Prompt document.
        :param complete_event: Prompt-toolkit completion event.
        :return: Iterator of Completion values.
        """
        request = parse_completion_request(document)
        if request is None:
            return

        preserve_candidate_order = False
        if request.kind == "dotted":
            candidate_meta = self._dotted_candidates(request, complete_event)
        elif request.kind == "from_import":
            candidate_meta = self._from_import_candidates(request, complete_event)
        elif request.kind == "call_keyword":
            candidate_meta = self._call_keyword_candidates(request)
            preserve_candidate_order = bool(candidate_meta)
        elif request.kind == "dict_key":
            candidate_meta = self._dict_key_candidates(request)
            preserve_candidate_order = True
        else:
            candidate_meta = self._bare_candidates(request)

        prefix = request.prefix
        start_position = -len(prefix)
        if preserve_candidate_order:
            candidates = _prefix_filtered_candidates(candidate_meta, prefix)
        else:
            candidates = _ranked_candidates(candidate_meta, prefix, request.kind)

        for candidate in candidates:
            yield Completion(
                candidate,
                start_position=start_position,
                display=_candidate_display(candidate, request),
                display_meta=candidate_meta.get(candidate, ""),
            )

    def _dotted_candidates(
        self,
        request: CompletionRequest,
        complete_event,
    ) -> dict[str, str]:
        """Return dotted candidates from stubs and optional device lookup.

        :param request: Parsed completion request.
        :param complete_event: Prompt-toolkit completion event.
        :return: Candidate names mapped to display metadata.
        """
        stub_candidates = self._stub_index.candidates_for_expression(
            request.expression,
            self._session_symbols,
        )
        fallback_candidates = fallback_candidates_for_expression(
            request.expression,
            self._session_symbols,
        )
        local_candidates = dict(stub_candidates)
        for candidate, display_meta in fallback_candidates.items():
            local_candidates.setdefault(candidate, display_meta)

        cached_device_candidates = self._cached_device_candidates(request)
        if cached_device_candidates:
            return _with_device_candidates(local_candidates, cached_device_candidates)

        completion_requested = _completion_requested(complete_event)
        if stub_candidates:
            has_stub_prefix_match = any(name.startswith(request.prefix) for name in stub_candidates)
            if has_stub_prefix_match or not completion_requested:
                return local_candidates

        if fallback_candidates and not completion_requested:
            has_fallback_prefix_match = any(
                name.startswith(request.prefix)
                for name in fallback_candidates
            )
            if has_fallback_prefix_match or not request.prefix:
                return local_candidates

        device_candidates = self._device_candidates(request, completion_requested)
        return _with_device_candidates(local_candidates, device_candidates)

    def _from_import_candidates(
        self,
        request: CompletionRequest,
        complete_event,
    ) -> dict[str, str]:
        """Return importable module members for a from-import statement.

        :param request: Parsed from-import request.
        :param complete_event: Prompt-toolkit completion event.
        :return: Candidate names mapped to display metadata.
        """
        stub_candidates = {
            name: display_meta
            for name, display_meta in self._stub_index.candidates_for_expression(
                request.expression,
                self._session_symbols,
            ).items()
            if name not in request.used_keywords
        }
        fallback_candidates = {
            name: display_meta
            for name, display_meta in fallback_candidates_for_expression(
                request.expression,
                self._session_symbols,
            ).items()
            if name not in request.used_keywords
        }
        local_candidates = dict(stub_candidates)
        for candidate, display_meta in fallback_candidates.items():
            local_candidates.setdefault(candidate, display_meta)

        cached_device_candidates = self._cached_device_candidates(request)
        if cached_device_candidates:
            return _with_device_candidates(
                local_candidates,
                (
                    candidate
                    for candidate in cached_device_candidates
                    if candidate not in request.used_keywords
                ),
            )

        completion_requested = _completion_requested(complete_event)
        if stub_candidates:
            has_stub_prefix_match = any(name.startswith(request.prefix) for name in stub_candidates)
            if has_stub_prefix_match or not completion_requested:
                return local_candidates

        if fallback_candidates and not completion_requested:
            has_fallback_prefix_match = any(
                name.startswith(request.prefix)
                for name in fallback_candidates
            )
            if has_fallback_prefix_match or not request.prefix:
                return local_candidates

        device_candidates = self._device_candidates(request, completion_requested)
        return _with_device_candidates(
            local_candidates,
            (
                candidate
                for candidate in device_candidates
                if candidate not in request.used_keywords
            ),
        )

    def _call_keyword_candidates(self, request: CompletionRequest) -> dict[str, str]:
        """Return keyword parameter completions for a call context.

        :param request: Parsed call keyword request.
        :return: Candidate names mapped to display metadata.
        """
        candidates = self._stub_index.parameter_candidates_for_call(
            request.expression,
            request.used_keywords,
            self._session_symbols,
        )
        if candidates or not request.prefix:
            return candidates
        return self._bare_candidates(request)

    def _dict_key_candidates(self, request: CompletionRequest) -> dict[str, str]:
        """Return known session dict key completions.

        :param request: Parsed dict key request.
        :return: Candidate insertion text mapped to display metadata.
        """
        quote = request.insert_suffix[:1]
        candidates: dict[str, str] = {}
        for key in self._session_symbols.dict_key_candidates(request.expression):
            if quote and (quote in key or "\\" in key):
                continue
            candidates[f"{key}{request.insert_suffix}"] = "session key"
        return candidates

    def _device_candidates(
        self,
        request: CompletionRequest,
        completion_requested: bool = False,
    ) -> list[str]:
        """Return cached device-backed candidates for one dotted request.

        :param request: Parsed completion request.
        :param completion_requested: Whether completion was explicitly requested.
        :return: Device candidate names.
        """
        if self._dotted_provider is None:
            return []

        cache_key = self._session_symbols.canonical_cache_key(request.expression)
        entry = self._runtime_cache.get(cache_key)
        now = self._clock()
        should_query = entry is None or (
            entry.expires_at is not None
            and (entry.expires_at <= now or completion_requested)
        )
        if should_query:
            timeout = (
                self._manual_device_timeout
                if completion_requested
                else self._auto_device_timeout
            )
            candidates = sorted(
                dict.fromkeys(
                    self._query_dotted_provider(
                        request.expression,
                        request.prefix,
                        timeout,
                    )
                )
            )
            expires_at = now + NEGATIVE_CACHE_TTL_SECONDS if not candidates else None
            self._runtime_cache[cache_key] = RuntimeCacheEntry(candidates, expires_at)
            return candidates
        return entry.candidates

    def _cached_device_candidates(self, request: CompletionRequest) -> list[str]:
        """Return unexpired cached device candidates without querying.

        :param request: Parsed completion request.
        :return: Cached device candidates, or an empty list.
        """
        if self._dotted_provider is None:
            return []

        entry = self._runtime_cache.get(self._session_symbols.canonical_cache_key(request.expression))
        if entry is None or not entry.candidates:
            return []

        if entry.expires_at is not None and entry.expires_at <= self._clock():
            return []

        return entry.candidates

    def _query_dotted_provider(
        self,
        expression: str,
        prefix: str,
        timeout: float | None,
    ) -> Iterable[str]:
        """Call the dotted provider with timeout when supported.

        :param expression: Dotted expression before the final prefix.
        :param prefix: Final attribute prefix.
        :param timeout: Device query timeout for this completion request.
        :return: Provider candidates.
        """
        if self._dotted_provider is None:
            return []
        if self._dotted_provider_accepts_timeout:
            return self._dotted_provider(expression, prefix, timeout)
        return self._dotted_provider(expression, prefix)

    def _bare_candidates(self, request: CompletionRequest) -> dict[str, str]:
        """Return local completion candidates for bare or meta prefixes.

        :param request: Parsed completion request.
        :return: Candidate names mapped to display metadata.
        """
        if request.kind == "meta":
            return {name: "meta" for name in META_COMMANDS}

        candidates: dict[str, str] = {}
        self._add_candidate_meta(candidates, self._session_symbols.bare_candidate_meta())
        self._add_candidates(candidates, keyword.kwlist, "keyword")
        self._add_candidates(candidates, BUILTIN_CANDIDATES, "builtin")
        self._add_candidates(candidates, DEFAULT_CORE_MODULES, "module")
        self._add_candidates(candidates, self._stub_modules, "stub module")
        return candidates

    def _add_candidates(
        self,
        candidates: dict[str, str],
        names: Iterable[str],
        display_meta: str,
    ) -> None:
        """Add candidates without overwriting earlier source metadata.

        :param candidates: Mutable candidate metadata map.
        :param names: Candidate names.
        :param display_meta: Source/type label for the completion menu.
        :return: None
        """
        for name in names:
            candidates.setdefault(name, display_meta)

    def _add_candidate_meta(
        self,
        candidates: dict[str, str],
        candidate_meta: dict[str, str],
    ) -> None:
        """Add candidate metadata without overwriting earlier source labels.

        :param candidates: Mutable candidate metadata map.
        :param candidate_meta: Candidate names mapped to display metadata.
        :return: None
        """
        for name, display_meta in candidate_meta.items():
            candidates.setdefault(name, display_meta)


def _completion_requested(complete_event) -> bool:
    """Return whether completion was explicitly requested.

    :param complete_event: Prompt-toolkit completion event.
    :return: True for explicit completion requests such as Tab.
    """
    return bool(getattr(complete_event, "completion_requested", False))


def _with_device_candidates(
    candidate_meta: dict[str, str],
    device_candidates: Iterable[str],
) -> dict[str, str]:
    """Return candidate metadata with device candidates appended.

    :param candidate_meta: Existing candidate metadata.
    :param device_candidates: Device-backed candidate names.
    :return: Combined candidate metadata.
    """
    combined = dict(candidate_meta)
    for candidate in device_candidates:
        combined.setdefault(candidate, "device")
    return combined


def _accepts_timeout_argument(provider: Callable[..., Iterable[str]] | None) -> bool:
    """Return whether a dotted provider accepts a timeout argument.

    :param provider: Dotted completion provider.
    :return: True when a third positional timeout argument can be passed.
    """
    if provider is None:
        return False
    try:
        signature = inspect.signature(provider)
    except (TypeError, ValueError):
        return False

    positional_count = 0
    for parameter in signature.parameters.values():
        if parameter.kind == inspect.Parameter.VAR_POSITIONAL:
            return True
        if parameter.kind in {
            inspect.Parameter.POSITIONAL_ONLY,
            inspect.Parameter.POSITIONAL_OR_KEYWORD,
        }:
            positional_count += 1
    return positional_count >= 3


def _ranked_candidates(
    candidate_meta: dict[str, str],
    prefix: str,
    request_kind: str,
) -> list[str]:
    """Return candidates filtered by prefix and sorted for menu usefulness.

    :param candidate_meta: Candidate names mapped to display metadata.
    :param prefix: Already typed candidate prefix.
    :param request_kind: Parsed completion request kind.
    :return: Ranked candidate names.
    """
    return sorted(
        (name for name in candidate_meta if name.startswith(prefix)),
        key=lambda name: _candidate_sort_key(
            name,
            prefix,
            candidate_meta.get(name, ""),
            request_kind,
        ),
    )


def _prefix_filtered_candidates(candidate_meta: dict[str, str], prefix: str) -> list[str]:
    """Return candidates matching a prefix while preserving source order.

    :param candidate_meta: Candidate names mapped to display metadata.
    :param prefix: Already typed candidate prefix.
    :return: Matching candidate names.
    """
    return [name for name in candidate_meta if name.startswith(prefix)]


def _candidate_display(candidate: str, request: CompletionRequest) -> str:
    """Return concise display text for one insertion candidate.

    :param candidate: Completion insertion text.
    :param request: Parsed completion request.
    :return: Display text for the menu.
    """
    if (
        request.kind == "dict_key"
        and request.insert_suffix
        and candidate.endswith(request.insert_suffix)
    ):
        return candidate[: -len(request.insert_suffix)]
    return candidate


def _candidate_sort_key(
    name: str,
    prefix: str,
    display_meta: str,
    request_kind: str,
) -> tuple[int, int, int, int, str, str]:
    """Return a stable menu ranking key for one completion candidate.

    :param name: Candidate name.
    :param prefix: Already typed prefix.
    :param display_meta: Candidate source/type label.
    :param request_kind: Parsed completion request kind.
    :return: Sort key.
    """
    exact_rank = 0 if prefix and name == prefix else 1
    return (
        exact_rank,
        _privacy_rank(name),
        _source_priority(display_meta),
        _common_name_rank(name, request_kind),
        name.casefold(),
        name,
    )


def _source_priority(display_meta: str) -> int:
    """Return source priority for exact or detail-bearing metadata.

    :param display_meta: Candidate source/type label.
    :return: Source priority rank.
    """
    if display_meta in SOURCE_PRIORITY:
        return SOURCE_PRIORITY[display_meta]

    for source_label in sorted(SOURCE_PRIORITY, key=len, reverse=True):
        if display_meta.startswith(f"{source_label} "):
            return SOURCE_PRIORITY[source_label]

    return UNCOMMON_NAME_RANK


def _privacy_rank(name: str) -> int:
    """Return whether a candidate is public, private, or dunder-style.

    :param name: Candidate name.
    :return: Privacy sort rank.
    """
    if name.startswith("__"):
        return 2
    if name.startswith("_"):
        return 1
    return 0


def _common_name_rank(name: str, request_kind: str) -> int:
    """Return a small rank for common MicroPython names.

    :param name: Candidate name.
    :param request_kind: Parsed completion request kind.
    :return: Common-name rank, or a large fallback rank.
    """
    if request_kind in {"dotted", "from_import"}:
        return COMMON_DOTTED_NAME_RANK.get(name, UNCOMMON_NAME_RANK)
    return COMMON_BARE_NAME_RANK.get(name, UNCOMMON_NAME_RANK)
