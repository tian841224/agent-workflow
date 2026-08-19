"""One-time v3 knowledge/history migration with UTF-8 and staged activation."""
from __future__ import annotations
import argparse, hashlib, json, shutil, subprocess
from datetime import datetime
from pathlib import Path

def now(): return datetime.now().astimezone().isoformat()
def digest(data): return hashlib.sha256(data).hexdigest()
def text_digest(value): return digest(value.encode("utf-8"))
def write_json(path,value): path.parent.mkdir(parents=True,exist_ok=True); path.write_text(json.dumps(value,ensure_ascii=False,indent=2)+"\n",encoding="utf-8",newline="\n")
def file_digest(path): return digest(path.read_bytes())
def stable(value): return text_digest(value)[:16]
def normalized(path): return str(Path(path).resolve()).replace("\\","/").rstrip("/").casefold()
def git_project(path):
    directory=str(path if Path(path).is_dir() else Path(path).parent)
    def run(*args): return subprocess.run(["git","-C",directory,*args],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,stdin=subprocess.DEVNULL,check=False,timeout=10)
    if run("rev-parse","--is-inside-work-tree").returncode: return None
    root=run("rev-parse","--show-toplevel").stdout.decode().strip(); common=run("rev-parse","--git-common-dir").stdout.decode().strip(); remote=run("config","--get","remote.origin.url").stdout.decode().strip().casefold(); roots=run("rev-list","--max-parents=0","HEAD").stdout.decode().split(); common=str((Path(root)/common).resolve()) if not Path(common).is_absolute() else str(Path(common).resolve())
    return {"id":stable(normalized(common)+"|"+remote+"|"+",".join(sorted(roots))),"root":root,"common_dir":common,"remote":remote,"repo_fingerprint":",".join(sorted(roots)).casefold()}
def classify(path,origin):
    low=normalized(path); ext=path.suffix.casefold()
    if ext not in (".md",".txt",".json"): return {"category":"excluded","reason":"unsupported file type"}
    if any(f"/{x}/" in low for x in ("transcripts","tool-results","cache","build","dist","bin","obj")) or any(x in path.name.casefold() for x in ("credential","secret","token","cookie")): return {"category":"excluded","reason":"runtime, build, transcript, or credential data"}
    try: content=path.read_text(encoding="utf-8-sig")
    except UnicodeError: return {"category":"excluded","reason":"not valid UTF-8"}
    if any(x in content.casefold() for x in ("private key","bearer ","password:","secret:","token:","api_key:","connection_string:")): return {"category":"excluded","reason":"content appears to contain credential material"}
    if "/acceptance/" in low or path.name.casefold() in {"spec.md","checklist.md","plan.md","mini-spec.md"}:
        project=git_project(path); return {"category":"history","reason":"" if project else "project mapping required",**(project or {})}
    if origin=="global": return {"category":"global-knowledge","reason":""}
    project=git_project(path); return {"category":"project-knowledge","reason":"",**project} if project else {"category":"unresolved","reason":"legacy project slug has no verified repository mapping"}
def candidates(args):
    for root,origin in ((Path(args.claude_root)/"memory","global"),(Path(args.claude_root)/"projects","project-memory"),(Path(args.codex_root)/"memories","global")):
        if root.exists(): yield from ((p,origin) for p in root.rglob("*") if p.is_file())
    root=Path(args.repo_search_root)
    if root.exists():
        for name in ("MEMORY.md","overview.md","DECISIONS.md"):
            yield from ((p,"repository") for p in root.rglob(name) if p.is_file() and ".git" not in p.parts)
def inventory(args,run):
    seen=set(); sources=[]
    for path,origin in candidates(args):
        key=str(path.resolve()).casefold()
        if key in seen: continue
        seen.add(key); c=classify(path,origin); status="excluded" if c["category"]=="excluded" else ("unresolved" if c["category"]=="unresolved" or c.get("reason")=="project mapping required" else "pending")
        sources.append({"source_path":str(path.resolve()),"origin":origin,"category":c["category"],"project_id":c.get("id",""),"project_root":c.get("root",""),"git_common_dir":c.get("common_dir",""),"remote":c.get("remote",""),"repo_fingerprint":c.get("repo_fingerprint",""),"topic":path.stem.casefold(),"sha256":file_digest(path),"bytes":path.stat().st_size,"status":status,"reason":c.get("reason",""),"snapshot_path":"","destination":"","relationships":[]})
    manifest={"schema_version":4,"run_id":run,"created_at":now(),"updated_at":now(),"state":"inventoried","manifest_hash":"","sources":sources}; manifest["manifest_hash"]=text_digest(json.dumps(manifest,ensure_ascii=False,indent=2)); write_json(Path(args.state_root)/"imports"/run/"manifest.json",manifest); return manifest
