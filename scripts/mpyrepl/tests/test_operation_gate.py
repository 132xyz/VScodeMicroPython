from __future__ import annotations

import os
import sys
import threading
import unittest


SCRIPTS_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

from mpyrepl import bootstrap

bootstrap.configure_import_path()

from mpyrepl.runtime.operation_gate import SerialOperationGate


class OperationGateTests(unittest.IsolatedAsyncioTestCase):
    async def test_run_sets_current_operation_and_returns_result(self) -> None:
        gate = SerialOperationGate()

        def work():
            self.assertTrue(gate.busy)
            self.assertEqual(gate.current_operation, "work")
            return 42

        result = await gate.run("work", work)

        self.assertEqual(result, 42)
        self.assertFalse(gate.busy)
        self.assertEqual(gate.current_operation, "")

    def test_try_run_blocking_returns_none_when_busy(self) -> None:
        gate = SerialOperationGate()
        entered = threading.Event()
        release = threading.Event()

        def slow():
            entered.set()
            release.wait(timeout=2)
            return "done"

        thread = threading.Thread(target=lambda: gate.run_blocking("slow", slow))
        thread.start()
        self.assertTrue(entered.wait(timeout=1))
        try:
            self.assertIsNone(gate.try_run_blocking("other", lambda: "nope"))
        finally:
            release.set()
            thread.join(timeout=2)

        self.assertEqual(gate.try_run_blocking("fast", lambda: "ok"), "ok")
        self.assertFalse(gate.busy)

    def test_exceptions_reset_operation_state(self) -> None:
        gate = SerialOperationGate()

        def boom():
            raise RuntimeError("boom")

        with self.assertRaisesRegex(RuntimeError, "boom"):
            gate.run_blocking("boom", boom)
        self.assertEqual(gate.current_operation, "")

        with self.assertRaisesRegex(RuntimeError, "boom"):
            gate.try_run_blocking("boom", boom)
        self.assertEqual(gate.current_operation, "")


if __name__ == "__main__":
    unittest.main()
