"""Codex hook trust-key calculation with UTF-8 config reads."""
from __future__ import annotations
import argparse, json, re
from pathlib import Path

EVENTS={"PreToolUse":"pre_tool_use","PostToolUse":"post_tool_use","Stop":"stop","SessionStart":"session_start","SessionEnd":"session_end","UserPromptSubmit":"user_prompt_submit"}

def state_keys(path: str) -> set[str]:
    target=Path(path)
    if not target.is_file(): return set()
    text=target.read_text(encoding="utf-8-sig")
    return set(re.findall(r"(?m)^\[hooks\.state\.(?:'([^']+)'|\"([^\"]+)\")\]",text))

def untrusted(hooks_path: str, config_path: str, runtime_marker: str) -> list[str]:
    try: data=json.loads(Path(hooks_path).read_text(encoding="utf-8-sig"))
    except Exception: return []
    trusted={next((item for item in pair if item), "") for pair in state_keys(config_path)}
    missing=[]
    for event, groups in (data.get("hooks") or {}).items():
        snake=EVENTS.get(event,event.lower())
        for matcher_idx, group in enumerate(groups or []):
            for hook_idx, hook in enumerate(group.get("hooks",[]) if isinstance(group,dict) else []):
                command=str(hook.get("command", "")) if isinstance(hook,dict) else ""
                if command and runtime_marker.casefold() in command.casefold():
                    key=f"{hooks_path}:{snake}:{matcher_idx}:{hook_idx}"
                    if key not in trusted: missing.append(key)
    return missing

def main(argv=None) -> int:
    parser=argparse.ArgumentParser(); parser.add_argument("--hooks-json",required=True); parser.add_argument("--config",required=True); parser.add_argument("--runtime-marker",required=True); args=parser.parse_args(argv)
    print(json.dumps(untrusted(args.hooks_json,args.config,args.runtime_marker),ensure_ascii=False)); return 0
