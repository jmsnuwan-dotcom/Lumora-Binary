@echo off
setlocal
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":8787" ^| findstr "LISTENING"') do (
    echo Stopping LUMORA server PID %%P ...
    taskkill /PID %%P /F
)
echo.
echo LUMORA port 8787 stopped.
pause
endlocal
