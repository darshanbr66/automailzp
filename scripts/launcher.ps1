# Starts or stops ZodiacPatent Attorney Email Automation. Called by start.bat and stop.bat.
#   launcher.ps1 start [-NoBrowser] [-NoDialog]
#   launcher.ps1 stop
param([ValidateSet('start', 'stop')][string]$Action = 'start', [switch]$NoBrowser, [switch]$NoDialog)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Logs = Join-Path $Root 'logs'
# Ports come from backend\.env (PORT and FRONTEND_URL), like the backend and the
# Vite config, so a second copy of the app can run next to this one.
$BackendPort = 4000
$FrontendPort = 5173
$EnvFile = Join-Path $Root 'backend\.env'
if (Test-Path $EnvFile) {
    foreach ($line in Get-Content $EnvFile) {
        if ($line -match '^\s*PORT\s*=\s*(\d+)\s*$') { $BackendPort = [int]$Matches[1] }
        if ($line -match '^\s*FRONTEND_URL\s*=\s*["'']?https?://[^:/]+:(\d+)') { $FrontendPort = [int]$Matches[1] }
    }
}
$AppUrl = "http://localhost:$FrontendPort"
$BackendScript = Join-Path $Root 'backend\src\server.js'
$ViteScript = Join-Path $Root 'frontend\node_modules\vite\bin\vite.js'

Add-Type -AssemblyName System.Windows.Forms | Out-Null

function Show-Error([string]$message) {
    Write-Host $message -ForegroundColor Red
    if (-not $NoDialog) { [System.Windows.Forms.MessageBox]::Show($message, 'ZodiacPatent Attorney Email Automation', 'OK', 'Error') | Out-Null }
    exit 1
}

# Returns $null if nothing listens on the port, otherwise an object telling
# whether the listening process belongs to this application.
function Get-PortOwner([int]$port) {
    $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $conn) { return $null }
    $procId = [int]$conn.OwningProcess
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$procId" -ErrorAction SilentlyContinue
    $cmd = if ($proc) { [string]$proc.CommandLine } else { '' }
    # Our processes are started with absolute script paths inside this folder.
    $ours = $cmd -and ($cmd.IndexOf($Root, [StringComparison]::OrdinalIgnoreCase) -ge 0)
    return [pscustomobject]@{ Pid = $procId; Name = $(if ($proc) { $proc.Name } else { 'unknown' }); Ours = $ours }
}

function Get-LogTail([string]$path) {
    if (Test-Path $path) { return ((Get-Content $path -Tail 8) -join "`n") }
    return ''
}

function Open-Browser {
    $candidates = @(
        (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
        (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
    )
    $chrome = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
    if (-not $chrome) {
        try { $chrome = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe' -ErrorAction Stop).'(default)' } catch { }
    }
    if ($chrome -and (Test-Path $chrome)) {
        Start-Process -FilePath $chrome -ArgumentList $AppUrl
    } else {
        Write-Host 'Google Chrome was not found; opening the default browser instead.'
        Start-Process $AppUrl
    }
}

function Start-Part([string]$label, [int]$port, [string]$script, [string[]]$extraArgs, [string]$workDir, [string]$logName, [string]$node) {
    $owner = Get-PortOwner $port
    if ($owner -and $owner.Ours) {
        Write-Host "$label is already running."
        return $null
    }
    if ($owner) { Show-Error "Port $port is already used by another program ($($owner.Name))." }
    Write-Host "Starting $label..."
    $argList = @("`"$script`"") + $extraArgs
    return Start-Process -FilePath $node -ArgumentList $argList -WorkingDirectory $workDir -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $Logs "$logName.log") -RedirectStandardError (Join-Path $Logs "$logName-error.log")
}

function Start-App {
    $node = (Get-Command node -ErrorAction SilentlyContinue).Source
    if (-not $node) { Show-Error 'Node.js is not installed or not on PATH. Install Node.js LTS from https://nodejs.org and run setup.bat.' }
    if (-not (Test-Path (Join-Path $Root 'backend\node_modules')) -or -not (Test-Path $ViteScript)) {
        Show-Error 'The application has not been set up yet. Please run scripts\setup.bat first.'
    }
    New-Item -ItemType Directory -Force $Logs | Out-Null

    # Check both ports before starting anything.
    foreach ($port in @($BackendPort, $FrontendPort)) {
        $owner = Get-PortOwner $port
        if ($owner -and -not $owner.Ours) {
            Show-Error "Port $port is already used by another program ($($owner.Name), process $($owner.Pid)).`n`nZodiacPatent Attorney Email Automation needs ports $BackendPort and $FrontendPort. Close the other program (for example another development server) and try again."
        }
    }

    $backend = Start-Part 'backend' $BackendPort $BackendScript @() (Join-Path $Root 'backend') 'backend' $node
    $frontend = Start-Part 'frontend' $FrontendPort $ViteScript @('--port', "$FrontendPort", '--strictPort') (Join-Path $Root 'frontend') 'frontend' $node

    Write-Host 'Waiting for the application to be ready...'
    $deadline = (Get-Date).AddSeconds(60)
    while ($true) {
        $b = Get-PortOwner $BackendPort
        $f = Get-PortOwner $FrontendPort
        if ($b -and $b.Ours -and $f -and $f.Ours) { break }
        if ($backend -and $backend.HasExited) {
            Show-Error ("The backend stopped unexpectedly. Details from logs\backend-error.log:`n`n" + (Get-LogTail (Join-Path $Logs 'backend-error.log')))
        }
        if ($frontend -and $frontend.HasExited) {
            Show-Error ("The frontend stopped unexpectedly. Details from logs\frontend-error.log:`n`n" + (Get-LogTail (Join-Path $Logs 'frontend-error.log')))
        }
        if ((Get-Date) -gt $deadline) { Show-Error 'The application did not start within 60 seconds. Check the files in the logs folder, or run stop.bat and try again.' }
        Start-Sleep -Milliseconds 500
    }
    Write-Host "Application is running at $AppUrl"
    if (-not $NoBrowser) { Open-Browser }
}

function Stop-App {
    $stopped = 0
    foreach ($port in @($BackendPort, $FrontendPort)) {
        $owner = Get-PortOwner $port
        if (-not $owner) { continue }
        # Only stop this application's own processes, never another program using the port.
        if ($owner.Ours) {
            Stop-Process -Id $owner.Pid -Force
            Write-Host "Stopped process on port $port."
            $stopped++
        } else {
            Write-Host "Port $port is used by another program ($($owner.Name)); it was left running." -ForegroundColor Yellow
        }
    }
    if ($stopped -eq 0) { Write-Host 'ZodiacPatent Attorney Email Automation was not running.' } else { Write-Host 'ZodiacPatent Attorney Email Automation has been stopped.' }
}

if ($Action -eq 'start') { Start-App } else { Stop-App }
