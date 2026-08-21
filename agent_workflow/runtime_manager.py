"""Resolve and verify the user-installed Python runtime."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path


def source_root() -> Path:
    return Path(__file__).resolve().parent.parent


def find_python() -> Path:
    """Return the executable actually running the installer, after version validation."""
    if sys.version_info < (3, 11):
        raise RuntimeError("Python 3.11 or newer is required")
    return Path(sys.executable).resolve()


def verify_python(executable: Path | None = None) -> dict[str, object]:
    path = executable or find_python()
    probe = subprocess.run([str(path), "-X", "utf8", "-c", "import sys; print(sys.version_info[:3])"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, stdin=subprocess.DEVNULL, shell=False, check=False, timeout=5)
    if probe.returncode != 0:
        raise RuntimeError(f"Python executable is not runnable: {path}: {probe.stderr.decode('utf-8', 'replace').strip()}")
    return {"executable": str(path), "version": list(sys.version_info[:3])}
