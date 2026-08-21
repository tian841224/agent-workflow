"""UTF-8 JSON and subprocess boundaries shared by every Python entrypoint."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from dataclasses import dataclass
from typing import Any, Mapping, Sequence


def read_json_stdin() -> Any:
    raw = sys.stdin.buffer.read()
    return json.loads(raw.decode("utf-8-sig"))


def write_json(value: Any) -> None:
    raw = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    stream = getattr(sys.stdout, "buffer", None)
    if stream is not None:
        stream.write(raw + b"\n")
        stream.flush()
    else:  # Useful for in-process contract tests with StringIO; hooks use the byte path above.
        sys.stdout.write(raw.decode("utf-8") + "\n")
        sys.stdout.flush()


def write_stderr(message: str) -> None:
    raw = message.encode("utf-8", errors="replace") + b"\n"
    stream = getattr(sys.stderr, "buffer", None)
    if stream is not None:
        stream.write(raw)
        stream.flush()
    else:
        sys.stderr.write(raw.decode("utf-8", errors="replace"))
        sys.stderr.flush()


@dataclass(frozen=True)
class CommandResult:
    returncode: int
    stdout: str
    stderr: str


def _decode_output(raw: bytes) -> str:
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        # Native tools on Windows can still emit the active code page. Preserve the
        # diagnostic text instead of turning an encoding mismatch into a hook crash.
        return raw.decode("utf-8", errors="replace")


def run_command(
    args: Sequence[os.PathLike[str] | str],
    *,
    cwd: os.PathLike[str] | str | None = None,
    timeout: float = 15,
    env: Mapping[str, str] | None = None,
) -> CommandResult:
    completed = subprocess.run(
        [os.fspath(arg) for arg in args],
        cwd=os.fspath(cwd) if cwd is not None else None,
        env=dict(env) if env is not None else None,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        shell=False,
        timeout=timeout,
        check=False,
    )
    return CommandResult(
        completed.returncode,
        _decode_output(completed.stdout),
        _decode_output(completed.stderr),
    )