def load(args):
    root=Path(args.state_root)/"imports"; path=root/args.run_id if args.run_id else max((p for p in root.iterdir() if (p/"manifest.json").exists()),key=lambda p:p.name,default=None)
    if path is None or not (path/"manifest.json").exists(): raise RuntimeError("No migration inventory exists. Run Inventory first.")
    return path,json.loads((path/"manifest.json").read_text(encoding="utf-8"))
def stage(path,manifest):
    stage_root=path/"stage"; snapshots=path/"source-snapshots"; stage_root.mkdir(parents=True,exist_ok=True); snapshots.mkdir(parents=True,exist_ok=True); canonical={}; topics={}
    for source in manifest["sources"]:
        if source["status"]=="excluded": continue
        origin=Path(source["source_path"]); snap=snapshots/(source["sha256"]+origin.suffix)
        if not snap.exists(): shutil.copy2(origin,snap)
        if file_digest(snap)!=source["sha256"]: raise RuntimeError(f"Snapshot hash mismatch: {snap}")
        source["snapshot_path"]=str(snap.relative_to(path))
        if source["status"]=="unresolved": continue
        if source["category"] in ("global-knowledge","project-knowledge") and source["sha256"] in canonical: source.update(status="deduplicated",destination=canonical[source["sha256"]]); continue
        if source["category"] in ("global-knowledge","project-knowledge"):
            previous=topics.get(source["topic"])
            if previous and previous["hash"]!=source["sha256"]: source["relationships"]=[("scope-conflict:" if previous["category"]!=source["category"] else "related:")+previous["hash"]]
            topics[source["topic"]]={"hash":source["sha256"],"category":source["category"]}; scope="global" if source["category"]=="global-knowledge" else "project"; rel=stage_root/("knowledge/global/entries" if scope=="global" else f"projects/{source['project_id']}/knowledge/entries")/(source["sha256"]+".md"); raw=origin.read_text(encoding="utf-8-sig"); rel.parent.mkdir(parents=True,exist_ok=True); rel.write_text(f"---\nid: {source['sha256']}\ntopic: {source['topic']}\nsource_path: {source['source_path']}\nsource_sha256: {source['sha256']}\nsnapshot: {source['snapshot_path']}\nscope: {scope}\nproject_id: {source.get('project_id','')}\norigin: imported\ncontent_sha256: {text_digest(raw.strip())}\nstatus: needs_verification\nrelationships: [{', '.join(source['relationships'])}]\ncreated_at: {now()}\nupdated_at: {now()}\nimported_at: {now()}\n---\n\n"+raw,encoding="utf-8",newline="\n"); source.update(status="imported",destination=str(rel.relative_to(stage_root))); canonical[source["sha256"]]=source["destination"]
        elif source["category"]=="history":
            target=stage_root/f"projects/{source['project_id']}/history/tasks/{stable(str(origin.parent.resolve()))}/{origin.name}"; target.parent.mkdir(parents=True,exist_ok=True); shutil.copy2(origin,target); source.update(status="imported",destination=str(target.relative_to(stage_root)))
    idx=stage_root/"knowledge/global/index.json"; idx.parent.mkdir(parents=True,exist_ok=True); write_json(idx,{"scope":"global","entries":[{"id":p.stem,"path":f"entries/{p.name}"} for p in sorted((idx.parent/"entries").glob("*.md"))]})
    for project in (stage_root/"projects").glob("*") if (stage_root/"projects").exists() else []: write_json(project/"knowledge/index.json",{"scope":"project","project_id":project.name,"entries":[]}); write_json(project/"history/index.json",{"project_id":project.name,"tasks":[]})
    manifest.update(state="staged",updated_at=now()); write_json(path/"manifest.json",manifest)
