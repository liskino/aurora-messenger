@echo off
REM open-aurora.bat — Aurora client launcher for friends.
REM Reads the current public server link from GitHub and opens the browser.
REM Works on any Windows PC: no Node.js, no git, no install needed.
REM ASCII only: cmd.exe reads .bat in system codepage.

setlocal
set URLFILE=https://raw.githubusercontent.com/liskino/aurora-messenger/master/server-url.txt
set TMPF=%TEMP%\aurora-link.txt

echo Reading server link from GitHub...
powershell -NoProfile -Command "try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest '%URLFILE%' -OutFile '%TMPF%' -UseBasicParsing } catch { exit 1 }"
if errorlevel 1 goto nofile

set LINK=
for /f "usebackq delims=" %%L in (`powershell -NoProfile -Command "Get-Content '%TMPF%' -TotalCount 1"`) do set LINK=%%L

if "%LINK%"=="" goto nofile
if /i "%LINK:~0,7%"=="OFFLINE" goto offline
if /i "%LINK:~0,8%"=="https://" goto open

:nofile
echo.
echo Server link not found on GitHub.
echo The server owner has not run start-public.ps1 yet.
echo Repo: https://github.com/liskino/aurora-messenger
pause
exit /b 1

:offline
echo.
echo Server is OFFLINE right now.
echo Ask the owner to run start-public.ps1 on the home PC.
pause
exit /b 1

:open
echo.
echo Aurora server: %LINK%
echo Checking server is alive...
powershell -NoProfile -Command "try { [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; $r = Invoke-WebRequest '%LINK%/api/health' -UseBasicParsing -TimeoutSec 12; exit 0 } catch { exit 1 }"
if errorlevel 1 goto dead
start "" "%LINK%"
exit /b 0

:dead
echo.
echo The link is stale (server restarted and got a new URL).
echo Re-reading from GitHub...
timeout /t 15 /nobreak >nul
powershell -NoProfile -Command "try { [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest '%URLFILE%?t=' + [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() -OutFile '%TMPF%' -UseBasicParsing } catch { exit 1 }"
if errorlevel 1 goto nofile
for /f "usebackq delims=" %%L in (`powershell -NoProfile -Command "Get-Content '%TMPF%' -TotalCount 1"`) do set LINK=%%L
if /i "%LINK:~0,7%"=="OFFLINE" goto offline
if /i "%LINK:~0,8%"=="https://" goto retry
goto nofile

:retry
echo New link: %LINK%
start "" "%LINK%"
exit /b 0
