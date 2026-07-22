"""Stable script and module entry point for mpyrepl."""

from __future__ import annotations

import os
import sys


PACKAGE_DIR = os.path.dirname(os.path.abspath(__file__))
SCRIPTS_DIR = os.path.dirname(PACKAGE_DIR)
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

from mpyrepl.bootstrap import configure_import_path

configure_import_path()


def _run() -> int:
    # Keep one-shot Agent commands independent from prompt_toolkit and the serial stack.
    if len(sys.argv) > 1 and sys.argv[1] == "agent":
        from mpyrepl.clients.agent import main as run_agent_main

        return run_agent_main(sys.argv[2:])

    from mpyrepl.app import main

    return main()


if __name__ == "__main__":
    raise SystemExit(_run())
