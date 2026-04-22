@echo off
echo ==========================================
echo OpenClaw Service Status Script
echo ==========================================
echo.

set QUIET=
if "%~1"=="-q" set QUIET=1
if "%~1"=="--quiet" set QUIET=1

REM Check if openclaw exists
where openclaw >nul 2>&1
if errorlevel 1 (
    if defined QUIET (
        echo not_installed
    ) else (
        echo [ERROR] openclaw command not found in PATH
    )
    exit /b 1
)

if defined QUIET (
    netstat -an | findstr ":18789 " | findstr "LISTENING" >nul
    if errorlevel 1 (
        echo stopped
    ) else (
        echo running
    )
    exit /b 0
)

echo === OpenClaw Status ===
echo.

REM Check if port 18789 is listening (simple check)
netstat -an | findstr ":18789 " | findstr "LISTENING" >nul
if errorlevel 1 (
    echo [INFO] Status: Not running
    echo.
    echo [ERROR] OpenClaw service is not running
    exit /b 1
)

REM Service is running, now get detailed status
cmd /c openclaw gateway status

echo.
echo ==========================================
echo [INFO] Status: Running
 echo.
echo Success
exit /b 0
