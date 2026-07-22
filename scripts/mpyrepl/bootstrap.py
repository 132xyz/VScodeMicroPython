"""Bootstrap helpers for standalone script execution.

:return: None
"""

from __future__ import annotations

import os
import sys


def configure_import_path() -> None:
    """Add the package parent and optional vendor directory to sys.path.

    :return: None
    """
    package_dir = os.path.dirname(os.path.abspath(__file__))
    scripts_dir = os.path.dirname(package_dir)
    vendor_dir = os.path.join(package_dir, "_vendor")

    if scripts_dir not in sys.path:
        sys.path.insert(0, scripts_dir)

    if os.path.isdir(vendor_dir) and vendor_dir not in sys.path:
        # Vendored dependencies must win over user-installed packages.
        sys.path.insert(0, vendor_dir)
