<#
.SYNOPSIS
    Aurora — запуск мессенджера.

.DESCRIPTION
    Запускает программу: отдельное окно, в котором работает и интерфейс,
    и сервер с базой. Дополнительно устанавливать ничего не нужно.

    Если собранного приложения нет (например, вы скачали только исходники),
    скрипт запустит ту же программу через Electron из папки проекта.

    Режим браузера — запасной вариант: start.bat --web
#>

[CmdletBinding()]
param(
    [int]$Port = 0,
    [switch]$Web,
    [switch]$Dev
)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

# ─────────────────────────── оформление вывода ───────────────────────────

function Write-Head {
    Write-Host ''
    Write-Host '  ╔══════════════════════════════════════════════╗' -ForegroundColor Cyan
    Write-Host '  ║   AURORA — защищённый мессенджер              ║' -ForegroundColor Cyan
    Write-Host '  ║   своё окно, своя база, без интернета          ║' -ForegroundColor Cyan
    Write-Host '  ╚══════════════════════════════════════════════╝' -ForegroundColor Cyan
    Write-Host ''
}

function Write-Ok($t)   { Write-Host "  ✓ $t" -ForegroundColor Green }
function Write-Warn($t) { Write-Host "  ! $t" -ForegroundColor Yellow }
function Write-Err($t)  { Write-Host "  ✗ $t" -ForegroundColor Red }
function Write-Dim($t)  { Write-Host "    $t" -ForegroundColor DarkGray }

function Fail($title, $hint) {
    Write-Host ''
    Write-Err $title
    Write-Host ''
    if ($hint) { $hint | ForEach-Object { Write-Host "  $_" } }
    Write-Host ''
    Write-Host '  Нажмите Enter, чтобы закрыть…' -ForegroundColor DarkGray
    Read-Host | Out-Null
    exit 1
}

Write-Head

# ─────────────────────────── 1. Готовая программа ───────────────────────────

# Собранное приложение — самый простой путь: ему не нужен ни Node.js,
# ни интернет, ни установка. Запускаем и выходим.
$portable = Join-Path $PSScriptRoot 'release\Aurora-Portable.exe'
$unpacked = Join-Path $PSScriptRoot 'release\win-unpacked\Aurora.exe'

if (-not $Web -and -not $Dev) {
    if (Test-Path $portable) {
        Write-Ok 'Запускаю программу…'
        Write-Dim 'Откроется отдельное окно. Это не браузер.'
        Start-Process -FilePath $portable
        exit 0
    }
    if (Test-Path $unpacked) {
        Write-Ok 'Запускаю программу…'
        Write-Dim 'Откроется отдельное окно. Это не браузер.'
        Start-Process -FilePath $unpacked
        exit 0
    }
    Write-Warn 'Собранной программы нет — запускаю из исходников.'
    Write-Dim 'Чтобы получить готовый Aurora.exe, выполните: npm run dist'
    Write-Host ''
}

# ─────────────────────────── 2. Node.js ───────────────────────────

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Fail 'Node.js не установлен.' @(
        'Скачайте версию LTS и установите: https://nodejs.org',
        '',
        'Это нужно только для запуска из исходников.',
        'Готовой программе Aurora.exe Node.js не требуется.'
    )
}

$nodeVersion = (& node -v).Trim()
Write-Dim "Node.js: $nodeVersion"

$major = [int]($nodeVersion -replace '^v(\d+).*', '$1')
$minor = [int]($nodeVersion -replace '^v\d+\.(\d+).*', '$1')

# Встроенный SQLite появился в Node.js 22.5.
if ($major -lt 22 -or ($major -eq 22 -and $minor -lt 5)) {
    Fail "Версия Node.js слишком старая: $nodeVersion. Нужна 22.5 или новее." @(
        'Встроенная база данных, на которой работает мессенджер,',
        'появилась в Node.js 22.5.',
        '',
        'Скачайте актуальную LTS: https://nodejs.org'
    )
}

$npm = Join-Path (Split-Path $node.Source) 'npm.cmd'
if (-not (Test-Path $npm)) { $npm = 'npm.cmd' }

# ─────────────────────────── 3. Зависимости ───────────────────────────

