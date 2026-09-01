# resoFlow Windows WSL 2 Uninstallation Script
# Run from PowerShell: .\deploy\windows\uninstall.ps1

[CmdletBinding()]
param(
    [Alias("p")]
    [switch]$PurgeData
)

$ErrorActionPreference = "Stop"

Write-Host "======================================================" -ForegroundColor Cyan
Write-Host "       resoFlow Windows (WSL 2) Uninstaller           " -ForegroundColor Cyan
Write-Host "======================================================" -ForegroundColor Cyan

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRootWin = (Resolve-Path "$scriptDir\..\..").Path
$repoRootWsl = (wsl.exe -e wslpath -u "$repoRootWin").Trim()

$cleanCmd = "cd '$repoRootWsl' && sed -i 's/\r$//' deploy/uninstall.sh 2>/dev/null || true"
wsl.exe -e bash -c "$cleanCmd"

$purgeFlag = if ($PurgeData) { "--purge-data" } else { "" }
$cmd = "cd '$repoRootWsl' && bash deploy/uninstall.sh $purgeFlag"

wsl.exe -e bash -c "$cmd"

# Remove desktop shortcut
$desktopPath = [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::DesktopDirectory)
$shortcutPath = Join-Path $desktopPath "resoFlow.url"
if (Test-Path $shortcutPath) {
    Remove-Item -Force $shortcutPath
    Write-Host "✓ Removed Desktop shortcut: $shortcutPath" -ForegroundColor Green
}

Write-Host "`n✓ resoFlow Windows uninstallation complete." -ForegroundColor Green
