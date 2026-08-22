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


def run_skill_guard(tool_name: str, file_path: str, platform: str = "Claude") -> str:
    payload = json.dumps({"tool_name": tool_name, "tool_input": {"file_path": file_path}}, ensure_ascii=False)
    result = invoke([sys.executable, "-B", "-X", "utf8", str(ENTRYPOINT), "skill-guard", "--platform", platform], stdin=payload, phase="skill-guard", cwd=str(ROOT))
    assert result.code == 0 and not result.stderr, result
    return result.stdout


def test_skill_guard() -> None:
    claude_hit = run_skill_guard("Edit", ".agents/skills/foo/SKILL.md", "Claude")
    assert '"ask"' in claude_hit and "writing-for-agents" in claude_hit

    codex_hit = run_skill_guard("Write", ".agents/agents/reviewer.md", "Codex")
    assert '"deny"' in codex_hit and "writing-for-agents" in codex_hit

    assert not run_skill_guard("Edit", "README.md", "Claude")
    assert not run_skill_guard("Read", ".agents/skills/foo/SKILL.md", "Claude")


def test_timeout_diagnostic() -> None:
    try:
        invoke([sys.executable, "-c", "import time; time.sleep(60)"], timeout=0.05, phase="timeout-contract", task="sample-task", cwd=str(ROOT))
    except AssertionError as error:
        text = str(error)
        assert "phase=timeout-contract" in text and "task=sample-task" in text and "cwd=" in text
    else:
        raise AssertionError("timeout helper did not time out")


def main() -> int:
    test_git_guard(); test_skill_guard(); test_timeout_diagnostic()
    print("Python hook tests passed")
    return 0


if __name__ == "__main__": raise SystemExit(main())
