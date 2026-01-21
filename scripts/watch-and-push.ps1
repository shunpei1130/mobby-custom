$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $repoRoot

$debounceMs = 800
$pending = $false
$busy = $false

function ShouldIgnorePath([string]$fullPath) {
  if (-not $fullPath) { return $true }
  return $fullPath -match "\\\.git\\"
}

function GetPendingChanges {
  $status = git status --porcelain
  return -not [string]::IsNullOrWhiteSpace($status)
}

$timer = New-Object System.Timers.Timer
$timer.Interval = $debounceMs
$timer.AutoReset = $false
$timer.add_Elapsed({
  if (-not $pending) { return }
  if ($busy) { return }
  $pending = $false
  $busy = $true
  try {
    if (-not (GetPendingChanges)) { return }
    git add -A | Out-Null
    $stamp = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
    git commit -m "Auto save $stamp" | Out-Null
    git push | Out-Null
    Write-Host "Auto push done: $stamp"
  } catch {
    Write-Host "Auto push failed: $($_.Exception.Message)"
  } finally {
    $busy = $false
  }
})

$watcher = New-Object System.IO.FileSystemWatcher
$watcher.Path = $repoRoot
$watcher.Filter = "*.*"
$watcher.IncludeSubdirectories = $true
$watcher.EnableRaisingEvents = $true

$action = {
  $fullPath = $Event.SourceEventArgs.FullPath
  if (ShouldIgnorePath $fullPath) { return }
  $pending = $true
  $timer.Stop()
  $timer.Start()
}

Register-ObjectEvent $watcher Changed -Action $action | Out-Null
Register-ObjectEvent $watcher Created -Action $action | Out-Null
Register-ObjectEvent $watcher Deleted -Action $action | Out-Null
Register-ObjectEvent $watcher Renamed -Action $action | Out-Null

Write-Host "Watching for changes in $repoRoot"
Write-Host "Press Ctrl+C to stop."
while ($true) { Start-Sleep -Seconds 1 }
