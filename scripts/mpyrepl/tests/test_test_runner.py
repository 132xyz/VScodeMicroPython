"""Exercise the watchdog in disposable processes, never the test runner itself."""

from __future__ import annotations

import os
from pathlib import Path
import subprocess
import sys
import unittest


TEST_DIR = Path(__file__).resolve().parent


class TestRunnerTests(unittest.TestCase):
    def run_child(self, source: str) -> subprocess.CompletedProcess:
        env = os.environ.copy()
        env.pop("MPY_TEST_TIMEOUT_SECONDS", None)
        env.pop("MPY_TEST_SUITE_TIMEOUT_SECONDS", None)
        return subprocess.run(
            [sys.executable, "-u", "-c", source], cwd=TEST_DIR,
            env=env, capture_output=True, text=True, timeout=10,
        )

    def run_case(self, body: str, *, test_timeout=0.3, suite_timeout=5) -> subprocess.CompletedProcess:
        return self.run_child(
            "import sys, time, unittest\n"
            "from run_with_coverage import ProgressRunner, TestWatchdog\n"
            "class Sample(unittest.TestCase):\n" + body + "\n"
            "watchdog = TestWatchdog(%r, %r)\n" % (test_timeout, suite_timeout)
            + "watchdog.arm()\n"
            "try:\n"
            "    result = ProgressRunner(watchdog, stream=sys.__stderr__, verbosity=2).run(\n"
            "        unittest.defaultTestLoader.loadTestsFromTestCase(Sample))\n"
            "finally:\n"
            "    watchdog.cancel()\n"
            "sys.exit(not result.wasSuccessful())\n"
        )

    def test_normal_run_emits_progress_and_exits_successfully(self):
        child = self.run_case("    def test_ok(self): self.assertTrue(True)")
        self.assertEqual(child.returncode, 0, child.stderr)
        self.assertIn("test_ok", child.stderr)
        self.assertIn("OK", child.stderr)

    def test_hung_body_and_teardown_exit_with_test_name_and_stack(self):
        for body in (
            "    def test_hang(self): time.sleep(30)",
            "    def test_hang(self): pass\n    def tearDown(self): time.sleep(30)",
            # IsolatedAsyncioTestCase closes its loop after stopTest as well.
            "    def test_hang(self): pass\n"
            "    def run(self, result):\n"
            "        super().run(result)\n"
            "        time.sleep(30)",
        ):
            with self.subTest(body=body):
                child = self.run_case(body)
                self.assertNotEqual(child.returncode, 0)
                self.assertIn("test_hang", child.stderr)
                self.assertIn("Timeout", child.stderr)
                self.assertIn('File "<string>"', child.stderr)

    def test_suite_budget_is_not_reset_for_each_test(self):
        child = self.run_case(
            "    def test_a(self): time.sleep(0.2)\n"
            "    def test_b(self): time.sleep(30)",
            test_timeout=5, suite_timeout=0.4,
        )
        self.assertNotEqual(child.returncode, 0)
        self.assertIn("test_b", child.stderr)
        self.assertIn("Timeout", child.stderr)

    def test_invalid_timeout_fails_before_discovery(self):
        child = self.run_child(
            "import os\n"
            "os.environ['MPY_TEST_TIMEOUT_SECONDS'] = 'nan'\n"
            "from run_with_coverage import main\n"
            "raise SystemExit(main())\n"
        )
        self.assertEqual(child.returncode, 2)
        self.assertIn("Invalid test timeout", child.stderr)
