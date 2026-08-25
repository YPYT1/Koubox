@echo off
chcp 65001 >nul
if "%~2"=="" (
  if "%~1"=="" (
    powershell -NoProfile -STA -ExecutionPolicy Bypass -File "%~dp0compare-sha256-lists.ps1"
  ) else (
    echo Usage: compare-sha256-lists.cmd source.sha256 target.sha256
    echo Or double-click with no args to pick both files.
    echo.
    pause
    exit /b 1
  )
) else (
  powershell -NoProfile -STA -ExecutionPolicy Bypass -File "%~dp0compare-sha256-lists.ps1" -Source "%~1" -Target "%~2"
)
if errorlevel 1 (
  echo.
  pause
  exit /b 1
)
echo.
pause
exit /b 0
