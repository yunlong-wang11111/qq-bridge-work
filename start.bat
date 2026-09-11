@echo off
chcp 65001 >nul
cd /d "%~dp0"
net session >nul 2>&1
if %errorlevel% neq 0 (
    powershell -NoProfile -Command "Start-Process cmd -Verb RunAs -ArgumentList '/c','%~f0'"
    exit /b
)
:loop
node src/bridge.js
set code=%errorlevel%
if "%code%"=="2" (
    echo [%date% %time%] bridge already running in another window. Exiting.
    pause
    exit /b 2
)
echo [%date% %time%] bridge exited (code %code%), restarting in 5 seconds...
timeout /t 5 /nobreak >nul
goto loop
