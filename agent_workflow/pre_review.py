"""Minimal pre-review command: deterministic diff sanity checks."""
from __future__ import annotations
import argparse, subprocess, sys
from pathlib import Path
from .protocol import run_command

def main(argv=None) -> int:
    parser=argparse.ArgumentParser(); parser.add_argument("--repo-root",default="."); parser.add_argument("--detailed",action="store_true"); args=parser.parse_args(argv)
    result=run_command(["git","-C",args.repo_root,"diff","--check"])
    print("RESULT: PASS" if result.returncode==0 else "RESULT: FAIL")
    if result.stdout.strip(): print(result.stdout.strip())
    if result.stderr.strip(): print(result.stderr.strip())
    extra=Path(args.repo_root)/".pre-review-extra.py"
    if extra.is_file():
        completed=subprocess.run([sys.executable,"-X","utf8","-u",str(extra)],cwd=args.repo_root,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=120)
        print(completed.stdout.decode("utf-8","replace"),end="")
        if completed.stderr: print(completed.stderr.decode("utf-8","replace"),file=sys.stderr,end="")
        if completed.returncode:return completed.returncode
    return 0 if result.returncode==0 else 1
