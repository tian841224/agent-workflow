"""Read-only runtime health check."""
from __future__ import annotations
import argparse, json, sys
from pathlib import Path
from .protocol import write_json
from .runtime_manager import find_python, verify_python
from .codex_hook_trust import untrusted

def main(argv=None) -> int:
    parser=argparse.ArgumentParser(); parser.add_argument("--state-root",default=str(Path.home()/".agent-workflow")); parser.add_argument("--codex-root",default=str(Path.home()/".codex")); args=parser.parse_args(argv)
    root=Path(args.state_root)/"runtime"
    try:
        python=verify_python(find_python())
        missing=untrusted(str(Path(args.codex_root)/"hooks.json"),str(Path(args.codex_root)/"config.toml"),str(root)); result={"runtime_root":str(root),"python":python["executable"],"python_version":python["version"],"python_exists":True,"entrypoint":(root/"agent_workflow.py").is_file(),"untrusted_codex_hooks":missing}
    except Exception as exc:
        result={"runtime_root":str(root),"python":sys.executable,"python_exists":False,"entrypoint":(root/"agent_workflow.py").is_file(),"error":str(exc)}
    write_json(result); return 0 if result["python_exists"] and result["entrypoint"] else 1
