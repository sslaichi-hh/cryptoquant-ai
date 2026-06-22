@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul

set "ROOT=%~dp0"
cd /d "%ROOT%"
title CryptoQuant AI Launcher

set "APP_PORT=3000"
set "PORT_STATE=FREE"
set "LOG_FILE="
set "NEEDS_BUILD=1"

for /f "usebackq delims=" %%I in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "$content = Get-Content -Raw 'server.ts' -ErrorAction SilentlyContinue; if ($content -match 'const PORT\s*=\s*(\d+)') { $matches[1] } else { '3000' }"`) do set "APP_PORT=%%I"

echo.
echo ========================================
echo   CryptoQuant AI Launcher
echo   Stable production mode
echo ========================================
echo.

echo [1/5] Checking prerequisites...
where npm >nul 2>nul
if errorlevel 1 (
  call :fail "npm was not found. Install Node.js first."
  exit /b 1
)

if not exist "package.json" (
  call :fail "package.json was not found in the current directory."
  exit /b 1
)

if not exist "server.ts" (
  call :fail "server.ts was not found in the current directory."
  exit /b 1
)

call :detect_port_state
if /I "!PORT_STATE!"=="APP_ALREADY_RUNNING" (
  echo [OK] Service is already running.
  call :show_access
  start "" "http://127.0.0.1:!APP_PORT!/"
  call :maybe_pause
  exit /b 0
)

if /I "!PORT_STATE!"=="PORT_BUSY_OTHER" (
  call :fail "Port !APP_PORT! is already used by another process."
  exit /b 1
)

echo.
echo [2/5] Checking build artifacts...
for /f "usebackq delims=" %%I in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "$dist = Join-Path (Get-Location) 'dist\\index.html'; if (-not (Test-Path $dist)) { '1'; exit }; $distTime = (Get-Item $dist).LastWriteTimeUtc; $paths = @('index.html', 'package.json'); $paths += (Get-ChildItem -File -Path 'vite.config.*' -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName }); foreach ($folder in @('src', 'public')) { if (Test-Path $folder) { $paths += (Get-ChildItem -Recurse -File -Path $folder -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName }) } }; $needsBuild = $false; foreach ($path in $paths) { if (Test-Path $path -PathType Leaf) { if ((Get-Item $path).LastWriteTimeUtc -gt $distTime) { $needsBuild = $true; break } } }; if ($needsBuild) { '1' } else { '0' }"`) do set "NEEDS_BUILD=%%I"

if "!NEEDS_BUILD!"=="1" (
  echo [3/5] Building frontend bundle...
  call npm run build
  if errorlevel 1 (
    call :fail "Build failed."
    exit /b 1
  )
) else (
  echo [3/5] Frontend bundle is up to date.
)

echo.
echo [4/5] Starting production server...
for /f "usebackq delims=" %%I in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-Date -Format 'yyyyMMdd-HHmmss'"`) do set "STAMP=%%I"
set "LOG_DIR=%TEMP%\cryptoquant-ai"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%" >nul 2>nul
set "LOG_FILE=%LOG_DIR%\prod-!STAMP!.log"

start "CryptoQuant AI Production Server" powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -NoExit -Command "$Host.UI.RawUI.WindowTitle = 'CryptoQuant AI Production Server'; Set-Location -LiteralPath '%ROOT%'; npm run start:prod 2>&1 ^| Tee-Object -FilePath '%LOG_FILE%'"
if errorlevel 1 (
  call :fail "The production server window could not be started."
  exit /b 1
)

echo.
echo [5/5] Waiting for service readiness...
call :wait_for_health
if errorlevel 1 (
  echo.
  echo [WARN] Service did not become ready in time. Recent log output:
  powershell -NoProfile -ExecutionPolicy Bypass -Command "if (Test-Path '%LOG_FILE%') { Get-Content -Path '%LOG_FILE%' -Tail 60 }"
  echo.
  call :fail "Startup failed. Check the log above."
  exit /b 1
)

echo.
echo [OK] Frontend and backend started successfully.
call :show_access
start "" "http://127.0.0.1:!APP_PORT!/"
call :maybe_pause
exit /b 0

:detect_port_state
set "PORT_STATE=FREE"
for /f "usebackq delims=" %%I in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "$port = %APP_PORT%; $rootOk = $false; $apiOk = $false; try { $root = Invoke-WebRequest -Uri ('http://127.0.0.1:' + $port + '/') -UseBasicParsing -TimeoutSec 3; if ($root.StatusCode -ge 200 -and $root.StatusCode -lt 500) { $rootOk = $true } } catch {} ; try { $api = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $port + '/api/config/status') -TimeoutSec 3; if ($null -ne $api.auth.required) { $apiOk = $true } } catch {} ; $listener = $null; try { $listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop | Select-Object -First 1 } catch {} ; if ($rootOk -and $apiOk) { 'APP_ALREADY_RUNNING' } elseif ($listener) { 'PORT_BUSY_OTHER' } else { 'FREE' }"`) do set "PORT_STATE=%%I"
exit /b 0

:wait_for_health
powershell -NoProfile -ExecutionPolicy Bypass -Command "$port = %APP_PORT%; $deadline = (Get-Date).AddSeconds(120); $rootOk = $false; $statusOk = $false; while ((Get-Date) -lt $deadline) { try { $root = Invoke-WebRequest -Uri ('http://127.0.0.1:' + $port + '/') -UseBasicParsing -TimeoutSec 5; if ($root.StatusCode -eq 200 -and $root.Content -match '<!doctype html') { $rootOk = $true } } catch {} ; try { $status = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $port + '/api/config/status') -TimeoutSec 5; if ($null -ne $status.auth.required) { $statusOk = $true } } catch {} ; if ($rootOk -and $statusOk) { Write-Output 'OK'; exit 0 } ; Start-Sleep -Seconds 2 } ; Write-Output ('ROOT=' + $rootOk + ';CONFIG=' + $statusOk); exit 1"
exit /b %errorlevel%

:show_access
echo ========================================
echo Frontend : http://127.0.0.1:%APP_PORT%/
echo Backend  : http://127.0.0.1:%APP_PORT%/api/config/status
if defined LOG_FILE echo Log file : %LOG_FILE%
echo ========================================
echo.
exit /b 0

:maybe_pause
if /I "!STARTUP_NO_PAUSE!"=="1" exit /b 0
pause
exit /b 0

:fail
echo.
echo [ERROR] %~1
call :maybe_pause
exit /b 1
