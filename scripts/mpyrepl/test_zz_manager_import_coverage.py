from __future__ import annotations

import importlib
import os
import sys
import unittest


CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
if CURRENT_DIR not in sys.path:
    sys.path.insert(0, CURRENT_DIR)

import bootstrap

bootstrap.configure_import_path()


class ManagerImportCoverageTests(unittest.TestCase):
    def test_reload_manager_modules_under_trace(self) -> None:
        module_names = [
            "operation_gate",
            "manager_protocol",
            "manager_session",
            "manager_server",
            "repl_client",
        ]

        modules = [importlib.import_module(name) for name in module_names]
        reloaded = [importlib.reload(module) for module in modules]

        self.assertEqual(reloaded[1].READY_MARKER, "__MPY_MANAGER_READY__")
        self.assertTrue(hasattr(reloaded[2], "ManagerSession"))
        self.assertTrue(hasattr(reloaded[3], "ManagerServer"))
        self.assertTrue(hasattr(reloaded[4], "ManagerClient"))


if __name__ == "__main__":
    unittest.main()
