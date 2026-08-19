@echo off
setlocal EnableExtensions DisableDelayedExpansion
set "AW_ROOT=%~dp0"
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"
where py.exe >nul 2>nul
if not errorlevel 1 (
  py.exe -3 -X utf8 -u "%AW_ROOT%install.py" %*
  exit /b %ERRORLEVEL%
)
where python.exe >nul 2>nul
if not errorlevel 1 (
  for /f "delims=" %%P in ('where python.exe 2^>nul') do (
    if /I not "%%P"=="%LOCALAPPDATA%\Microsoft\WindowsApps\python.exe" (
      "%%P" -X utf8 -u "%AW_ROOT%install.py" %*
      exit /b %ERRORLEVEL%
    )
  )
)
echo Python 3.11+ was not found. Install Python from python.org, enable the Python Launcher or PATH, then run this command again. 1>&2
exit /b 1
exit /b %ERRORLEVEL%
