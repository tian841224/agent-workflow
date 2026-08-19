"""Portable orchestration lifecycle for coordinator tasks."""
from __future__ import annotations
import argparse, hashlib, json, subprocess, sys
from datetime import datetime
from pathlib import Path
from .frontmatter import field, frontmatter
from .project_resolver import resolve_project
from .split_plan import eligible

def stamp(): return datetime.now().astimezone().isoformat(timespec="seconds")
def git(repo,*args): return subprocess.run(["git","-C",str(repo),*args],stdout=subprocess.PIPE,stderr=subprocess.PIPE,stdin=subprocess.DEVNULL,shell=False,check=False,timeout=30)
def write(path,value):
    p=Path(path); p.parent.mkdir(parents=True,exist_ok=True); p.write_text(json.dumps(value,ensure_ascii=False,indent=2)+"\n",encoding="utf-8",newline="\n")
def set_field(path,values):
    import re
    p=Path(path); text=p.read_text(encoding="utf-8")
    for key,value in values.items():
        line=f"{key}: {value}"; pattern=rf"(?m)^{re.escape(key)}:[^\r\n]*"
        text=re.sub(pattern,line,text,count=1) if re.search(pattern,text) else re.sub(r"(?m)^updated_at:[^\r\n]*",lambda m:m.group(0)+"\n"+line,text,count=1)
    p.write_text(text,encoding="utf-8",newline="")
def context(path,state):
    result=resolve_project(path,state,False,[],""); active=result["active_tasks"]
    if len(active)!=1 or field(Path(active[0]).read_text(encoding="utf-8"),"subtask_role")!="coordinator": raise RuntimeError("an active coordinator task is required in the current worktree")
    task=Path(active[0]); data=frontmatter(task.read_text(encoding="utf-8")); return result,task,data["id"],task.parent
def workers(task_root,parent):
    answer=[]
    for task in Path(task_root).rglob("task.md"):
        data=frontmatter(task.read_text(encoding="utf-8"))
        if data.get("parent_task_id")==parent: answer.append((task,data))
    return answer
def init(args):
    result,coord,cid,coord_dir=context(args.path,args.state_root)
    plan=eligible(str(coord),args.plan_path)
    if not plan["eligible"]: raise RuntimeError("split plan is not eligible: "+"; ".join(plan["errors"]))
    record=coord_dir/"orchestration.json"
    if record.exists(): raise RuntimeError("orchestration already exists")
    head=git(result["root"],"rev-parse","HEAD").stdout.decode().strip(); created=[]
    for worker in plan["workers"]:
        wid=datetime.now().strftime("%Y%m%d-%H%M%S")+"-"+worker["id"]; worktree=Path(result["project_dir"])/"worktrees"/wid; worktree.parent.mkdir(parents=True,exist_ok=True)
        probe=git(result["root"],"worktree","add","--detach",str(worktree),head)
        if probe.returncode: raise RuntimeError(probe.stderr.decode("utf-8","replace"))
        wr=resolve_project(str(worktree),args.state_root,True,[],""); task=Path(result["task_root"])/wid/"task.md"; task.parent.mkdir(parents=True,exist_ok=True); ownership=worker.get("file_ownership",[])
        task.write_text(f"---\nid: {wid}\nproject_id: {result['project_id']}\nworktree_id: {wr['worktree_id']}\nstatus: in_progress\ncode_change: true\nrisk_flags: []\ncreated_at: {stamp()}\nupdated_at: {stamp()}\nsubtask_role: worker\nparent_task_id: {cid}\nbase_commit: {head}\nfile_ownership: [{', '.join(ownership)}]\ndelivery_status: pending\n---\n\n## Goal\n{worker.get('title',worker['id'])}\n\n## Scope\n{', '.join(ownership)}\n\n## Completion criteria\n- [ ] deliver worker scope\n\n## Validation results\n- pre-review: <PASS>\n\n## Reviewer result\n- result: <PASS>\n\n## Verifier result\n- PASS\n",encoding="utf-8",newline="\n")
        created.append({"id":wid,"slug":worker["id"],"worktree":str(worktree),"prefixes":ownership})
    write(record,{"coordinator_task_id":cid,"base_commit":head,"head":head,"worktree_fingerprint":"","index_fingerprint":"","created_at":stamp(),"conflicts":[]}); set_field(coord,{"integration_status":"pending","updated_at":stamp()}); print(f"initialised {len(created)} worker(s) from base {head}")
def status(args):
    result=resolve_project(args.path,args.state_root,False,[],""); print(json.dumps({"root":result["root"],"project_id":result["project_id"],"active_tasks":result["active_tasks"],"stopped_tasks":result["stopped_tasks"]},ensure_ascii=False,indent=2))

def record_for(args):
    result, coord, cid, coord_dir = context(args.path, args.state_root)
    record_path = coord_dir / "orchestration.json"
    if not record_path.is_file(): raise RuntimeError("orchestration record is missing")
    return result, coord, cid, coord_dir, json.loads(record_path.read_text(encoding="utf-8")), record_path

def worker_matches(task, data, worker_id):
    return not worker_id or data.get("id") == worker_id or task.parent.name == worker_id

