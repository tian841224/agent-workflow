"""Persistent retrospective finding store compatible with Record/List/Resolve."""
from __future__ import annotations
import argparse,hashlib,json,re,time,uuid
from pathlib import Path
def load(root):
    path=Path(root)/"retro"/"index.json"
    if not path.exists():return path,{"schema_version":1,"entries":[]}
    try:data=json.loads(path.read_text(encoding="utf-8"))
    except Exception:raise RuntimeError(f"retro index is unreadable: {path}")
    if not isinstance(data.get("entries"),list):raise RuntimeError(f"retro index has no entries array: {path}")
    return path,data
def save(path,data):path.parent.mkdir(parents=True,exist_ok=True);data["updated_at"]=time.strftime("%Y-%m-%dT%H:%M:%S%z");path.write_text(json.dumps(data,ensure_ascii=False,indent=2)+"\n",encoding="utf-8",newline="\n")
def field(section,name):
    m=re.search(rf"(?mi)^\s*-\s*{re.escape(name)}:\s*(.+?)\s*$",section);return m.group(1).strip() if m else ""
def main(argv=None):
    p=argparse.ArgumentParser();p.add_argument("--action",required=True,choices=("Record","List","Resolve"));p.add_argument("--state-root",default=str(Path.home()/".agent-workflow"));p.add_argument("--task-path",default="");p.add_argument("--path",default=".");p.add_argument("--proposed-change",default="");p.add_argument("--id",default="");p.add_argument("--miss-category",default="");p.add_argument("--status",choices=("open","applied","rejected"));p.add_argument("--note",default="");a=p.parse_args(argv); index_path,data=load(a.state_root); entries=data["entries"]
    if a.action=="List":
        result=[x for x in entries if not a.status or x.get("status")==a.status]
        if a.miss_category:result=[x for x in result if x.get("miss_category")==a.miss_category]
        print(json.dumps(sorted(result,key=lambda x:x.get("created_at",""),reverse=True),ensure_ascii=False));return 0
    if a.action=="Resolve":
        if not a.id or a.status not in ("applied","rejected"):raise RuntimeError("Resolve needs --id and --status applied or rejected")
        entry=next((x for x in entries if x.get("id")==a.id),None); finding=Path(a.state_root)/"retro"/"findings"/(a.id+".md")
        if not entry or not finding.exists():raise RuntimeError("finding or finding file is missing")
        text=finding.read_text(encoding="utf-8-sig");text=re.sub(r"(?m)^status:.*$",f"status: {a.status}",text);text=re.sub(r"(?m)^resolved_at:.*$",f"resolved_at: {time.strftime('%Y-%m-%dT%H:%M:%S%z')}",text);text=re.sub(r"(?m)^resolution_note:.*$",f"resolution_note: {json.dumps(a.note,ensure_ascii=False)}",text);finding.write_text(text,encoding="utf-8",newline="\n");entry["status"]=a.status;save(index_path,data);print(json.dumps({"ok":True,"id":a.id,"status":a.status},ensure_ascii=False));return 0
    if not a.proposed_change:raise RuntimeError("Record needs --proposed-change")
    task=Path(a.task_path)
    if not task.exists():raise RuntimeError("Record needs an existing --task-path")
    raw=task.read_text(encoding="utf-8-sig");section=(re.search(r"(?ms)^## Retrospective result.*?\n(.*?)(?=^## |\Z)",raw) or type("M",(),{"group":lambda self,n:""})()).group(1).strip(); classification=field(section,"classification");category=field(section,"miss_category")
    if classification!="regression" or not category:raise RuntimeError("only a regression with miss_category is recorded")
    task_id=field(raw,"id") or task.stem; existing=next((x for x in entries if x.get("task_id")==task_id and x.get("miss_category")==category),None); ident=existing["id"] if existing else time.strftime("%Y%m%d-%H%M%S-")+hashlib.sha256(f"{task_id}|{category}".encode()).hexdigest()[:8]; finding=Path(a.state_root)/"retro"/"findings"/(ident+".md");finding.parent.mkdir(parents=True,exist_ok=True)
    if not existing:entries.append({"id":ident,"task_id":task_id,"miss_category":category,"classification":classification,"status":"open","created_at":time.strftime("%Y-%m-%dT%H:%M:%S%z")})
    finding.write_text(f"---\nid: {ident}\ntask_id: {task_id}\nmiss_category: {category}\nstatus: open\n---\n\n# {task_id}\n\n## Proposed framework change\n\n{a.proposed_change}\n",encoding="utf-8",newline="\n");save(index_path,data);open_count=sum(1 for x in entries if x.get("miss_category")==category and x.get("status")=="open");print(json.dumps({"ok":True,"id":ident,"occurrences":open_count,"escalate":open_count>=2},ensure_ascii=False));return 0
if __name__=="__main__":raise SystemExit(main())
