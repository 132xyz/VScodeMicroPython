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
    "exec",
    "fs",
}


@dataclass(frozen=True)
class ControlRequest:
    """One control command sent by the VS Code extension.

    :param sequence: Monotonic sequence number.
    :param command: Requested action.
    :param source: Python source for exec requests.
    :param label: Optional human-readable source label.
    :return: None
    """

    sequence: int
    command: str
    source: str = ""
    label: str = ""
    request_id: str = ""
    response_file: str = ""
    progress_file: str = ""
    payload: dict | None = None


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
        self._path.write_text(
            json.dumps({"sequence": 0, "command": "ready"}),
            encoding="utf-8",
        )

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

        source = payload.get("source", "")
        label = payload.get("label", "")
        request_id = payload.get("request_id", "")
        response_file = payload.get("response_file", "")
        progress_file = payload.get("progress_file", "")
        request_payload = payload.get("payload") if "payload" in payload else None
        if source is not None and not isinstance(source, str):
            self._last_sequence = sequence
            return None
        if label is not None and not isinstance(label, str):
            self._last_sequence = sequence
            return None
        if request_id is not None and not isinstance(request_id, str):
            self._last_sequence = sequence
            return None
        if response_file is not None and not isinstance(response_file, str):
            self._last_sequence = sequence
            return None
        if progress_file is not None and not isinstance(progress_file, str):
            self._last_sequence = sequence
            return None
        if request_payload is not None and not isinstance(request_payload, dict):
            self._last_sequence = sequence
            return None
        if command == "exec" and not isinstance(source, str):
            self._last_sequence = sequence
            return None
        if command == "fs" and not response_file:
            self._last_sequence = sequence
            return None

        self._last_sequence = sequence
        return ControlRequest(
            sequence=sequence,
            command=command,
            source=source or "",
            label=label or "",
            request_id=request_id or "",
            response_file=response_file or "",
            progress_file=progress_file or "",
            payload=request_payload,
        )
