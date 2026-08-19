"""Binary-stable working-tree fingerprint without PowerShell text pipelines."""

from __future__ import annotations

import argparse
import hashlib
from pathlib import Path

from .protocol import run_command, write_json


def fingerprint(path: str, base: str = "HEAD") -> dict[str, object]:
    target = Path(path).resolve()
    if not target.exists(): return {"sha256": None, "error": f"path does not exist: {path}"}
    probe = run_command(["git", "-C", str(target), "rev-parse", "--show-toplevel"])
    if probe.returncode != 0 or not probe.stdout.strip(): return {"sha256": None, "error": "not a git repository"}
    repo = Path(probe.stdout.strip()).resolve()
    base_result = run_command(["git", "-C", str(repo), "rev-parse", "--verify", f"{base}^{{commit}}"])
    if base_result.returncode != 0: return {"sha256": None, "error": f"cannot resolve base '{base}' (a repository with no commits has nothing to diff against)"}
    base_sha = base_result.stdout.strip().splitlines()[0]
    diff = run_command(["git", "-C", str(repo), "diff", "--binary", "--full-index", "--no-renames", base_sha])
    if diff.returncode != 0: return {"sha256": None, "error": f"git diff failed: {diff.stderr.strip()}"}
    # Git diff is bytes-sensitive. Re-run using a temporary binary file is unnecessary for normal
    # patches because Python's UTF-8 decode would corrupt arbitrary bytes; use git's --no-textconv
    # output through subprocess directly in this helper instead.
    import subprocess
    raw = subprocess.run(["git", "-C", str(repo), "diff", "--binary", "--full-index", "--no-renames", base_sha], stdout=subprocess.PIPE, stderr=subprocess.PIPE, stdin=subprocess.DEVNULL, shell=False, check=False, timeout=15).stdout
    others = run_command(["git", "-C", str(repo), "ls-files", "--others", "--exclude-standard"])
    if others.returncode != 0: return {"sha256": None, "error": f"git ls-files failed: {others.stderr.strip()}"}
    paths = sorted(line for line in others.stdout.splitlines() if line)
    tail = [b"\n--untracked--\n"]
    for relative in paths:
        full = repo / Path(relative)
        digest = hashlib.sha256(full.read_bytes()).hexdigest() if full.is_file() else "missing"
        tail.append(f"{relative} {digest}\n".encode("utf-8"))
    value = hashlib.sha256(raw + b"".join(tail)).hexdigest()
    return {"sha256": value, "base": base_sha, "untracked_count": len(paths)}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--path", default=".")
    parser.add_argument("--base", default="HEAD")
    args = parser.parse_args(argv)
    try: write_json(fingerprint(args.path, args.base))
    except Exception as exc: write_json({"sha256": None, "error": str(exc)})
    return 0


if __name__ == "__main__": main()
