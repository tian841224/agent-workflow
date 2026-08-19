"""Cheap, deterministic split-plan eligibility validator."""
from __future__ import annotations
import argparse, json
from pathlib import Path
from .path_grammar import ownership_reason
from .protocol import write_json

def eligible(task_path: str, plan_path: str) -> dict:
    errors=[]
    try: plan=json.loads(Path(plan_path).read_text(encoding="utf-8"))
    except Exception as exc: return {"eligible":False,"errors":[f"plan is unreadable: {exc}"],"workers":[]}
    if not plan.get("user_confirmed"): errors.append("user_confirmed must be true")
    if plan.get("shared_persistent_state"): errors.append("shared persistent state is not eligible")
    if plan.get("has_order_dependency"): errors.append("ordering dependency is not eligible")
    workers=plan.get("workers",[])
    if len(workers)<2: errors.append("at least two workers are required")
    ids=set(); paths=[]
    for worker in workers:
        ident=str(worker.get("id",""))
        if ident != ident.lower() or not ident.replace("-","").isalnum(): errors.append(f"invalid worker id: {ident}")
        if ident in ids: errors.append(f"duplicated worker id: {ident}")
        ids.add(ident)
        if int(worker.get("estimated_units",0))<2: errors.append("minimum split size is 2 units")
        for path in worker.get("file_ownership",[]):
            if ownership_reason(str(path)): errors.append(f"invalid ownership: {path}")
            for previous in paths:
                if str(path).rstrip("/") == previous.rstrip("/") or str(path).startswith(previous) or previous.startswith(str(path)): errors.append(f"ownership overlaps: {path} and {previous}")
            paths.append(str(path))
    return {"eligible":not errors,"errors":errors,"workers":workers}

def main(argv=None) -> int:
    parser=argparse.ArgumentParser(); parser.add_argument("--coordinator-task-path",required=True); parser.add_argument("--plan-path",required=True)
    args=parser.parse_args(argv); write_json(eligible(args.coordinator_task_path,args.plan_path)); return 0
