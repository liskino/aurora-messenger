# setup-server.ps1 — настройка постоянного сервера Aurora на домашнем ПК.
#
# Что делает (один раз):
#   1. проверяет Node.js и собирает веб-клиент (dist\);
#   2. ставит cloudflared, если его ещё нет;
#   3. логинит Cloudflare (откроет браузер — нужен бесплатный аккаунт);
#   4. создаёт именованный туннель и пишет его в автозапуск Windows;
#   5. кладёт ярлык запуска сервера в автозагрузку.
#
# После перезагрузки ПК сервер и туннель поднимаются сами.
# Запуск: powershell -ExecutionPolicy Bypass -File setup-server.ps1

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

Write-Host '── 1/5. Node.js ──────────────────────────────'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host 'Node.js не найден. Установите с https://nodejs.org (LTS) и запустите этот скрипт снова.' -ForegroundColor Red
  exit 1
}
node --version

Write-Host '── 2/5. Сборка веб-клиента ───────────────────'
if (-not (Test-Path "$root\dist\index.html")) {
  Push-Location $root
  if (-not (Test-Path "$root\node_modules")) {
    npm install --no-audit --no-fund
  }
  npm run build
  Pop-Location
} else {
  Write-Host 'dist уже собран — пропускаю'
}

Write-Host '── 3/5. Cloudflare вход ──────────────────────'
$cfdir = "$env:LOCALAPPDATA\Programs\cloudflared"
$cfexe = "$cfdir\cloudflared.exe"
if (-not (Test-Path $cfexe)) {
  New-Item -ItemType Directory -Force -Path $cfdir | Out-Null
  Invoke-WebRequest 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile $cfexe -UseBasicParsing
}
& $cfexe --version

# cert.pem появляется только после входа в браузере
if (-not (Test-Path "$env:USERPROFILE\.cloudflared\cert.pem")) {
  Write-Host 'Сейчас откроется браузер: войдите или создайте БЕСПЛАТНЫЙ аккаунт Cloudflare и нажмите Authorize.' -ForegroundColor Yellow
  & $cfexe tunnel login
} else {
  Write-Host 'Cloudflare уже авторизован'
}

Write-Host '── 4/5. Именованный туннель ──────────────────'
$tunnelName = 'aurora'
$existing = & $cfexe tunnel list --output json 2>$null | ConvertFrom-Json
$tunnel = $existing | Where-Object { $_.name -eq $tunnelName }
if (-not $tunnel) {
  $tunnel = & $cfexe tunnel create $tunnelName | Select-String -Pattern '([0-9a-f-]{36})' | ForEach-Object { $_.Matches[0].Value }
  Write-Host "Туннель создан: $tunnel"
} else {
  $tunnel = $tunnel.id
  Write-Host "Туннель уже есть: $tunnel"
}

# Конфиг туннеля: трафик хаба 4321 -> локальный сервер Aurora
$cfconfig = "$env:USERPROFILE\.cloudflared\config.yml"
@"
tunnel: $tunnel
credentials-file: $env:USERPROFILE\.cloudflared\$tunnel.json
ingress:
  - hostname: REPLACE_ME.trycloudflare.com
    service: http://127.0.0.1:4321
  - service: http_status:404
"@ | Set-Content $cfconfig -Encoding utf8
Write-Host "Конфиг: $cfconfig"

Write-Host '── 5/5. Автозапуск ───────────────────────────'
# Сервер — в автозагрузку через ярлык на start-server-local.bat
$startLocal = "$root\start-server-local.bat"
@"
@echo off
where node >nul 2>nul || exit /b 1
node "$root\server\index.mjs"
"@ | Set-Content $startLocal -Encoding ascii

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut("$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\Aurora Server.lnk")
$shortcut.TargetPath = $startLocal
$shortcut.WorkingDirectory = $root
$shortcut.Save()

# Туннель — как служба Windows через cloudflared
& $cfexe service install 2>&1 | Out-Null
Write-Host 'Готово. Перезагрузите ПК — сервер и туннель поднимутся сами.'

Write-Host ''
Write-Host 'ВАЖНО: в файле' $cfconfig 'замените REPLACE_ME.trycloudflare.com' -ForegroundColor Yellow
Write-Host 'на своё имя хоста (см. следующее сообщение от ассистента).' -ForegroundColor Yellow
