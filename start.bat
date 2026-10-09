@echo off
REM ==========================================================================
REM  Aurora - launcher.
REM
REM  This file is deliberately ASCII-only: cmd.exe reads .bat files in the
REM  system OEM codepage, and Cyrillic text inside a batch file gets mangled
REM  into broken commands. All user-facing messages live in start.ps1, which
REM  PowerShell reads as proper UTF-8.
REM ==========================================================================

setlocal
cd /d "%~dp0"

REM Prefer PowerShell 7 when present, fall back to Windows PowerShell 5.1,
REM which ships with every supported Windows version.
where pwsh >nul 2>&1
if %errorlevel%==0 (
    set "PSEXE=pwsh"
) else (
    set "PSEXE=powershell"
)

REM -ExecutionPolicy Bypass is required: script execution is disabled by
REM default on many systems, and without it this launcher would fail silently.
"%PSEXE%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
set "RC=%errorlevel%"

if not "%RC%"=="0" (
    echo.
    echo   The launcher exited with code %RC%.
    echo   Read the messages above for the reason.
    echo.
    pause
)

endlocal & exit /b %RC%