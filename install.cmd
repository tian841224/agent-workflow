@echo off
setlocal EnableExtensions DisableDelayedExpansion
node "%~dp0dist\agent-workflow.mjs" install %*
exit /b %ERRORLEVEL%
exit /b %ERRORLEVEL%
