"""Run mpyrepl Python tests and report package source coverage."""

from __future__ import annotations

import faulthandler
import math
import os
import sys
import trace
import time
import unittest
from pathlib import Path


TEST_DIR = Path(__file__).resolve().parent
PACKAGE_DIR = TEST_DIR.parent
SCRIPTS_DIR = PACKAGE_DIR.parent
MINIMUM_COVERAGE_PERCENT = 80.0


def timeout_setting(name: str, default: float) -> float:
    """Read a positive, finite test budget in seconds."""
    value = float(os.environ.get(name, default))
    if not math.isfinite(value) or value <= 0:
        raise ValueError("%s must be positive and finite" % name)
    return value


class TestWatchdog:
    """Abort even if an event loop, cleanup, or worker thread cannot progress."""

    def __init__(self, test_timeout: float, suite_timeout: float) -> None:
        self.test_timeout = test_timeout
        self.deadline = time.monotonic() + suite_timeout

    def arm(self, *, test: bool = False) -> None:
        remaining = max(0.001, self.deadline - time.monotonic())
        budget = min(remaining, self.test_timeout) if test else remaining
        # Keep diagnostics independent of tests that redirect sys.stderr.
        faulthandler.dump_traceback_later(budget, file=sys.__stderr__, exit=True)

    def cancel(self) -> None:
        faulthandler.cancel_dump_traceback_later()


class ProgressResult(unittest.TextTestResult):
    """Report each test before it starts and bound its setup/body/cleanup."""

    watchdog: TestWatchdog

    def startTest(self, test: unittest.TestCase) -> None:
        self.watchdog.arm(test=True)
        super().startTest(test)

class ProgressRunner(unittest.TextTestRunner):
    def __init__(self, watchdog: TestWatchdog, **kwargs) -> None:
        super().__init__(**kwargs)
        self.watchdog = watchdog

    def _makeResult(self) -> ProgressResult:
        result = ProgressResult(self.stream, self.descriptions, self.verbosity)
        result.watchdog = self.watchdog
        return result

if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from mpyrepl.bootstrap import configure_import_path

configure_import_path()


def target_source_files() -> list[Path]:
    """Return repository-local runtime files that should appear in coverage."""
    files: list[Path] = []
    for path in PACKAGE_DIR.rglob("*.py"):
        relative = path.relative_to(PACKAGE_DIR)
        if relative.parts[0] in {"_vendor", "tests"}:
            continue
        files.append(path)
    return sorted(files)


def executable_lines(path: Path) -> set[int]:
    """Return executable line numbers for one Python file."""
    return set(trace._find_executable_linenos(str(path)))


def measured_lines(counts: dict[tuple[str, int], int], path: Path) -> set[int]:
    """Return executed line numbers for one traced source file."""
    target = os.path.abspath(path)
    return {
        line_number
        for (filename, line_number), hit_count in counts.items()
        if hit_count > 0 and os.path.abspath(filename) == target
    }


def print_coverage_summary(counts: dict[tuple[str, int], int]) -> float:
    """Print per-file and overall coverage for local mpyrepl sources."""
    total_executable = 0
    total_measured = 0

    print("Python coverage (scripts/mpyrepl package sources):")
    for path in target_source_files():
        executable = executable_lines(path)
        measured = measured_lines(counts, path) & executable
        executable_count = len(executable)
        measured_count = len(measured)
        percent = 100.0 if executable_count == 0 else (measured_count * 100.0 / executable_count)
        total_executable += executable_count
        total_measured += measured_count
        print(
            "  %5.1f%%  %3d/%-3d  %s"
            % (
                percent,
                measured_count,
                executable_count,
                path.relative_to(PACKAGE_DIR).as_posix(),
            )
        )

    overall_percent = 100.0 if total_executable == 0 else (total_measured * 100.0 / total_executable)
    print(
        "Overall local Python coverage: %.1f%% (%d/%d executable lines)"
        % (overall_percent, total_measured, total_executable)
    )
    return overall_percent


def discover_and_run_tests(runner: unittest.TextTestRunner) -> unittest.TestResult:
    """Discover and run tests while source-module imports are being traced."""
    loader = unittest.defaultTestLoader
    suite = loader.discover(str(TEST_DIR), pattern="test_*.py")
    return runner.run(suite)


def main() -> int:
    """Run unittest discovery under trace and print local coverage."""
    try:
        test_timeout = timeout_setting("MPY_TEST_TIMEOUT_SECONDS", 60.0)
        suite_timeout = timeout_setting("MPY_TEST_SUITE_TIMEOUT_SECONDS", 300.0)
    except ValueError as exc:
        print("Invalid test timeout: %s" % exc, file=sys.__stderr__, flush=True)
        return 2
    watchdog = TestWatchdog(test_timeout, suite_timeout)
    print("Python %s; test timeout=%ss, suite timeout=%ss" % (
        sys.version.split()[0], test_timeout, suite_timeout,
    ), file=sys.__stderr__, flush=True)
    runner = ProgressRunner(watchdog, stream=sys.__stderr__, verbosity=2)
    tracer = trace.Trace(count=True, trace=False)
    watchdog.arm()
    try:
        result = tracer.runfunc(discover_and_run_tests, runner)
        watchdog.arm()
        overall_percent = print_coverage_summary(tracer.results().counts)
    finally:
        watchdog.cancel()
    if overall_percent < MINIMUM_COVERAGE_PERCENT:
        print(
            "Python coverage below required %.1f%%: %.1f%%"
            % (MINIMUM_COVERAGE_PERCENT, overall_percent)
        )
        return 1
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    raise SystemExit(main())
