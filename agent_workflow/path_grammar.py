"""Shared repository-relative ownership grammar."""
from __future__ import annotations
import re

def ownership_reason(value: str) -> str:
    if not value: return "empty entry"
    if value.startswith(("/", "\\")) or re.match(r"^[A-Za-z]:[\\/]", value): return "absolute path"
    if value.startswith(("./", "../")) or "\\" in value or "," in value or any(part == ".." for part in value.split("/")): return "invalid repository-relative path"
    return ""

def main(argv=None) -> int:
    import argparse, json
    parser = argparse.ArgumentParser(); parser.add_argument("--value", action="append", default=[])
    args = parser.parse_args(argv); print(json.dumps({"valid": not any(ownership_reason(v) for v in args.value), "errors": [f"{v}: {ownership_reason(v)}" for v in args.value if ownership_reason(v)]}, ensure_ascii=False)); return 0
