"""Small, dependency-free reader for the workflow's constrained task frontmatter."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def frontmatter(content: str) -> dict[str, Any]:
    match = re.match(r"\A---\r?\n(.*?)\r?\n---(?:\r?\n|\Z)", content, re.DOTALL)
    if not match:
        return {}
    result: dict[str, Any] = {}
    for line in match.group(1).splitlines():
        field = re.match(r"^([A-Za-z0-9_]+):[ \t]*(.*)$", line)
        if not field:
            continue
        name, raw = field.groups()
        value = raw.strip()
        if value.lower() in {"true", "false"}:
            result[name] = value.lower() == "true"
        elif value.startswith("[") and value.endswith("]"):
            result[name] = [item.strip().strip("'\"") for item in value[1:-1].split(",") if item.strip()]
        else:
            result[name] = value
    return result


def field(content: str, name: str) -> str:
    match = re.search(rf"(?m)^{re.escape(name)}:[ \t]*([^\r\n]*)", content)
    return match.group(1).strip() if match else ""
