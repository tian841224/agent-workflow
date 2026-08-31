"""Incremental coordinator/worker checks used by orchestration gates."""
from __future__ import annotations
import argparse,re
from pathlib import Path
from .frontmatter import field,frontmatter
from .protocol import write_json
def section(text,name):
    m=re.search(rf"(?ms)^## {re.escape(name)}.*?\n(.*?)(?=^## |\Z)",re.sub(r"(?s)<!--.*?-->","",text)); return m.group(1).strip() if m else ""
def check(task_path,mode="Coordinator",state_root=None):
    path=Path(task_path); issues=[]
    if not path.is_file():return {"valid":False,"issues":[f"task not found: {path}"],"mode":mode,"waiting_for":[]}
    raw=path.read_text(encoding="utf-8-sig"); data=frontmatter(raw); expected=mode.casefold()
    if data.get("subtask_role")!=expected:issues.append(f"task subtask_role is '{data.get('subtask_role','')}', expected '{expected}'")
    if mode=="Worker":
        if data.get("status")!="done":issues.append(f"worker task must be done before collection, current status is '{data.get('status','')}'")
        for name in ("Parent task","File ownership","Impact surface","Execution path and regression evidence"):
            body=section(raw,name)
            if not body or re.match(r"^<.*>$",body):issues.append(f"missing or empty section: {name}")
        review=section(raw,"Reviewer result")
        if not re.search(r"(?mi)^\s*-\s*result:\s*PASS\s*$",review):issues.append("Reviewer result is missing or not passed")
        if state_root and data.get("parent_task_id") and data.get("project_id"):
            parent=Path(state_root)/"projects"/data["project_id"] / "tasks" / data["parent_task_id"] / "task.md"
            if not parent.is_file():issues.append(f"parent_task_id '{data['parent_task_id']}' does not resolve to a task")
            elif frontmatter(parent.read_text(encoding="utf-8-sig")).get("subtask_role")!="coordinator":issues.append("parent_task_id does not point to a coordinator task")
    else:
        integration=data.get("integration_status");
        for name in ("Decomposition plan","Worker results","Delivery log","Integration verification"):
            body=section(raw,name)
            if not body or re.match(r"^<.*>$",body):issues.append(f"missing or empty section: {name}")
        if integration not in ("pending","applied"):issues.append(f"integration_status must be 'applied' before completion, current value is '{integration}'")
        if state_root and data.get("id") and data.get("project_id"):
            roster_root=Path(state_root)/"projects"/data["project_id"] / "tasks"
            pending=[]
            if roster_root.exists():
                for child in roster_root.glob("*/task.md"):
                    worker=frontmatter(child.read_text(encoding="utf-8-sig"))
                    if worker.get("parent_task_id")==data["id"] and worker.get("status") not in {"done","superseded"}:pending.append(worker.get("id",child.parent.name))
            if pending and integration!="pending":issues.append(f"{len(pending)} worker(s) are not in a terminal state")
            if pending: return {"valid":not issues,"issues":issues,"mode":mode,"waiting_for":len(pending),"note":f"waiting for {len(pending)} worker(s)"}
    return {"valid":not issues,"issues":issues,"mode":mode,"waiting_for":[]}
def main(argv=None):
    p=argparse.ArgumentParser();p.add_argument("--task-path",required=True);p.add_argument("--mode",required=True,choices=("Worker","Coordinator"));p.add_argument("--state-root",default=str(Path.home()/".agent-workflow"));a=p.parse_args(argv);write_json(check(a.task_path,a.mode,a.state_root));return 0
if __name__=="__main__":raise SystemExit(main())
