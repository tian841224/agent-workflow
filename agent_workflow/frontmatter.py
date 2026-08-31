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


BLOCK = re.compile(r"\A---\r?\n(.*?)\r?\n---(?:\r?\n|\Z)", re.DOTALL)
FIELD_LINE = re.compile(r"(?m)^[A-Za-z0-9_]+:[ \t]")


def body(content: str) -> str:
    """Content with its own leading frontmatter block removed."""
    return BLOCK.sub("", content, count=1)


def set_field(content: str, name: str, value: str) -> str:
    """Set one frontmatter field, appending it at the end of the block if absent.

    Scoped to the leading block on purpose: an entry body can hold its own
    `key: value` lines, and a whole-file substitution would rewrite those instead.
    """
    match = BLOCK.match(content)
    if not match:
        raise RuntimeError("cannot set a field on content without frontmatter")
    fields = match.group(1)
    line = f"{name}: {value}"
    replaced, count = re.subn(rf"(?m)^{re.escape(name)}:.*$", lambda _: line, fields, count=1)
    if not count:
        replaced = fields + "\n" + line
    return content[:match.start(1)] + replaced + content[match.end(1):]


def summary_line(content: str, limit: int) -> str:
    """The entry's first real line, past every frontmatter block wrapping it.

    An entry captured from another store carries the source file's own frontmatter
    inside its body, so stripping only the outer block yields `---` as the summary.
    A nested block is only skipped when it actually holds `key: value` lines, so a
    body that opens with a horizontal rule keeps its first line.
    """
    text = body(content).lstrip()
    for _ in range(2):
        match = BLOCK.match(text)
        if not match or not FIELD_LINE.search(match.group(1)):
            break
        text = text[match.end():].lstrip()
    for line in text.splitlines():
        stripped = line.strip()
        if stripped:
            return stripped[:limit]
    return ""
