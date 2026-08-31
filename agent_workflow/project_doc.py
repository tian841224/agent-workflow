"""Read-only project-doc lookup, listing, staleness and contract checks."""
from __future__ import annotations
import argparse,json,re,subprocess
from pathlib import Path
from .protocol import write_json
def metadata(text):
    m=re.search(r"(?ms)^---\n(.*?)\n---\n?(.*)$",text.replace("\r\n","\n"));
    if not m:return None
    data={}
    for line in m.group(1).splitlines():
        x=re.match(r"^([a-z_]+):\s*(.*)$",line)
        if x:
            value=x.group(2).strip()
            try:value=json.loads(value)
            except Exception:pass
            data[x.group(1)]=value
    if not data.get("doc_type"):return None
    data["body"]=m.group(2);return data
def git(root,args):return subprocess.run(["git","-C",str(root),*args],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,check=False)
def doc_list(root,doc_root):
    base=(Path(root).resolve()/doc_root).resolve(); out=[]
    if not base.is_dir():return out
    for path in base.rglob("*.md"):
        data=metadata(path.read_text(encoding="utf-8-sig"));
        if not data:continue
        rel=str(path.relative_to(Path(root).resolve())).replace("\\","/"); covers=data.get("covers",[]); covers=[covers] if isinstance(covers,str) else [str(x) for x in covers];
        def stamp(args):
            p=git(root,args); value=p.stdout.decode().strip()
            try:return int(value)
            except ValueError:return None
        # An empty covers list (architecture/dataflow/glossary) must never fall through to
        # a bare `-- ` pathspec: git treats that as "no restriction" and reports the whole
        # repo's latest activity, which would make every such doc spuriously stale the
        # moment anything else in the repo changes.
        doc_time=stamp(["log","-1","--format=%ct","--",rel])
        code_time=stamp(["log","-1","--format=%ct","--",*covers]) if covers else None
        dirty=bool(git(root,["status","--porcelain","--",*covers]).stdout.strip()) if covers else False
        out.append({"path":str(path),"doc_type":data.get("doc_type"),"covers":covers,"stale":doc_time is not None and code_time is not None and code_time>doc_time,"stale_pending":dirty and not bool(git(root,["status","--porcelain","--",rel]).stdout.strip()),"body":data.get("body","")})
    return out
def run(action,doc="",repo_root=".",paths=None,doc_root="docs"):
    root=Path(repo_root).resolve(); items=doc_list(root,doc_root); key=action.casefold()
    if key=="check":
        target=Path(doc); issues=[]
        if not target.is_file():return [{"path":str(target),"issues":["document does not exist"]}]
        data=metadata(target.read_text(encoding="utf-8-sig")); allowed={"architecture","structure","dataflow","flow","module","api","decision","glossary"}
        if not data:issues.append("missing or invalid frontmatter")
        else:
            if data.get("doc_type") not in allowed:issues.append(f"unknown doc_type: {data.get('doc_type')}")
            covers=data.get("covers",[]); covers=[covers] if isinstance(covers,str) else covers
            if data.get("doc_type") not in {"architecture","structure","dataflow","glossary"} and not covers:issues.append("covers must not be empty")
            required={"structure":["Layout","Placement rules","Unverified"],"flow":["Trigger","Steps","Failure modes","Unverified"],"module":["Responsibility","Entrypoints","Flow","Shared state","Invariants and gotchas","Unverified"],"api":["Endpoint","Auth","Request","Response","Errors","Invariants and gotchas","Unverified"],"decision":["Context","Decision","Alternatives","Consequences"],"glossary":["Terms"]}.get(data.get("doc_type"),[])
            for name in required:
                m=re.search(rf"(?ms)^## {re.escape(name)}\s*\n(.*?)(?=^## |\Z)",data.get("body",""));
                if not m or not m.group(1).strip() or re.match(r"^<.*>$",m.group(1).strip()):issues.append(f"missing section: {name}")
        return [{"path":str(target),"issues":issues}]
    results=[]
    for item in items:results.append({k:v for k,v in item.items() if k!="body"}|{"matched_by":[]})
    if key=="list":return results
    if key=="stale":return [x for x in results if x["stale"] or x["stale_pending"]]
    queries=[]
    for value in paths or []:
        target=(root/value).resolve() if not Path(value).is_absolute() else Path(value).resolve()
        try:queries.append(str(target.relative_to(root)).replace("\\","/").casefold())
        except ValueError:raise RuntimeError(f"path is outside the repo root: {value}")
    matched=set()
    for result,item in zip(results,items):
        for query in queries:
            if any(query==entry.casefold() or (entry.endswith("/") and (query.startswith(entry.casefold()) or query==entry.rstrip("/").casefold())) for entry in item["covers"]):result["matched_by"].append(query);matched.add(query)
        result["matched_by"]=sorted(set(result["matched_by"]))
    results.sort(key=lambda x:max([len(y) for y in x["matched_by"]] or [0]),reverse=True);return {"docs":results,"uncovered":[x for x in queries if x not in matched]}
def main(argv=None):
    p=argparse.ArgumentParser();p.add_argument("--action",required=True,choices=("Lookup","List","Stale","Check"));p.add_argument("--doc",default="");p.add_argument("--repo-root",default=".");p.add_argument("--doc-root",default="docs");p.add_argument("--paths",nargs="*");a=p.parse_args(argv);write_json(run(a.action,a.doc,a.repo_root,a.paths,a.doc_root));return 0
if __name__=="__main__":raise SystemExit(main())
