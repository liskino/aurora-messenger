@echo off
REM Aurora web launcher: Node.js server + Cloudflare tunnel (public URL)
REM ASCII only: cmd.exe reads .bat in system codepage, Cyrillic would break.
REM This file must sit in the project root (next to package.json and server\).

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found. Install it from https://nodejs.org then run this file again.
  pause
  exit /b 1
)

REM ── client build check: server needs dist\ to serve the web UI ──
if not exist "%~dp0dist\index.html" (
  echo Web client is not built yet. Building now ^(takes ~30 seconds^)...
  pushd "%~dp0"
  call npm install --no-audit --no-fund
  call npm run build
  popd
)

set PORT=4321
set CFDIR=%LOCALAPPDATA%\Programs\cloudflared
set CFEXE=%CFDIR%\cloudflared.exe

REM ── quick tunnel: no account, free, random public URL ──
if not exist "%CFEXE%" (
  echo Downloading cloudflared...
  powershell -NoProfile -Command "New-Item -ItemType Directory -Force -Path '%CFDIR%' | Out-Null; Invoke-WebRequest 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile '%CFEXE%' -UseBasicParsing"
)

echo.
echo Server:   http://localhost:4321
echo Public:   printed by cloudflared below (https://....trycloudflare.com)
echo Browser opens automatically. Close this window to stop everything.
echo.

start "" http://localhost:4321
start "" "%CFEXE%" tunnel --url http://127.0.0.1:4321
node "%~dp0server\index.mjs"
pause
