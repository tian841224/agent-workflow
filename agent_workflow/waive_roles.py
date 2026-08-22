"""User-authorized role waiver writer."""
from __future__ import annotations
import argparse, re
from datetime import datetime
from pathlib import Path

def main(argv=None) -> int:
    parser=argparse.ArgumentParser(); parser.add_argument("--task-path",required=True); parser.add_argument("--reason",required=True); parser.add_argument("--confirmed-by-user",action="store_true"); args=parser.parse_args(argv)
    if not args.confirmed_by_user: print("--confirmed-by-user is required", file=__import__('sys').stderr); return 1
    target=Path(args.task_path); raw=target.read_text(encoding="utf-8")
    value=f"roles_waived: {args.reason}"
    if re.search(r"(?m)^roles_waived:",raw): updated=re.sub(r"(?m)^roles_waived:.*$",value,raw,count=1)
    else: updated=re.sub(r"(?m)^updated_at:.*$",lambda m:m.group(0)+"\n"+value,raw,count=1)
    target.write_text(updated,encoding="utf-8",newline="")
    print(f"roles waived for {target}"); return 0