def validate(path,manifest):
    issues=[]; allowed={"imported","deduplicated","unresolved","excluded"}; stage_root=path/"stage"
    if not (stage_root/"knowledge/global/index.json").exists(): issues.append("missing global knowledge index")
    for source in manifest["sources"]:
        if source["status"] not in allowed: issues.append(f"unclassified: {source['source_path']}"); continue
        if source["status"]!="excluded" and (not (path/source["snapshot_path"]).exists() or file_digest(path/source["snapshot_path"])!=source["sha256"]): issues.append(f"snapshot mismatch: {source['source_path']}")
        if source["status"] in ("imported","deduplicated") and not (stage_root/source["destination"]).exists(): issues.append(f"missing staged entry: {source['destination']}")
    report={"run_id":manifest["run_id"],"validated_at":now(),"source_count":len(manifest["sources"]),"classified_count":sum(x["status"] in allowed for x in manifest["sources"]),"unresolved_count":sum(x["status"]=="unresolved" for x in manifest["sources"]),"manifest_hash":manifest["manifest_hash"],"success":not issues,"issues":issues}; write_json(path/"validation-report.json",report)
    if issues: raise RuntimeError("Migration validation failed: "+"; ".join(issues))
    manifest.update(state="validated",updated_at=now()); write_json(path/"manifest.json",manifest)
def activate(args,path,manifest):
    report=json.loads((path/"validation-report.json").read_text(encoding="utf-8")) if (path/"validation-report.json").exists() else None
    if manifest.get("state")!="validated" or not report or not report.get("success"): raise RuntimeError("Run Validate successfully before Activate.")
    if report["unresolved_count"] and args.accept_unresolved_manifest_hash!=report["manifest_hash"]: raise RuntimeError(f"Unresolved sources require explicit confirmation. Re-run Activate with --accept-unresolved-manifest-hash '{report['manifest_hash']}'.")
    state=Path(args.state_root); temp=state/f".activation-{manifest['run_id']}"; backup=path/"previous-active"; shutil.rmtree(temp,ignore_errors=True); temp.mkdir(parents=True); backup.mkdir(exist_ok=True)
    for name in ("knowledge","projects"):
        if (state/name).exists(): shutil.copytree(state/name,temp/name,dirs_exist_ok=True)
        if (path/"stage"/name).exists(): shutil.copytree(path/"stage"/name,temp/name,dirs_exist_ok=True)
        if (state/name).exists(): shutil.move(str(state/name),str(backup/name))
        if (temp/name).exists(): shutil.move(str(temp/name),str(state/name))
    shutil.rmtree(temp,ignore_errors=True); manifest.update(state="activated",updated_at=now()); write_json(path/"manifest.json",manifest); write_json(state/"activation.json",{"version":4,"run_id":manifest["run_id"],"manifest_hash":manifest["manifest_hash"],"activated_at":now()})
def main(argv=None):
    p=argparse.ArgumentParser(); p.add_argument("--action",required=True,choices=("Inventory","DryRun","Stage","Validate","Activate")); p.add_argument("--state-root",default=str(Path.home()/".agent-workflow")); p.add_argument("--claude-root",default=str(Path.home()/".claude")); p.add_argument("--codex-root",default=str(Path.home()/".codex")); p.add_argument("--repo-search-root",default=str(Path.home()/"Documents")); p.add_argument("--run-id",default=""); p.add_argument("--accept-unresolved-manifest-hash",default=""); args=p.parse_args(argv)
    if args.action=="Inventory": run=args.run_id or datetime.now().strftime("%Y%m%d-%H%M%S"); m=inventory(args,run); print(f"Inventory {run}: {len(m['sources'])} sources"); return 0
    path,m=load(args)
    if args.action=="DryRun": print(json.dumps({"state":m["state"],"manifest":m["manifest_hash"],"sources":len(m["sources"])},ensure_ascii=False)); return 0
    if args.action=="Stage": stage(path,m); print(f"Staged import: {m['run_id']}"); return 0
    if args.action=="Validate": validate(path,m); print(f"Validated {m['run_id']}: {len(m['sources'])} sources conserved."); return 0
    activate(args,path,m); print(f"Activated v4 data from import {m['run_id']}."); return 0
if __name__=="__main__": raise SystemExit(main())
