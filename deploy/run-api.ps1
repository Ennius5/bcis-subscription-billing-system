# Keeps the BCIS API running on the server PC. Started at boot by the "BCIS API" scheduled task
# (install-server.ps1). If the API stops for any reason (a crash, a fatal error it logged, a
# restore that failed hard), it is started again after 5 seconds and the stop is recorded in
# apps\api\logs\keeper.log. PostgreSQL has already rolled back anything half-done.
param(
    [Parameter(Mandatory = $true)][string]$Node
)

$api = Join-Path (Split-Path -Parent $PSScriptRoot) "apps\api"
$logDir = Join-Path $api "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$keeperLog = Join-Path $logDir "keeper.log"
Set-Location $api

while ($true) {
    Add-Content -Path $keeperLog -Value "$(Get-Date -Format s) starting the API"
    & $Node --enable-source-maps "dist\server.js"
    Add-Content -Path $keeperLog -Value "$(Get-Date -Format s) the API stopped (exit code $LASTEXITCODE); restarting in 5 seconds"
    Start-Sleep -Seconds 5
}
