# Runs the MT5 sidecar and restarts it if it exits.
# Register it with Task Scheduler (see README.md): the MT5 terminal needs an
# interactive desktop, which a Windows service does not have.
param(
    [string]$Dir = (Split-Path -Parent $PSScriptRoot),
    [string]$Python = "python"
)

Set-Location $Dir
$log = Join-Path $Dir "sidecar.log"
while ($true) {
    "$(Get-Date -Format o) starting sidecar" | Out-File -Append $log
    & $Python server.py *>> $log
    "$(Get-Date -Format o) sidecar exited with $LASTEXITCODE; restarting in 10s" | Out-File -Append $log
    Start-Sleep -Seconds 10
}
