"""Shared serialization gate for raw REPL transport operations.

:return: None
"""

from __future__ import annotations

import asyncio
import threading
from typing import Callable, TypeVar


ResultT = TypeVar("ResultT")


class SerialOperationGate:
    """Serialize raw REPL protocol operations on one transport.

    :return: None
    """

    def __init__(self) -> None:
        """Initialize an idle gate.

        :return: None
        """
        self._lock = threading.Lock()
        self._current_operation = ""

    @property
    def busy(self) -> bool:
        """Return whether a serialized operation is running.

        :return: True when the transport gate is occupied.
        """
        return self._lock.locked()

    @property
    def current_operation(self) -> str:
        """Return the label of the current serialized operation.

        :return: Operation label or an empty string.
        """
        return self._current_operation

    async def run(
        self,
        operation: str,
        func: Callable[..., ResultT],
        *args,
    ) -> ResultT:
        """Run one blocking transport operation through the shared gate.

        :param operation: Human-readable operation label.
        :param func: Blocking function executed in a worker thread.
        :param args: Positional arguments forwarded to func.
        :return: Function return value.
        """
        return await asyncio.to_thread(self.run_blocking, operation, func, *args)

    def run_blocking(
        self,
        operation: str,
        func: Callable[..., ResultT],
        *args,
    ) -> ResultT:
        """Run one blocking transport operation while holding the gate.

        :param operation: Human-readable operation label.
        :param func: Blocking function.
        :param args: Positional arguments forwarded to func.
        :return: Function return value.
        """
        with self._lock:
            self._current_operation = operation
            try:
                return func(*args)
            finally:
                self._current_operation = ""

    def try_run_blocking(
        self,
        operation: str,
        func: Callable[..., ResultT],
        *args,
    ) -> ResultT | None:
        """Try to run one blocking operation without waiting for the gate.

        :param operation: Human-readable operation label.
        :param func: Blocking function.
        :param args: Positional arguments forwarded to func.
        :return: Function return value, or None when the gate is busy.
        """
        if not self._lock.acquire(blocking=False):
            return None

        self._current_operation = operation
        try:
            return func(*args)
        finally:
            self._current_operation = ""
            self._lock.release()
