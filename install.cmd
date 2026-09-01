@echo off
setlocal EnableExtensions EnableDelayedExpansion
set "ACTION=Install"
set "ARGS="
:parse
if "%~1"=="" goto :dispatch
set "ARG=%~1"
if /I "%ARG%"=="--action" (
  set "ACTION=%~2"
  shift
  shift
  goto :parse
)
if /I "%ARG:~0,9%"=="--action=" (
  set "ACTION=%ARG:~9%"
  shift
  goto :parse
)
set "ARGS=!ARGS! "%ARG%""
shift
goto :parse
:dispatch
if /I "%ACTION%"=="Install" (set "COMMAND=install") else if /I "%ACTION%"=="Repair" (set "COMMAND=repair") else if /I "%ACTION%"=="Verify" (set "COMMAND=verify") else if /I "%ACTION%"=="Uninstall" (set "COMMAND=uninstall") else (
  echo Unknown --action value: %ACTION% 1>&2
  exit /b 2
)
node "%~dp0dist\agent-workflow.mjs" %COMMAND%!ARGS!
exit /b %ERRORLEVEL%
