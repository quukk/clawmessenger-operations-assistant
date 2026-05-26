@echo off
echo ==========================================
echo OpenClaw Service Stop Script
echo ==========================================
echo.

set FORCE=
if "%~1"=="-f" set FORCE=1
if "%~1"=="--force" set FORCE=1

REM Check if openclaw exists
where openclaw >nul 2>&1
if errorlevel 1 (
    echo [ERROR] openclaw command not found in PATH
    exit /b 1
)

REM Check if service is running (using port detection)
netstat -an | findstr ":18789 " | findstr "LISTENING" >nul
if errorlevel 1 (
    echo [INFO] OpenClaw is not running
    exit /b 0
)

echo [INFO] OpenClaw is running
echo [INFO] Stopping service...
echo.

if defined FORCE (
    echo [INFO] Force stopping...
    taskkill /f /im openclaw.exe >nul 2>&1
    taskkill /f /im node.exe >nul 2>&1
) else (
    REM Simple stop command without extra cmd wrapper
    openclaw gateway stop
)

echo.
echo [OK] Stop command executed
echo Waiting for service to stop...
echo.

REM Wait and verify stopped
timeout /t 3 /nobreak >nul

REM Check if port is still listening
netstat -an | findstr ":18789 " | findstr "LISTENING" >nul
if errorlevel 1 (
    echo [OK] Service stopped successfully
    echo.
    echo Success
    exit /b 0
)

REM Port still listening, try graceful stop again with force flag
echo [WARN] Service may still be running, attempting force stop...
echo.

REM Kill openclaw processes
taskkill /f /im openclaw.exe >nul 2>&1

REM Wait for processes to terminate
timeout /t 2 /nobreak >nul

REM Final check
netstat -an | findstr ":18789 " | findstr "LISTENING" >nul
if errorlevel 1 (
    echo [OK] Service stopped successfully after force stop
    echo.
    echo Success
    exit /b 0
) else (
    echo [ERROR] Service stop failed: port 18789 still listening after force stop
    exit /b 1
)
