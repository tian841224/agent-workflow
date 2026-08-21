"""Python replacement for the hook subprocess tests' encoding/deadlock boundary."""

from __future__ import annotations

import json
import sys
from pathlib import Path

try:
    from .python_harness import invoke
except ImportError:
    from python_harness import invoke


ROOT = Path(__file__).resolve().parents[1]
ENTRYPOINT = ROOT / "agent_workflow.py"


def run_hook(command: str, platform: str = "Codex") -> str:
    payload = json.dumps({"tool_input": {"command": command}, "note": "中文 UTF-8"}, ensure_ascii=False)
    result = invoke([sys.executable, "-B", "-X", "utf8", str(ENTRYPOINT), "git-guard", "--platform", platform], stdin=payload, phase="git-guard", cwd=str(ROOT))
    assert result.code == 0 and not result.stderr, result
    return result.stdout


def test_git_guard() -> None:
    assert '"deny"' in run_hook("git reset --hard HEAD")
    assert '"deny"' in run_hook("git commit -m test")
    assert not run_hook("git status --short")


def test_timeout_diagnostic() -> None:
    try:
        invoke([sys.executable, "-c", "import time; time.sleep(60)"], timeout=0.05, phase="timeout-contract", task="sample-task", cwd=str(ROOT))
    except AssertionError as error:
        text = str(error)
        assert "phase=timeout-contract" in text and "task=sample-task" in text and "cwd=" in text
    else:
        raise AssertionError("timeout helper did not time out")


def main() -> int:
    test_git_guard(); test_timeout_diagnostic()
    print("Python hook tests passed")
    return 0


if __name__ == "__main__": raise SystemExit(main())
