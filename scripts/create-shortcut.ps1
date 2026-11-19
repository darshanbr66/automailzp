# Creates desktop shortcuts to start and stop ZodiacPatent Attorney Email Automation.
# Run once:  powershell -ExecutionPolicy Bypass -File scripts\create-shortcut.ps1

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Desktop = [Environment]::GetFolderPath('Desktop')   # also works with OneDrive desktops
$Shell = New-Object -ComObject WScript.Shell

$chrome = @(
    (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
    (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1

function New-AppShortcut([string]$name, [string]$target, [string]$description, [string]$icon) {
    $path = Join-Path $Desktop "$name.lnk"
    $lnk = $Shell.CreateShortcut($path)
    $lnk.TargetPath = $target
    $lnk.WorkingDirectory = $Root
    $lnk.Description = $description
    $lnk.WindowStyle = 7   # start minimized
    if ($icon) { $lnk.IconLocation = $icon }
    $lnk.Save()
    Write-Host "Created: $path"
}

# Own names, so these shortcuts never replace the original (file-based) app's
# shortcuts, which use the names without "(MongoDB)".
$StartName = 'ZodiacPatent Attorney Email (MongoDB)'
$StopName = 'Stop ZodiacPatent Attorney Email (MongoDB)'

# Remove shortcuts with the old names, but only if they point into THIS folder
# ("<Root>\", so the original app in a sibling folder is never touched).
$RootPrefix = $Root.TrimEnd('\') + '\'
foreach ($old in @('ZodiacPatent Attorney Email', 'Stop ZodiacPatent Attorney Email', 'Attorney Email Automation', 'Stop Attorney Email Automation', 'Zodiac Patent Attorney Email', 'Stop Zodiac Patent Attorney Email')) {
    $oldPath = Join-Path $Desktop "$old.lnk"
    if (Test-Path $oldPath) {
        $target = $Shell.CreateShortcut($oldPath).TargetPath
        if ($target -and $target.StartsWith($RootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
            Remove-Item $oldPath -Force
            Write-Host "Removed old shortcut: $oldPath"
        }
    }
}

$startIcon = if ($chrome) { "$chrome,0" } else { "$env:SystemRoot\System32\shell32.dll,13" }
New-AppShortcut $StartName (Join-Path $Root 'scripts\start.bat') 'Start ZodiacPatent Attorney Email Automation and open it in Chrome' $startIcon
New-AppShortcut $StopName (Join-Path $Root 'scripts\stop.bat') 'Stop ZodiacPatent Attorney Email Automation' "$env:SystemRoot\System32\shell32.dll,27"

Write-Host ''
Write-Host "Done. Double-click ""$StartName"" on your desktop to start the app."
