<#
.SYNOPSIS
    Aurora — запуск мессенджера одной кнопкой.

.DESCRIPTION
    Проверяет окружение, при необходимости ставит зависимости, помогает
    создать .env.local и запускает сервер разработки. Все проверки сделаны
    ради одной цели: чтобы человек не встретил молчаливую ошибку на
    английском языке и не остался гадать, что пошло не так.

    Запускается из start.bat. Можно запустить и напрямую:
        powershell -ExecutionPolicy Bypass -File start.ps1
#>

[CmdletBinding()]
param(
    [int]$Port = 5173,
    [switch]$Prod
)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

# ─────────────────────────── оформление вывода ───────────────────────────

function Write-Head {
    Write-Host ''
    Write-Host '  ╔══════════════════════════════════════════════╗' -ForegroundColor Cyan
    Write-Host '  ║   AURORA — защищённый мессенджер              ║' -ForegroundColor Cyan
    Write-Host '  ║   сквозное шифрование, работа из любой сети   ║' -ForegroundColor Cyan
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

function Ask($question, $yes = 'Y', $no = 'N') {
    # Read-Host вместо choice: choice недоступен в PowerShell и ломается при
    # вводе из конвейера. Здесь же достаточно простого ответа.
    $answer = Read-Host "  $question [$yes/$no]"
    return ($answer -match '^[YyДд]')
}

# ─────────────────────────── заголовок ───────────────────────────

Write-Head

# ─────────────────────────── 1. Node.js ───────────────────────────

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Fail 'Node.js не установлен — без него мессенджер не запустится.' @(
        'Node.js — это среда, в которой работает приложение.',
        'Скачайте версию LTS и установите: https://nodejs.org',
        '',
        'При установке ничего менять не нужно, просто нажимайте «Далее».'
    )
}

$nodeVersion = (& node -v).Trim()
Write-Dim "Node.js: $nodeVersion"

$major = [int]($nodeVersion -replace '^v(\d+).*', '$1')
if ($major -lt 18) {
    Fail "Версия Node.js устарела: $nodeVersion. Нужна 18 или новее." @(
        'Скачайте актуальную LTS: https://nodejs.org'
    )
}

# npm в PowerShell блокируется политикой выполнения (npm.ps1),
# поэтому вызываем именно npm.cmd.
$npm = Join-Path (Split-Path $node.Source) 'npm.cmd'
if (-not (Test-Path $npm)) { $npm = 'npm.cmd' }

# ─────────────────────────── 2. Зависимости ───────────────────────────

if (-not (Test-Path 'node_modules\vite')) {
    Write-Host ''
    Write-Warn 'Зависимости не установлены — ставлю. Первый запуск занимает 1-2 минуты.'
    Write-Dim 'Это скачивание библиотек: нужен интернет и немного терпения.'
    Write-Host ''

    & $npm install --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) {
        Fail 'Не удалось установить зависимости.' @(
            'Что можно сделать:',
            '  1. Проверьте интернет и запустите start.bat снова.',
            '  2. Если вы за прокси, настройте npm:',
            '     npm config set proxy http://ваш-прокси:порт',
            '  3. Крайний случай — очистить и повторить:',
            '     Remove-Item -Recurse -Force node_modules',
            '     npm cache clean --force'
        )
    }
    Write-Host ''
    Write-Ok 'Зависимости установлены.'
} else {
    Write-Dim 'Зависимости на месте.'
}

# ─────────────────────────── 3. Файл настроек ───────────────────────────

