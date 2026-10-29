@echo off
REM Aurora server (local only, no tunnel) — for autostart and manual use.
REM The permanent tunnel runs as a Windows service; this file runs the server itself.
where node >nul 2>nul || exit /b 1
if not exist "%~dp0dist\index.html" (
  echo Web client is not built. Run setup-server.ps1 first.
  pause
  exit /b 1
)
node "%~dp0server\index.mjs"
