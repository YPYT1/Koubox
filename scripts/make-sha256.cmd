@echo off
chcp 65001 >nul
if "%~1"=="" (
  powershell -NoProfile -STA -ExecutionPolicy Bypass -File "%~dp0make-sha256.ps1"
) else (
  powershell -NoProfile -STA -ExecutionPolicy Bypass -File "%~dp0make-sha256.ps1" -Path "%~1"
)
if errorlevel 1 (
  echo.
  pause
  exit /b 1
)
echo.
pause
exit /b 0
