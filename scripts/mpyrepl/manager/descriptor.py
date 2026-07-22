"""Shared manager session descriptor publishing helpers.

:return: None
"""

from __future__ import annotations

import json
import os
import uuid
from dataclasses import asdict, dataclass, replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


DESCRIPTOR_SCHEMA_VERSION = 1


@dataclass(frozen=True)
class ManagerDescriptor:
    """Serializable discovery metadata for one local manager instance."""

    schemaVersion: int
    protocolVersion: int
    managerInstanceId: str
    extensionVersion: str
    device: str
    host: str
    port: int
    token: str
    managerPid: int
    scriptPath: str
    createdAt: str

    def to_dict(self) -> dict[str, Any]:
        """Return the descriptor as a JSON-compatible mapping."""
        return asdict(self)


class ManagerDescriptorPublisher:
    """Atomically publish and conditionally remove one manager descriptor."""

    def __init__(self, path: str | Path, descriptor: ManagerDescriptor) -> None:
        self._path = Path(path).expanduser().resolve()
        self._descriptor = descriptor

    @property
    def path(self) -> Path:
        return self._path

    def publish(self) -> None:
        write_descriptor(self._path, self._descriptor)

    def update_device(self, device: str) -> None:
        target = device.strip()
        if not target or target == self._descriptor.device:
            return
        self._descriptor = replace(self._descriptor, device=target)
        self.publish()

    def close(self) -> None:
        remove_descriptor(
            self._path,
            expected_token=self._descriptor.token,
            expected_instance_id=self._descriptor.managerInstanceId,
        )


def create_descriptor(
    *,
    protocol_version: int,
    manager_instance_id: str,
    owner_version: str,
    device: str,
    host: str,
    port: int,
    token: str,
    script_path: str,
) -> ManagerDescriptor:
    """Create descriptor metadata using the active process identity."""
    created_at = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    return ManagerDescriptor(
        schemaVersion=DESCRIPTOR_SCHEMA_VERSION,
        protocolVersion=protocol_version,
        managerInstanceId=manager_instance_id,
        extensionVersion=owner_version or "unknown",
        device=device,
        host=host,
        port=port,
        token=token,
        managerPid=os.getpid(),
        scriptPath=str(Path(script_path).expanduser().resolve()),
        createdAt=created_at,
    )


def write_descriptor(path: str | Path, descriptor: ManagerDescriptor) -> None:
    """Atomically write one descriptor with owner-only POSIX permissions."""
    target = Path(path).expanduser().resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name("%s.%s.%s.tmp" % (target.name, os.getpid(), uuid.uuid4().hex))
    try:
        with temporary.open("w", encoding="utf-8", newline="\n") as stream:
            json.dump(descriptor.to_dict(), stream, ensure_ascii=False, indent=2)
            stream.write("\n")
        try:
            temporary.chmod(0o600)
        except OSError:
            pass
        os.replace(temporary, target)
    finally:
        try:
            temporary.unlink()
        except OSError:
            pass


def read_descriptor(path: str | Path) -> dict[str, Any] | None:
    """Read a descriptor object, returning None for missing or invalid files."""
    try:
        payload = json.loads(Path(path).expanduser().read_text(encoding="utf-8"))
    except (FileNotFoundError, OSError, json.JSONDecodeError):
        return None
    return payload if isinstance(payload, dict) else None


def remove_descriptor(
    path: str | Path,
    *,
    expected_token: str,
    expected_instance_id: str = "",
) -> bool:
    """Remove a descriptor only when it still belongs to the expected manager."""
    target = Path(path).expanduser().resolve()
    payload = read_descriptor(target)
    if payload is None or payload.get("token") != expected_token:
        return False
    if expected_instance_id and payload.get("managerInstanceId") != expected_instance_id:
        return False
    try:
        target.unlink()
        return True
    except OSError:
        return False