def collect(args):
    result, coord, cid, coord_dir, record, record_path = record_for(args)
    base = record["base_commit"]
    deliveries = []
    for task, data in workers(result["task_root"], cid):
        if not worker_matches(task, data, args.worker_id): continue
        if data.get("status") not in ("done", "superseded"): continue
        worktree = data.get("worktree_path") or str(Path(result["project_dir"]) / "worktrees" / data["id"])
        diff = git(worktree, "diff", "--binary", "--full-index", "--no-renames", base)
        if diff.returncode: raise RuntimeError(diff.stderr.decode("utf-8", "replace"))
        payload = diff.stdout
        patch_path = task.parent / "delivery.patch"; patch_path.write_bytes(payload)
        names = git(worktree, "diff", "--name-status", "-z", base)
        changed=[]; fields=names.stdout.decode("utf-8", "replace").split("\0")
        for i in range(0, len(fields)-1, 2):
            if fields[i]: changed.append({"status": fields[i], "path": fields[i+1] if i+1 < len(fields) else ""})
        digest=hashlib.sha256(payload).hexdigest()
        delivery={"worker_id":data["id"],"patch":str(patch_path),"sha256":digest,"changed_paths":changed,"status":"pending","created_at":stamp()}
        write(task.parent / "delivery.json", delivery); deliveries.append(delivery)
        set_field(task,{"delivery_status":"pending","updated_at":stamp()})
    if not deliveries and args.worker_id: raise RuntimeError("no terminal worker matched")
    record["deliveries"]=deliveries; record["updated_at"]=stamp(); write(record_path,record)
    print(json.dumps({"deliveries":deliveries},ensure_ascii=False,indent=2))

def apply_deliveries(args, resolve=False):
    result, coord, cid, coord_dir, record, record_path = record_for(args)
    for delivery in record.get("deliveries", []):
        if not worker_matches(Path(delivery["patch"]), {"id":delivery["worker_id"]}, args.worker_id): continue
        if delivery.get("status") not in ("pending", "conflict"): continue
        patch=Path(delivery["patch"]); payload=patch.read_bytes()
        if hashlib.sha256(payload).hexdigest()!=delivery["sha256"]: raise RuntimeError(f"delivery hash mismatch: {patch}")
        if resolve and delivery.get("status")=="conflict": continue
        proc=subprocess.run(["git","-C",result["root"],"apply","--3way",str(patch)],stdout=subprocess.PIPE,stderr=subprocess.PIPE,stdin=subprocess.DEVNULL,shell=False,check=False,timeout=30)
        if proc.returncode:
            delivery["status"]="conflict"; delivery["error"]=proc.stderr.decode("utf-8","replace"); record.setdefault("conflicts",[]).append(delivery["worker_id"])
        else:
            delivery["status"]="applied"
            for task,data in workers(result["task_root"],cid):
                if data.get("id")==delivery["worker_id"]: set_field(task,{"delivery_status":"applied","updated_at":stamp()})
    record["updated_at"]=stamp(); write(record_path,record)
    if any(d.get("status")=="conflict" for d in record.get("deliveries",[])): raise RuntimeError("delivery conflicts remain")
    print(json.dumps(record,ensure_ascii=False,indent=2))

def set_delivery(args, status_value):
    result, coord, cid, coord_dir, record, record_path = record_for(args)
    matched=False
    for delivery in record.get("deliveries", []):
        if worker_matches(Path(delivery["patch"]), {"id":delivery["worker_id"]}, args.worker_id):
            delivery["status"]=status_value; matched=True
            for task,data in workers(result["task_root"],cid):
                if data.get("id")==delivery["worker_id"]: set_field(task,{"delivery_status":status_value,"updated_at":stamp()})
    if not matched: raise RuntimeError("worker delivery not found")
    record["updated_at"]=stamp(); write(record_path,record)

def cleanup(args):
    result, coord, cid, coord_dir, record, record_path = record_for(args)
    for task,data in workers(result["task_root"],cid):
        if args.worker_id and not worker_matches(task,data,args.worker_id): continue
        if data.get("status") not in ("done","superseded"): continue
        delivery=next((d for d in record.get("deliveries",[]) if d.get("worker_id")==data.get("id")),None)
        if delivery and delivery.get("status") not in ("applied","merged","skipped"): continue
        wt=Path(data.get("worktree_path") or Path(result["project_dir"])/"worktrees"/data["id"])
        git(result["root"],"worktree","remove","--force",str(wt)); delivery and delivery.update({"status":"cleaned"})
    record["updated_at"]=stamp(); write(record_path,record)
def main(argv=None):
    parser=argparse.ArgumentParser(); parser.add_argument("--action",required=True,choices=("Init","Collect","Apply","Resolve","Reject","Cleanup","Status")); parser.add_argument("--path",default="."); parser.add_argument("--state-root",default=str(Path.home()/".agent-workflow")); parser.add_argument("--plan-path",default=""); parser.add_argument("--worker-id",default=""); args=parser.parse_args(argv)
    if args.action=="Status": status(args)
    elif args.action=="Init": init(args)
    elif args.action=="Collect": collect(args)
    elif args.action=="Apply": apply_deliveries(args)
    elif args.action=="Resolve": set_delivery(args,"merged")
    elif args.action=="Reject": set_delivery(args,"rejected")
    elif args.action=="Cleanup": cleanup(args)
    return 0
if __name__=="__main__":
    try: raise SystemExit(main())
    except Exception as exc: print(str(exc),file=sys.stderr); raise SystemExit(1)
