@echo off
echo ==========================================
echo OpenClaw Service Start Script
echo ==========================================
echo.

REM Check if openclaw exists
where openclaw >nul 2>&1
if errorlevel 1 (
    echo [ERROR] openclaw command not found in PATH
    exit /b 1
)

echo [OK] openclaw command found
echo.

REM Check if service is already running
netstat -an | findstr ":18789 " | findstr "LISTENING" >nul
if not errorlevel 1 (
    echo [INFO] OpenClaw is already running
    echo [INFO] Dashboard URL: http://127.0.0.1:18789/
    echo.
    echo Success
    exit /b 0
)

echo [INFO] OpenClaw is not running
echo.
echo Starting OpenClaw service...
echo.

REM Start openclaw gateway using START (creates new process, no waiting)
echo [INFO] Launching openclaw gateway...
start "OpenClaw Gateway" /min cmd /c "openclaw gateway"

echo [OK] Start command sent
echo.
echo Waiting for service to start...
echo.

REM Wait loop - max 60 seconds
REM Using ping for delay instead of timeout (more compatible with redirected stdout)
set /a count=0
:LOOP
set /a count+=1
if %count% gtr 30 (
    echo [ERROR] Timeout waiting for service to start
    exit /b 1
)

REM Use ping for 2 second delay (more reliable than timeout when stdout is redirected)
ping -n 3 127.0.0.1 >nul 2>&1

REM Check if service is ready
netstat -an | findstr ":18789 " | findstr "LISTENING" >nul
if not errorlevel 1 (
    echo [OK] Service is running
    echo [INFO] Dashboard URL: http://127.0.0.1:18789/
    echo.
    echo Success
    exit /b 0
)

echo Waiting... (%count%/30)
goto LOOP
