# One-time setup of the BCIS server PC (docs/deployment-guide.md, section 3).
# Run in PowerShell **as Administrator**, from the repository folder:
#
#   powershell -ExecutionPolicy Bypass -File deploy\install-server.ps1
#
# It registers two scheduled tasks and one firewall rule. Running it again replaces them.
#   "BCIS API"     starts the API at boot (before anyone signs in) and keeps it running
#   "BCIS Backup"  makes and verifies a backup every day at -BackupTime
#   Firewall       lets the office LAN (and only the LAN) reach the API port
param(
    [string]$BackupTime = "21:00",
    [int]$Port = 3000
)

$ErrorActionPreference = "Stop"

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Run this script in PowerShell opened with 'Run as administrator'."
}

$repo = Split-Path -Parent $PSScriptRoot
$api = Join-Path $repo "apps\api"
$node = (Get-Command node).Source

if (-not (Test-Path (Join-Path $api ".env"))) {
    throw "apps\api\.env is missing. Create it from .env.example first (guide section 3.3)."
}
if (-not (Test-Path (Join-Path $api "dist\server.js"))) {
    throw "The API is not built. Run: pnpm --filter ./apps/api build"
}

# Both tasks run as SYSTEM, so they work with nobody signed in to the server PC.
$system = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest

# 1. The API, started at boot and kept running by run-api.ps1.
$keeper = Join-Path $PSScriptRoot "run-api.ps1"
$apiAction = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$keeper`" -Node `"$node`"" `
    -WorkingDirectory $api
$apiSettings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName "BCIS API" -Description "BCIS billing API server (keeps itself running)" `
    -Action $apiAction -Trigger (New-ScheduledTaskTrigger -AtStartup) -Settings $apiSettings `
    -Principal $system -Force | Out-Null
Write-Host "Registered task 'BCIS API' (starts at boot)."

# 2. The daily backup: same code as 'Back up now'; exit code 1 shows as a failed last run.
$backupAction = New-ScheduledTaskAction -Execute $node -Argument "--enable-source-maps dist\backup.js" -WorkingDirectory $api
$backupSettings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 2) -StartWhenAvailable `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName "BCIS Backup" -Description "Daily verified BCIS backup" `
    -Action $backupAction -Trigger (New-ScheduledTaskTrigger -Daily -At $BackupTime) -Settings $backupSettings `
    -Principal $system -Force | Out-Null
Write-Host "Registered task 'BCIS Backup' (daily at $BackupTime)."

# 3. Firewall: the API port, for PCs on the same subnet only, on private/domain networks only.
Get-NetFirewallRule -DisplayName "BCIS API (LAN)" -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName "BCIS API (LAN)" -Direction Inbound -Protocol TCP -LocalPort $Port `
    -Action Allow -Profile Domain, Private -RemoteAddress LocalSubnet | Out-Null
Write-Host "Opened TCP port $Port to the local subnet (private and domain networks only)."

# Start now and confirm it answers.
Start-ScheduledTask -TaskName "BCIS API"
$health = $null
for ($i = 0; $i -lt 30 -and -not $health; $i++) {
    Start-Sleep -Seconds 1
    try { $health = Invoke-RestMethod -Uri "http://localhost:$Port/health/db" -TimeoutSec 2 } catch { }
}
if (-not $health) {
    throw "The API did not answer on port $Port. Check apps\api\logs (keeper.log and today's api.*.log)."
}
Write-Host "The API is running; database: $($health.database)."

$addresses = Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" } |
    ForEach-Object { $_.IPAddress }
Write-Host ""
Write-Host "On each office PC, enter one of these as the server address on the sign-in screen:"
foreach ($address in $addresses) { Write-Host "  http://${address}:$Port" }
