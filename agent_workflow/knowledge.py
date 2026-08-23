"""Small dependency-free UTF-8 knowledge store."""
from __future__ import annotations
import argparse, hashlib, json, re, time
from pathlib import Path
from .frontmatter import frontmatter


def entries(root):
    for base in (Path(root) / "knowledge" / "global", Path(root) / "projects"):
        if base.exists():
            yield from base.rglob("*.md")


def _under(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def _filter_entries(root: str, scope: str, project_id: str, topic: str, status: str, path_filter: str,
                    exclude_native: bool, include_session_summaries: bool) -> list[Path]:
    state = Path(root).resolve()
    global_root = state / "knowledge" / "global"
    project_root = state / "projects"
    found = list(entries(state))
    if scope == "Global":
        found = [path for path in found if _under(path, global_root)]
    elif scope == "Project":
        found = [path for path in found if _under(path, project_root)]
        if project_id:
            found = [path for path in found if _under(path, project_root / project_id)]
    if path_filter and path_filter != ".":
        needle = path_filter.casefold().replace("\\", "/")
        found = [path for path in found if needle in str(path).casefold().replace("\\", "/")]
    result = []
    for path in found:
        metadata = frontmatter(path.read_text(encoding="utf-8-sig", errors="replace"))
        if topic and topic.casefold() not in str(metadata.get("topic", "")).casefold():
            continue
        if status and str(metadata.get("status", "")).casefold() != status.casefold():
            continue
        if exclude_native and str(metadata.get("origin", "")).casefold() == "native":
            continue
        if not include_session_summaries and "session_summaries" in str(path).casefold().replace("\\", "/"):
            continue
        result.append(path)
    return result


def _index_path(state_root: str, scope: str, project_id: str) -> Path:
    state = Path(state_root)
    if scope == "Global":
        return state / "knowledge" / "global" / "index.json"
    if scope == "Project" and project_id:
        return state / "projects" / project_id / "knowledge" / "index.json"
    if scope == "Project":
        return state / "projects" / "index.json"
    return state / "knowledge" / "index.json"


def main(argv=None) -> int:
    parser=argparse.ArgumentParser(); parser.add_argument("--action",required=True,choices=("Search","Upsert","Reindex","List")); parser.add_argument("--state-root",default=str(Path.home()/".agent-workflow")); parser.add_argument("--query",default=""); parser.add_argument("--limit",type=int,default=8); parser.add_argument("--scope",default="All",choices=("All","Global","Project")); parser.add_argument("--topic",default=""); parser.add_argument("--content",default=""); parser.add_argument("--project-id",default=""); parser.add_argument("--path",default="."); parser.add_argument("--status",default="verified",choices=("verified","needs_verification")); parser.add_argument("--relationship",action="append",default=[]); parser.add_argument("--approved-by-user",action="store_true"); parser.add_argument("--exclude-native",action="store_true"); parser.add_argument("--include-session-summaries",action="store_true"); args=parser.parse_args(argv)
    found=_filter_entries(args.state_root, args.scope, args.project_id, args.topic, args.status, args.path, args.exclude_native, args.include_session_summaries)
    if args.action=="Search":
        terms=args.query.casefold().split(); out=[]
        for path in found:
            text=path.read_text(encoding="utf-8-sig",errors="replace")
            if terms and not all(term in text.casefold() for term in terms): continue
            body=re.sub(r"\A---\r?\n.*?\r?\n---(?:\r?\n|\Z)","",text,count=1,flags=re.DOTALL)
            excerpt=next((line.strip() for line in body.splitlines() if line.strip()),"")[:180]
            out.append({"path":str(path),"topic":frontmatter(text).get("topic",path.stem),"excerpt":excerpt})
        print(json.dumps(out[:args.limit],ensure_ascii=False)); return 0
    if args.action=="List": print(json.dumps([str(p) for p in found],ensure_ascii=False)); return 0
    if args.action=="Reindex":
        index=_index_path(args.state_root, args.scope, args.project_id); index.parent.mkdir(parents=True,exist_ok=True); index.write_text(json.dumps({"scope":args.scope.casefold(),"entries":[{"id":p.stem,"path":str(p)} for p in found]},ensure_ascii=False,indent=2)+"\n",encoding="utf-8",newline="\n"); print("reindex complete"); return 0
    if not args.topic or not args.content: raise RuntimeError("Upsert requires --topic and --content")
    if args.scope=="Global" and not args.approved_by_user: raise RuntimeError("Global Upsert requires --approved-by-user")
    content=args.content.strip(); digest=hashlib.sha256(content.encode("utf-8")).hexdigest(); scope="global" if args.scope.casefold()=="global" else "project"; project=args.project_id or "default"; base=Path(args.state_root)/"knowledge"/"global"/"entries" if scope=="global" else Path(args.state_root)/"projects"/project/"knowledge"/"entries"; base.mkdir(parents=True,exist_ok=True); name=re.sub(r"[^a-zA-Z0-9._-]+","-",args.topic).strip("-") or "entry"; path=base/(name+".md"); stamp=time.strftime("%Y-%m-%dT%H:%M:%S%z"); relationship_text="["+", ".join(args.relationship)+"]"; project_text="" if scope=="global" else project; path.write_text(f"---\nid: {digest}\ntopic: {args.topic}\nscope: {scope}\nproject_id: {project_text}\norigin: native\nstatus: {args.status}\ncontent_sha256: {digest}\nrelationships: {relationship_text}\ncreated_at: {stamp}\nupdated_at: {stamp}\n---\n\n{content}\n",encoding="utf-8",newline="\n"); print(str(path)); return 0
