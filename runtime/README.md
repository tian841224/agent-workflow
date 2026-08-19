# Python runtime contract

The repository contains Python source only. Python 3.11 or newer is installed
by the user and is validated by `install.py` before hooks are registered.

`install.cmd` resolves `py -3` first and `python` second, then records the
resolved `sys.executable` in generated hook commands. Run Repair after moving or
upgrading Python. Every entrypoint uses `-X utf8 -u`; hook stdout is UTF-8 JSON
only, diagnostics go to stderr, and child processes have explicit timeouts.