function Test-EnvFile {
    if (-not (Test-Path '.env.local')) { return $false }
    $content = Get-Content '.env.local' -Raw -ErrorAction SilentlyContinue
    if (-not $content) { return $false }

    $urlMatch = [regex]::Match($content, 'VITE_SUPABASE_URL\s*=\s*https://([a-z0-9-]+)\.supabase\.co')
    $keyMatch = [regex]::Match($content, 'VITE_SUPABASE_ANON_KEY\s*=\s*(\S+)')
    if (-not $urlMatch.Success -or -not $keyMatch.Success) { return $false }

    $hostName = $urlMatch.Groups[1].Value
    $key = $keyMatch.Groups[1].Value

    # Отсеиваем заглушку из .env.example (адрес вида «xxxxxxxxxxxx»).
    # Без этой проверки скрипт принимал бы пример за настоящие настройки,
    # и человек получал бы молча неработающие чаты.
    if ($hostName -match '^x+$' -or $hostName -match '^(ваш|your|example|test|demo)$') { return $false }

    # Ключ Supabase — это JWT, он всегда начинается с eyJ.
    if ($key -notmatch '^eyJ') { return $false }

    return $true
}

function Open-InEditor($path) {
    # notepad заведомо есть в Windows и не требует ассоциаций файлов.
    try {
        Start-Process notepad.exe -ArgumentList "`"$path`"" -Wait
        return $true
    } catch {
        Write-Warn "Не удалось открыть Блокнот. Откройте файл вручную: $path"
        return $false
    }
}

if (-not (Test-EnvFile)) {
    Write-Host ''
    Write-Host '  ┌──────────────────────────────────────────────────────────┐' -ForegroundColor Yellow
    Write-Host '  │  Нужен бесплатный бэкенд Supabase — это 5 минут.         │' -ForegroundColor Yellow
    Write-Host '  └──────────────────────────────────────────────────────────┘' -ForegroundColor Yellow
    Write-Host ''
    Write-Host '  Без него мессенджер откроется, но отправлять сообщения не сможет:'
    Write-Host '  доставка идёт через сервер, а не напрямую между устройствами.'
    Write-Host ''
    Write-Host '  Шаг 1. ' -NoNewline; Write-Host 'Откройте https://supabase.com и создайте проект.' -ForegroundColor Cyan
    Write-Host '  Шаг 2. ' -NoNewline; Write-Host 'В проекте: SQL Editor → вставьте supabase\schema.sql → Run.' -ForegroundColor Cyan
    Write-Host '  Шаг 3. ' -NoNewline; Write-Host 'Project Settings → API — скопируйте URL и ключ anon.' -ForegroundColor Cyan
    Write-Host ''

    if (-not (Test-Path '.env.local')) {
        if (Test-Path '.env.example') {
            Copy-Item '.env.example' '.env.local' -Force
            Write-Ok 'Файл .env.local создан за вас — осталось вставить значения.'
        } else {
            @(
                '# Supabase → Project Settings → API',
                'VITE_SUPABASE_URL=https://ваш-проект.supabase.co',
                'VITE_SUPABASE_ANON_KEY=ваш-ключ-anon',
                '',
                '# Необязательно: TURN-сервер для звонков между разными сетями',
                'VITE_TURN_URL=',
                'VITE_TURN_USERNAME=',
                'VITE_TURN_CREDENTIAL='
            ) | Set-Content '.env.local' -Encoding UTF8
            Write-Ok 'Файл .env.local создан за вас — осталось вставить значения.'
        }
    }

    Write-Host ''
    if (Ask 'Открыть .env.local в Блокноте сейчас?') {
        Open-InEditor (Join-Path $PWD '.env.local')
        Write-Host ''
        if (Test-EnvFile) {
            Write-Ok 'Настройки заполнены.'
        } else {
            Write-Warn 'Адрес Supabase пока не похож на настоящий.'
            Write-Dim 'Мессенджер запустится, но чаты не заработают. Можно заполнить позже и запустить снова.'
        }
    } else {
        Write-Warn 'Работаю без подключения к серверу: интерфейс откроется, чаты — нет.'
    }
} else {
    Write-Ok 'Настройки подключения найдены (.env.local).'

    $turn = (Get-Content '.env.local' -Raw) -match 'VITE_TURN_URL\s*=\s*\S+'
    if (-not $turn) {
        Write-Warn 'TURN-сервер не настроен.'
        Write-Dim 'Звонки в одной сети будут работать, между мобильным интернетом и Wi-Fi — нет.'
        Write-Dim 'Как настроить: README, раздел про звонки.'
    }
}

# ─────────────────────────── 4. Порт ───────────────────────────

function Test-PortBusy($p) {
    $busy = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue
    return [bool]$busy
}

if (Test-PortBusy $Port) {
    Write-Host ''
    Write-Warn "Порт $Port уже занят: возможно, Aurora уже запущена в другом окне."
    Write-Host ''
    Write-Host '  1 — открыть браузер (если старый экземпляр работает)' -ForegroundColor Cyan
    Write-Host '  2 — запустить на порту 5174' -ForegroundColor Cyan
    Write-Host '  3 — выйти' -ForegroundColor Cyan
    Write-Host ''
    $pick = Read-Host '  Ваш выбор [1]'
    switch ($pick) {
        '2' { $Port = 5174 }
        '3' { exit 0 }
        default {
            Start-Process "http://localhost:$Port"
            exit 0
        }
    }
}

# ─────────────────────────── 5. Запуск ───────────────────────────

$mode = if ($Prod) { 'предпросмотр сборки' } else { 'режим разработки' }
Write-Host ''
Write-Ok "Запускаю мессенджер ($mode)…"
Write-Host ''
Write-Host "    Адрес: " -NoNewline
Write-Host "http://localhost:$Port" -ForegroundColor Cyan
Write-Host ''
Write-Host '  Что делать дальше:' -ForegroundColor White
Write-Host '   1. Откроется браузер с мессенджером.'
Write-Host '   2. Зарегистрируйтесь — пароль шифрует ваш ключ и на сервер не уходит.'
Write-Host '   3. Чтобы проверить переписку, откройте второе окно ' -NoNewline
Write-Host '(Ctrl+Shift+N)' -ForegroundColor DarkGray -NoNewline
Write-Host ' и создайте второго пользователя.'
Write-Host ''
Write-Warn 'Это окно закрывать не нужно — оно держит сервер.'
Write-Dim 'Остановить: Ctrl+C или закрыть окно.'
Write-Host ''

# Браузер открываем с задержкой, чтобы сервер успел подняться: иначе вкладка
# откроется на пустой странице, и человек решит, что всё сломалось.
# Отдельный процесс вместо Start-Job: задание пришлось бы убирать за собой,
# а лишние сущности в скрипте запуска — лишние поводы для поломки.
$opener = "Start-Sleep -Seconds 4; Start-Process 'http://localhost:$Port'"
Start-Process -FilePath (Get-Process -Id $PID).Path `
    -ArgumentList '-NoProfile', '-WindowStyle', 'Hidden', '-Command', $opener `
    -WindowStyle Hidden | Out-Null

Push-Location $PSScriptRoot
try {
    if ($Prod) {
        & $npm run build
        if ($LASTEXITCODE -ne 0) { throw 'Сборка не удалась.' }
        & npx vite preview --port $Port --host
    } else {
        & npx vite --port $Port --host
    }
    $exitCode = $LASTEXITCODE
} catch {
    $exitCode = 1
    Write-Host ''
    Write-Err $_.Exception.Message
} finally {
    Pop-Location
}

Write-Host ''
if ($exitCode -ne 0) {
    Write-Err "Сервер остановлен с ошибкой (код $exitCode)."
    Write-Host ''
    Write-Host '  Частые причины:'
    Write-Host "    - порт $Port занят другой программой"
    Write-Host '    - антивирус блокирует запуск'
    Write-Host '    - повреждены зависимости: удалите node_modules и запустите снова'
    Write-Host ''
    Write-Host '  Нажмите Enter, чтобы закрыть…' -ForegroundColor DarkGray
    Read-Host | Out-Null
} else {
    Write-Dim 'Сервер остановлен.'
}

exit $exitCode