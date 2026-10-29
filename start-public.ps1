# start-public.ps1 — Aurora public server with rotating trycloudflare URL.
#
# What it does:
#   1. starts the Aurora server (node server/index.mjs, port 4321);
#   2. starts a free quick Cloudflare tunnel (random URL);
#   3. pushes the new URL to GitHub file server-url.txt (repo aurora-messenger);
#   4. keeps running; on exit marks the server OFFLINE in the same file.
#
# One-time setup on this PC:
#   - Node.js (nodejs.org, LTS)
#   - GitHub CLI:  winget install GitHub.cli
#   - Login once:  gh auth login --web
#
# ASCII-only: this file is read by Windows PowerShell 5.1 which may treat
# non-ASCII as ANSI. Russian instructions live in README.md.

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$REPO = 'liskino/aurora-messenger'
$BRANCH = 'master'
$URL_FILE = 'server-url.txt'

Write-Host '== Aurora public server =='

# ── checks ──
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host 'Node.js not found. Install LTS from https://nodejs.org first.' -ForegroundColor Red
  exit 1
}
if (-not (Test-Path "$root\dist\index.html")) {
  Write-Host 'Web client not built. Building (~30 s)...'
  Push-Location $root
  if (-not (Test-Path "$root\node_modules")) { npm install --no-audit --no-fund }
  npm run build
  Pop-Location
}

$gh = $null
foreach ($c in @((Get-Command gh -ErrorAction SilentlyContinue).Source, 'C:\Program Files\GitHub CLI\gh.exe')) {
  if ($c -and (Test-Path $c)) { $gh = $c; break }
}
if (-not $gh) {
  Write-Host 'GitHub CLI not found. Install it:  winget install GitHub.cli' -ForegroundColor Red
  Write-Host 'Then login once:  gh auth login --web'
  exit 1
}
& $gh auth status 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Host 'GitHub CLI is not logged in. Run:  gh auth login --web' -ForegroundColor Red
  exit 1
}

$cfdir = "$env:LOCALAPPDATA\Programs\cloudflared"
$cfexe = "$cfdir\cloudflared.exe"
if (-not (Test-Path $cfexe)) {
  Write-Host 'Downloading cloudflared...'
  New-Item -ItemType Directory -Force -Path $cfdir | Out-Null
  Invoke-WebRequest 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile $cfexe -UseBasicParsing
}

# ── push link to GitHub ──
function Push-UrlFile([string]$text) {
  $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($text))

  # SHA текущего файла — через gh (авторизованно, без CDN-кеша анонимных запросов).
  $sha = $null
  $metaJson = & $gh api "repos/$REPO/contents/$URL_FILE" --jq '.sha' 2>$null
  if ($LASTEXITCODE -eq 0 -and $metaJson) { $sha = ($metaJson | Select-Object -Last 1).Trim() }

  $ok = $false
  if ($sha) {
    & $gh api -X PUT "repos/$REPO/contents/$URL_FILE" -f message="server link update" -f content=$b64 -f branch=$BRANCH -f sha=$sha 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) { $ok = $true }
  }
  if (-not $ok) {
    # без sha GitHub создаёт файл, а при гонке sha сам подставит актуальный
    & $gh api -X PUT "repos/$REPO/contents/$URL_FILE" -f message="server link" -f content=$b64 -f branch=$BRANCH 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) { $ok = $true }
  }
  if (-not $ok) {
    # последний шанс: свежий sha и повтор
    Start-Sleep -Seconds 3
    $metaJson = & $gh api "repos/$REPO/contents/$URL_FILE" --jq '.sha' 2>$null
    if ($LASTEXITCODE -eq 0 -and $metaJson) {
      $sha2 = ($metaJson | Select-Object -Last 1).Trim()
      & $gh api -X PUT "repos/$REPO/contents/$URL_FILE" -f message="server link update" -f content=$b64 -f branch=$BRANCH -f sha=$sha2 2>&1 | Out-Null
      if ($LASTEXITCODE -eq 0) { $ok = $true }
    }
  }
  if (-not $ok) { Write-Host 'WARNING: failed to push link to GitHub' -ForegroundColor Yellow }
}

# ── start server ──
Write-Host 'Starting server on 127.0.0.1:4321 ...'
$server = Start-Process node -ArgumentList "`"$root\server\index.mjs`"" -WorkingDirectory $root -PassThru -WindowStyle Minimized

# ── start tunnel, catch the URL ──
Write-Host 'Starting tunnel...'
$tunLog = Join-Path $env:TEMP 'aurora-tunnel.log'
$tunOut = Join-Path $env:TEMP 'aurora-tunnel-out.log'
Remove-Item $tunLog, $tunOut -ErrorAction SilentlyContinue
$cf = Start-Process $cfexe -ArgumentList 'tunnel', '--url', 'http://127.0.0.1:4321' -PassThru -WindowStyle Hidden -RedirectStandardError $tunLog -RedirectStandardOutput $tunOut

$link = $null
for ($i = 0; $i -lt 90; $i++) {
  Start-Sleep -Seconds 1
  # URL печатается в stdout, ошибки — в stderr: читаем оба.
  $txt = ''
  if (Test-Path $tunOut) { $txt += Get-Content $tunOut -Raw -ErrorAction SilentlyContinue }
  if (Test-Path $tunLog) { $txt += Get-Content $tunLog -Raw -ErrorAction SilentlyContinue }
  if (($m = [regex]::Match($txt, 'https://[a-z0-9-]+\.trycloudflare\.com')).Success) { $link = $m.Value; break }
  if ($cf.HasExited) { break }
}

if (-not $link) {
  Write-Host 'Tunnel failed to start.' -ForegroundColor Red
  Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
  exit 1
}

Write-Host ''
Write-Host "PUBLIC URL: $link" -ForegroundColor Green
Write-Host ''

$stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
Push-UrlFile "$link`nupdated: $stamp"
Write-Host "Link pushed to GitHub ($REPO/$URL_FILE)."

try {
  # Keep running until the server process dies (window closed / PC shutdown).
  Wait-Process -Id $server.Id -ErrorAction SilentlyContinue
} finally {
  Stop-Process -Id $cf.Id -Force -ErrorAction SilentlyContinue
  Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
  Write-Host 'Server stopped. Marking OFFLINE on GitHub...'
  Push-UrlFile "OFFLINE`nupdated: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
}
