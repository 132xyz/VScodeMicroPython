from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPTS_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

from mpyrepl.manager.descriptor import (
    ManagerDescriptorPublisher,
    create_descriptor,
    read_descriptor,
    remove_descriptor,
)


class ManagerDescriptorTests(unittest.TestCase):
    def test_publisher_writes_updates_and_conditionally_removes_descriptor(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / ".mpy-workbench" / "serial-manager.json"
            descriptor = create_descriptor(
                protocol_version=1,
                manager_instance_id="instance-1",
                owner_version="0.4.33",
                device="COM5",
                host="127.0.0.1",
                port=54321,
                token="secret",
                script_path=__file__,
            )
            publisher = ManagerDescriptorPublisher(path, descriptor)

            publisher.publish()
            publisher.update_device("COM7")
            payload = read_descriptor(path)

            self.assertIsNotNone(payload)
            assert payload is not None
            self.assertEqual(payload["schemaVersion"], 1)
            self.assertEqual(payload["managerInstanceId"], "instance-1")
            self.assertEqual(payload["device"], "COM7")
            self.assertEqual(payload["managerPid"], os.getpid())
            self.assertFalse(remove_descriptor(path, expected_token="wrong"))
            self.assertTrue(path.exists())
            publisher.close()
            self.assertFalse(path.exists())
            self.assertEqual(list(path.parent.glob("*.tmp")), [])

    def test_invalid_descriptor_is_not_removed(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "serial-manager.json"
            path.write_text("not-json", encoding="utf-8")

            self.assertIsNone(read_descriptor(path))
            self.assertFalse(remove_descriptor(path, expected_token="secret"))
            self.assertEqual(path.read_text(encoding="utf-8"), "not-json")

            path.write_text(json.dumps({"token": "secret", "managerInstanceId": "new"}), encoding="utf-8")
            self.assertFalse(
                remove_descriptor(
                    path,
                    expected_token="secret",
                    expected_instance_id="old",
                )
            )
            self.assertTrue(path.exists())


if __name__ == "__main__":
    unittest.main()
