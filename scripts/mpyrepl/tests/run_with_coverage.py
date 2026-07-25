"""Run mpyrepl Python tests and report package source coverage."""

from __future__ import annotations

import io
import os
import sys
import trace
import unittest
from pathlib import Path


TEST_DIR = Path(__file__).resolve().parent
PACKAGE_DIR = TEST_DIR.parent
SCRIPTS_DIR = PACKAGE_DIR.parent
MINIMUM_COVERAGE_PERCENT = 80.0

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
    stream = io.StringIO()
    runner = unittest.TextTestRunner(stream=stream, verbosity=1)
    tracer = trace.Trace(count=True, trace=False)
    result = tracer.runfunc(discover_and_run_tests, runner)

    output = stream.getvalue()
    if output:
        print(output, end="")

    overall_percent = print_coverage_summary(tracer.results().counts)
    if overall_percent < MINIMUM_COVERAGE_PERCENT:
        print(
            "Python coverage below required %.1f%%: %.1f%%"
            % (MINIMUM_COVERAGE_PERCENT, overall_percent)
        )
        return 1
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    raise SystemExit(main())
