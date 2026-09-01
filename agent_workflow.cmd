@echo off
setlocal EnableExtensions DisableDelayedExpansion
node "%~dp0dist\agent-workflow.mjs" %*
exit /b %ERRORLEVEL%
