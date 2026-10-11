# Removes what install-server.ps1 set up (tasks and firewall rule). Run as Administrator.
# The database, backups, logs and proof images are NOT touched.
$ErrorActionPreference = "Stop"

foreach ($task in @("BCIS API", "BCIS Backup")) {
    if (Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue) {
        Stop-ScheduledTask -TaskName $task
        Unregister-ScheduledTask -TaskName $task -Confirm:$false
        Write-Host "Removed task '$task'."
    }
}
Get-NetFirewallRule -DisplayName "BCIS API (LAN)" -ErrorAction SilentlyContinue | Remove-NetFirewallRule
Write-Host "Removed the firewall rule (if it existed)."
