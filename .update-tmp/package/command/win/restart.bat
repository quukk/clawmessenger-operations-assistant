@echo off
echo ==========================================
echo OpenClaw Service Restart Script
echo ==========================================
echo.

REM Get the directory where this script is located
set "SCRIPT_DIR=%~dp0"

echo [INFO] Step 1: Stopping service...
call "%SCRIPT_DIR%stop.bat"
if errorlevel 1 (
    echo [WARN] Stop returned error, continuing...
)

echo.
echo [INFO] Step 2: Waiting for service to stop...
timeout /t 3 /nobreak >nul

REM Verify stopped
openclaw gateway status 2>&1 | findstr /C:"RPC probe: ok" >nul
if errorlevel 1 (
    echo [OK] Service stopped
) else (
    echo [WARN] Service may still be running, proceeding anyway
)

echo.
echo [INFO] Step 3: Starting service...
call "%SCRIPT_DIR%start.bat"
if errorlevel 1 (
    echo [ERROR] Start failed
    exit /b 1
)

echo.
echo [OK] Restart completed successfully
echo Success
exit /b 0
