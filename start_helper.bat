@echo off
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
  echo Python was not found on PATH.
  echo Install it from https://www.python.org/downloads/ and make sure to
  echo check "Add Python to PATH" during setup, then run this again.
  pause
  exit /b 1
)

python helper.py
pause
