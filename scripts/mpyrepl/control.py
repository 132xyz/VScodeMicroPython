"""File-based control channel for the async REPL spike.

:return: None
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Optional


SUPPORTED_COMMANDS = {
    "interrupt",
    "soft-reset",
    "interrupt-reset",
    "exit",
}


@dataclass(frozen=True)
class ControlRequest:
    """One control command sent by the VS Code extension.

    :param sequence: Monotonic sequence number.
    :param command: Requested action.
    :return: None
    """

    sequence: int
    command: str


class FileControlChannel:
    """Poll a JSON file for out-of-band control commands.

    :param file_path: Absolute control file path.
    :return: None
    """

    def __init__(self, file_path: str) -> None:
        """Store the control file location.

        :param file_path: Absolute control file path.
        :return: None
        """
        self._path = Path(file_path)
        self._last_sequence = -1

    def prepare(self) -> None:
        """Create the parent directory and clear stale state.

        :return: None
        """
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self.clear()

    def clear(self) -> None:
        """Remove the control file if it exists.

        :return: None
        """
        try:
            self._path.unlink()
        except FileNotFoundError:
            return

    def read_next(self) -> Optional[ControlRequest]:
        """Read the next unseen control command.

        :return: Parsed control request or None.
        """
        if not self._path.exists():
            return None

        try:
            raw_payload = self._path.read_text(encoding="utf-8")
        except OSError:
            return None

        try:
            payload = json.loads(raw_payload)
        except json.JSONDecodeError:
            return None

        if not isinstance(payload, dict):
            return None

        sequence = payload.get("sequence")
        command = payload.get("command")
        if not isinstance(sequence, int) or not isinstance(command, str):
            return None
        if sequence <= self._last_sequence:
            return None
        if command not in SUPPORTED_COMMANDS:
            self._last_sequence = sequence
            return None

        self._last_sequence = sequence
        return ControlRequest(sequence=sequence, command=command)