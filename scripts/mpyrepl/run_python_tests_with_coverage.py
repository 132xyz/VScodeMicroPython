"""Run mpyrepl Python tests and report local source coverage.

:return: None
"""

from __future__ import annotations

import io
import os
import sys
import trace
import unittest
from pathlib import Path


CURRENT_DIR = Path(__file__).resolve().parent
EXCLUDED_FILES = {
    "run_python_tests_with_coverage.py",
}


def target_source_files() -> list[Path]:
    """Return repository-local Python files that should appear in coverage.

    :return: Sorted list of source files.
    """
    files: list[Path] = []
    for path in CURRENT_DIR.glob("*.py"):
        if path.name.startswith("test_"):
            continue
        if path.name in EXCLUDED_FILES:
            continue
        files.append(path)
    return sorted(files)


def executable_lines(path: Path) -> set[int]:
    """Return executable line numbers for one Python file.

    :param path: Python source file.
    :return: Executable line numbers.
    """
    return set(trace._find_executable_linenos(str(path)))


def measured_lines(counts: dict[tuple[str, int], int], path: Path) -> set[int]:
    """Return executed line numbers for one traced source file.

    :param counts: Trace counts mapping.
    :param path: Python source file.
    :return: Executed line numbers.
    """
    target = os.path.abspath(path)
    return {
        line_number
        for (filename, line_number), hit_count in counts.items()
        if hit_count > 0 and os.path.abspath(filename) == target
    }


def print_coverage_summary(counts: dict[tuple[str, int], int]) -> None:
    """Print per-file and overall coverage for local mpyrepl sources.

    :param counts: Trace counts mapping.
    :return: None
    """
    total_executable = 0
    total_measured = 0

    print("Python coverage (scripts/mpyrepl local sources):")
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
            % (percent, measured_count, executable_count, path.name)
        )

    overall_percent = 100.0 if total_executable == 0 else (total_measured * 100.0 / total_executable)
    print(
        "Overall local Python coverage: %.1f%% (%d/%d executable lines)"
        % (overall_percent, total_measured, total_executable)
    )


def main() -> int:
    """Run unittest discovery under trace and print local coverage.

    :return: Process exit code.
    """
    loader = unittest.defaultTestLoader
    suite = loader.discover(str(CURRENT_DIR), pattern="test_*.py")

    stream = io.StringIO()
    runner = unittest.TextTestRunner(stream=stream, verbosity=1)
    tracer = trace.Trace(count=True, trace=False)
    result = tracer.runfunc(runner.run, suite)

    output = stream.getvalue()
    if output:
        print(output, end="")

    print_coverage_summary(tracer.results().counts)
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    sys.exit(main())