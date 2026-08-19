from _entry import ROOT
from agent_workflow.task_profile import get_task_profile
import argparse, json
if __name__ == "__main__":
    parser=argparse.ArgumentParser(); parser.add_argument("--code-change", action="store_true"); parser.add_argument("--risk-flag", action="append", default=[]); parser.add_argument("--change-kind", default=""); parser.add_argument("--subtask-role", default="")
    args=parser.parse_args(); print(json.dumps({"profile":get_task_profile(args.code_change,args.risk_flag,args.change_kind,args.subtask_role)}));
