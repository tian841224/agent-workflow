"""Python installer entrypoint; invoke with the user's Python or install.cmd."""
import sys
from pathlib import Path

SOURCE_ROOT = str(Path(__file__).resolve().parent)
if SOURCE_ROOT not in sys.path:
    sys.path.insert(0, SOURCE_ROOT)

from agent_workflow.installer import main

if __name__ == "__main__":
    raise SystemExit(main())
