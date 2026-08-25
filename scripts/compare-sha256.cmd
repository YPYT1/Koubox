@echo off
chcp 65001 >nul
powershell -NoProfile -STA -ExecutionPolicy Bypass -File "%~dp0compare-sha256.ps1" %*
if errorlevel 1 (
  echo.
  pause
  exit /b 1
)
echo.
pause
exit /b 0
