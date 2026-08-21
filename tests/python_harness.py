"""Binary pipe test harness: bounded waits, UTF-8 at the process boundary, useful failures."""

from __future__ import annotations

import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence


@dataclass(frozen=True)
class ProcessResult:
    code: int
    stdout: str
    stderr: str


def invoke(argv: Sequence[str], *, stdin: str = "", timeout: float = 15, phase: str, task: str = "", cwd: str = "") -> ProcessResult:
    process = subprocess.Popen(list(argv), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, shell=False)
    try:
        stdout, stderr = process.communicate(stdin.encode("utf-8"), timeout=timeout)
    except subprocess.TimeoutExpired:
        process.kill()
        process.communicate()
        raise AssertionError(f"subprocess timed out after {timeout}s: script={argv[0]} phase={phase} task={task or '<none>'} cwd={cwd or '<none>'}")
    return ProcessResult(process.returncode, stdout.decode("utf-8", "replace"), stderr.decode("utf-8", "replace"))
