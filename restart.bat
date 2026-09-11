@echo off
chcp 65001 >nul
cd /d "%~dp0"
net session >nul 2>&1
if %errorlevel% neq 0 (
    powershell -NoProfile -Command "Start-Process cmd -Verb RunAs -ArgumentList '/c','%~f0'"
    exit /b
)
echo Stopping old guard windows (incl. paused "already running" ones)...
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='cmd.exe'\" | Where-Object { $_.CommandLine -like '*start.bat*' -and $_.CommandLine -notlike '*restart.bat*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
echo Stopping old bridge processes...
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'bridge\.js' -and $_.CommandLine -notmatch 'mcp-' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
timeout /t 2 /nobreak >nul
del state\bridge.lock 2>nul
start "" cmd /c start.bat
echo Guard window started (elevated). You can close this window.
timeout /t 3 /nobreak >nul
