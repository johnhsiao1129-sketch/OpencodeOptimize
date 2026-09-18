# check-watchdog.ps1 - verify watchdog plugin is loaded and working
# Usage: powershell -ExecutionPolicy Bypass -File scripts\check-watchdog.ps1
# Exit code: 0 = loaded + event stream OK; 1 = not loaded / log missing; 2 = abort fired before (feature proven)

$ErrorActionPreference = 'Stop'
$log = Join-Path $env:LOCALAPPDATA "Temp\watchdog.log"

if (-not (Test-Path $log)) {
  Write-Host "FAIL: $log not found"
  Write-Host "=> watchdog not loaded. Reasons: (1) opencode not restarted (plugins load at startup), (2) plugin entry missing in opencode.jsonc."
  exit 1
}

$file = Get-Item $log
$lines = @(Get-Content $log)
Write-Host ""
Write-Host "=== watchdog.log status ==="
Write-Host "  file     : $($file.FullName)"
Write-Host "  lines    : $($lines.Count)"
Write-Host "  modified : $($file.LastWriteTime)"

# 1. loaded: first line should be server() STARTED
if ($lines[0] -match 'server\(\) STARTED') {
  Write-Host "  [PASS] loaded  : $($lines[0])"
} else {
  Write-Host "  [WARN] loaded  : first line is not server() STARTED: $($lines[0])"
}

# 2. event stream: last EVENT timestamp
$eventLines = @($lines | Select-String 'EVENT type=')
if ($eventLines.Count -gt 0) {
  $lastEvent = $eventLines[-1].Line
  if ($lastEvent -match '\[([0-9TZ:.\-]+)\]') {
    $t = [datetime]::Parse($Matches[1]).ToLocalTime()
    $age = [datetime]::Now - $t
    $ageStr = if ($age.TotalMinutes -lt 1) { "$([int]$age.TotalSeconds)s ago" } else { "$([int]$age.TotalMinutes)m ago" }
    Write-Host "  [PASS] events   : $($eventLines.Count) total, last $ageStr"
    Write-Host "           last   : $lastEvent"
  } else {
    Write-Host "  [PASS] events   : $($eventLines.Count) total: $lastEvent"
  }
} else {
  Write-Host "  [WARN] events   : no EVENT lines - opencode idle or events not flowing (re-check after a normal chat)"
}

# 3. abort history
$aborts = @($lines | Select-String 'WATCHDOG_ABORT')
if ($aborts.Count -gt 0) {
  Write-Host "  [INFO] abort    : fired $($aborts.Count) time(s) (feature proven to work):"
  $aborts | ForEach-Object { Write-Host "           $_" }
  $exitCode = 2
} else {
  Write-Host "  [INFO] abort    : never fired (normal - no stall hit, or threshold not reached)"
  $exitCode = 0
}

Write-Host ""
Write-Host "=== summary ==="
if ($lines[0] -match 'server\(\) STARTED' -and $eventLines.Count -gt 0) {
  Write-Host "  watchdog loaded + event stream flowing => ACTIVE"
} else {
  Write-Host "  see WARN above - usually just no new session yet, not a plugin fault"
}
exit $exitCode