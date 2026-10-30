@echo off
setlocal enabledelayedexpansion

set ROOT=%~dp0
set BUILD_DIR=%ROOT%build

rem Auto-detect tool paths
where go >nul 2>&1
if %ERRORLEVEL% neq 0 (
    if exist "C:\Users\Administrator\sdk\go1.26.2\bin\go.exe" (
        set "PATH=C:\Users\Administrator\sdk\go1.26.2\bin;%PATH%"
    )
)
where rustc >nul 2>&1
if %ERRORLEVEL% neq 0 (
    if exist "C:\Users\Administrator\.cargo\bin\rustc.exe" (
        set "PATH=C:\Users\Administrator\.cargo\bin;%PATH%"
    )
)
where node >nul 2>&1
if %ERRORLEVEL% neq 0 (
    if exist "C:\Program Files\nodejs\node.exe" (
        set "PATH=C:\Program Files\nodejs;%PATH%"
    )
)

echo ========================================
echo  Exhibition Remote Control - Build All
echo ========================================
echo.

rem 1. Create build output directory
if not exist "%BUILD_DIR%" mkdir "%BUILD_DIR%"
echo [1/4] Output dir: %BUILD_DIR%

rem 2. Build frontend (npm run build -> dist/)
echo.
echo [2/4] Building frontend...
cd /d "%ROOT%"
call npm run build
if %ERRORLEVEL% neq 0 (
    echo [FAIL] Frontend build error: %ERRORLEVEL%
    pause
    exit /b %ERRORLEVEL%
)
echo [OK] Frontend built

rem 3. Build Rust Agent FIRST (the Hub embeds agent-bin at compile time via go:embed,
rem     so the agent must be rebuilt and copied to agent-bin BEFORE the Hub build)
echo.
echo [3/4] Building Rust Agent...
cd /d "%ROOT%agent-rust"
call cargo build --release
if %ERRORLEVEL% neq 0 (
    echo [FAIL] Agent build error: %ERRORLEVEL%
    pause
    exit /b %ERRORLEVEL%
)

rem Copy agent exe to build dir and hub embed dir
copy /Y "%ROOT%agent-rust\target\release\exhibition-agent.exe" "%BUILD_DIR%\exhibition-agent.exe" >nul
if not exist "%ROOT%server-go\agent-bin" mkdir "%ROOT%server-go\agent-bin"
copy /Y "%ROOT%agent-rust\target\release\exhibition-agent.exe" "%ROOT%server-go\agent-bin\exhibition-agent.exe" >nul
echo [OK] Agent built: %BUILD_DIR%\exhibition-agent.exe

rem 4. Build Go Hub (embeds dist/ and the latest agent-bin agent)
echo.
echo [4/4] Building Go Hub...
cd /d "%ROOT%server-go"
call go build -ldflags "-H windowsgui" -o "%BUILD_DIR%\exhibition-hub.exe" .
if %ERRORLEVEL% neq 0 (
    echo [FAIL] Hub build error: %ERRORLEVEL%
    pause
    exit /b %ERRORLEVEL%
)
echo [OK] Hub built: %BUILD_DIR%\exhibition-hub.exe

rem 5. Summary
echo.
echo ========================================
echo  ALL BUILDS COMPLETE
echo ========================================
echo.
echo Output: %BUILD_DIR%
echo.
dir "%BUILD_DIR%" /b
echo.
echo Files:
echo   exhibition-hub.exe   - Go Hub (http://localhost:38921)
echo   exhibition-agent.exe - Rust Agent
echo.
pause
