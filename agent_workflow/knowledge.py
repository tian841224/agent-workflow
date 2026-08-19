"""Small dependency-free UTF-8 knowledge store."""
from __future__ import annotations
import argparse, json, re, time
from pathlib import Path
from .frontmatter import frontmatter
def entries(root):
    for base in (Path(root)/"knowledge"/"global",Path(root)/"projects"):
        if base.exists(): yield from base.rglob("*.md")
def main(argv=None) -> int:
    parser=argparse.ArgumentParser(); parser.add_argument("--action",required=True,choices=("Search","Upsert","Reindex","List")); parser.add_argument("--state-root",default=str(Path.home()/".agent-workflow")); parser.add_argument("--query",default=""); parser.add_argument("--limit",type=int,default=8); parser.add_argument("--scope",default="All",choices=("All","Global","Project")); parser.add_argument("--topic",default=""); parser.add_argument("--content",default=""); parser.add_argument("--project-id",default=""); parser.add_argument("--path",default="."); parser.add_argument("--status",default="verified",choices=("verified","needs_verification")); parser.add_argument("--relationship",action="append",default=[]); parser.add_argument("--approved-by-user",action="store_true"); parser.add_argument("--exclude-native",action="store_true"); parser.add_argument("--include-session-summaries",action="store_true"); args=parser.parse_args(argv)
    found=list(entries(args.state_root));
    if args.scope=="Global": found=[p for p in found if f"{Path('knowledge')/'global'}".casefold() in str(p).casefold()]
    if args.scope=="Project": found=[p for p in found if "knowledge\\projects" in str(p).casefold() or "knowledge/projects" in str(p).casefold()]
    if args.action=="Search":
        terms=args.query.casefold().split(); out=[]
        for path in found:
            text=path.read_text(encoding="utf-8-sig",errors="replace")
            if terms and not all(term in text.casefold() for term in terms): continue
            out.append({"path":str(path),"topic":frontmatter(text).get("topic",path.stem),"excerpt":" ".join(text.splitlines()[-1:])[:180]})
        print(json.dumps(out[:args.limit],ensure_ascii=False)); return 0
    if args.action=="List": print(json.dumps([str(p) for p in found],ensure_ascii=False)); return 0
    if args.action=="Reindex":
        index=Path(args.state_root)/"knowledge"/"global"/"index.json"; index.parent.mkdir(parents=True,exist_ok=True); index.write_text(json.dumps({"scope":"global","entries":[{"id":p.stem,"path":str(p)} for p in found]},ensure_ascii=False,indent=2)+"\n",encoding="utf-8",newline="\n"); print("reindex complete"); return 0
    if not args.topic or not args.content: raise RuntimeError("Upsert requires --topic and --content")
    if args.scope=="Global" and not args.approved_by_user: raise RuntimeError("Global Upsert requires --approved-by-user")
    scope="global" if args.scope.casefold()=="global" else "projects"; project=args.project_id or "default"; base=Path(args.state_root)/"knowledge"/scope/"entries" if scope=="global" else Path(args.state_root)/"projects"/project/"knowledge"/"entries"; base.mkdir(parents=True,exist_ok=True); name=re.sub(r"[^a-zA-Z0-9._-]+","-",args.topic).strip("-") or "entry"; path=base/(name+".md"); stamp=time.strftime("%Y-%m-%dT%H:%M:%S%z"); rel=", ".join(args.relationship); path.write_text(f"---\ntopic: {args.topic}\nstatus: {args.status}\nproject_id: {project if scope!='global' else ''}\nrelationships: [{rel}]\ncreated_at: {stamp}\nupdated_at: {stamp}\n---\n\n{args.content.strip()}\n",encoding="utf-8",newline="\n"); print(str(path)); return 0