if (-not (Test-Path 'node_modules\vite')) {
    Write-Host ''
    Write-Warn 'Первый запуск: устанавливаю то, что нужно.'
    Write-Dim 'Разовое скачивание, 1–2 минуты, нужен интернет.'
    Write-Host ''

    & $npm install --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) {
        Fail 'Не удалось установить зависимости.' @(
            'Проверьте интернет и запустите снова.',
            'Если вы за прокси: npm config set proxy http://ваш-прокси:порт'
        )
    }
    Write-Host ''
    Write-Ok 'Готово.'
} else {
    Write-Dim 'Всё необходимое на месте.'
}

# ─────────────────────────── 4. Сборка клиента ───────────────────────────

$needBuild = -not (Test-Path 'dist\index.html')
if (-not $needBuild) {
    $distTime = (Get-Item 'dist\index.html').LastWriteTime
    $newer = Get-ChildItem 'src' -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object { $_.LastWriteTime -gt $distTime } |
        Select-Object -First 1
    if ($newer) { $needBuild = $true }
}

if ($needBuild) {
    Write-Host ''
    Write-Host '  Собираю интерфейс…' -ForegroundColor Cyan
    & $npm run build
    if ($LASTEXITCODE -ne 0) {
        Fail 'Сборка интерфейса не удалась.' @(
            'Попробуйте удалить node_modules и dist, затем запустите снова.'
        )
    }
    Write-Ok 'Интерфейс собран.'
} else {
    Write-Dim 'Интерфейс уже собран.'
}

# ─────────────────────────── 5. Режим разработки ───────────────────────────

if ($Dev) {
    Write-Host ''
    Write-Ok 'Режим разработки.'
    Write-Host ''
    $server = Start-Process -FilePath 'node' -ArgumentList 'server/index.mjs' `
        -PassThru -NoNewWindow
    try {
        & $npm run dev
    } finally {
        if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force }
    }
    exit 0
}

# ─────────────────────────── 6. Окно программы ───────────────────────────

# Electron из папки проекта — та же программа, что и в собранном виде,
# но без упаковки. Нужна, когда exe ещё не собран.
$electron = 'node_modules\electron\dist\electron.exe'
if (-not $Web -and (Test-Path $electron)) {
    Write-Host ''
    Write-Ok 'Запускаю программу…'
    Write-Dim 'Откроется отдельное окно. Это не браузер.'
    Write-Host ''
    Start-Process -FilePath $electron -ArgumentList '.' -WorkingDirectory $PSScriptRoot
    Write-Dim 'Программа запущена в отдельном окне.'
    exit 0
}

# ─────────────────────────── 7. Запасной вариант: браузер ───────────────────────────

Write-Warn 'Приложение для окна не найдено — открываю в браузере.'
Write-Host ''

$preferred = if ($Port -gt 0) { $Port } else { 4321 }
$exitCode = 0

Push-Location $PSScriptRoot
try {
    $env:PORT = "$preferred"
    $proc = Start-Process -FilePath 'node' -ArgumentList 'server/index.mjs' `
        -RedirectStandardOutput "$env:TEMP\aurora-server.log" `
        -RedirectStandardError "$env:TEMP\aurora-server.err" `
        -NoNewWindow -PassThru

    # Сервер сообщает занятый порт строкой AURORA_PORT=… — он может взять
    # другой, если указанный занят, и браузер надо открыть именно туда.
    $detected = 0
    for ($i = 0; $i -lt 60; $i++) {
        Start-Sleep -Milliseconds 250
        if ($proc.HasExited) { break }
        $log = Get-Content "$env:TEMP\aurora-server.log" -ErrorAction SilentlyContinue
        $match = $log | Select-String -Pattern '^AURORA_PORT=(\d+)' | Select-Object -First 1
        if ($match) {
            $detected = [int]$match.Matches[0].Groups[1].Value
            break
        }
    }

    if ($proc.HasExited) {
        Get-Content "$env:TEMP\aurora-server.log" -ErrorAction SilentlyContinue | Write-Host
        Get-Content "$env:TEMP\aurora-server.err" -ErrorAction SilentlyContinue | Write-Host
        $exitCode = 1
    } else {
        if ($detected -gt 0) { $preferred = $detected }
        Write-Ok "Открываю: http://localhost:$preferred"
        Write-Host ''
        Write-Warn 'Это окно держит сервер — не закрывайте его.'
        Start-Process "http://localhost:$preferred"
        while (-not $proc.HasExited) { Start-Sleep -Milliseconds 500 }
        $exitCode = $proc.ExitCode
    }
} finally {
    Pop-Location
}

exit $exitCode