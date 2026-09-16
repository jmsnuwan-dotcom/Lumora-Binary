@echo off
setlocal
cd /d "%~dp0"

echo ================================================
echo LUMORA V9 - LIVE SIGNAL FIX
echo ================================================
echo.
echo Checking port 8787...
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":8787" ^| findstr "LISTENING"') do (
    echo Stopping old server PID %%P ...
    taskkill /PID %%P /F >nul 2>&1
)

timeout /t 1 /nobreak >nul
start "LUMORA Browser" http://localhost:8787
where py >nul 2>nul
if %errorlevel%==0 (
    py -3 server.py
) else (
    python server.py
)
pause
endlocal
