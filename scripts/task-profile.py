from _entry import ROOT
from agent_workflow.task_profile import get_task_profile
from agent_workflow.workflow_planner import plan_task
import argparse, json
if __name__ == "__main__":
    parser=argparse.ArgumentParser(); parser.add_argument("--code-change", action="store_true"); parser.add_argument("--risk-flag", action="append", default=[]); parser.add_argument("--change-kind", default=""); parser.add_argument("--subtask-role", default=""); parser.add_argument("--task-json", default="")
    args=parser.parse_args()
    if args.task_json:
        task=json.loads(args.task_json); print(json.dumps(plan_task(task), ensure_ascii=False))
    else:
        print(json.dumps({"profile":get_task_profile(args.code_change,args.risk_flag,args.change_kind,args.subtask_role)}));
