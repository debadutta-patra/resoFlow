# resoFlow Windows WSL 2 Deployment Script
# Run from PowerShell: .\deploy\windows\install.ps1

[CmdletBinding()]
param(
    [Alias("p")]
    [string]$Port = "8080",
    [string]$ApiPort = "",
    [switch]$Lan,
    [string]$Bind = "",
    [Alias("d")]
    [string]$DataDir = "",
    [string]$AdminEmail = "",
    [string]$AdminPassword = "",
    [string]$AdminName = "Administrator",
    [switch]$SkipAdmin,
    [Alias("y")]
    [switch]$NonInteractive,
    [switch]$Help
)

$ErrorActionPreference = "Stop"

if ($Help) {
    Write-Host @"
Usage: .\deploy\windows\install.ps1 [OPTIONS]

Options:
  -p, -Port PORT           Base port for resoFlow services (default: 8080)
      -ApiPort PORT        Override internal backend API port
      -Lan                 Allow access over local network (0.0.0.0)
      -Bind IP             Bind IP address for Web UI (default: 127.0.0.1)
  -d, -DataDir PATH        Storage directory (e.g. C:\Users\<Name>\resoflow\projects)
      -AdminEmail EMAIL    Initial administrator account email
      -AdminPassword PWD   Initial administrator account password
      -AdminName NAME      Initial administrator full name (default: "Administrator")
      -SkipAdmin           Skip administrator account creation
  -y, -NonInteractive      Run non-interactively without prompt stops
  -Help                    Show this help message

Examples:
  .\deploy\windows\install.ps1
  .\deploy\windows\install.ps1 -Port 50000 -DataDir "C:\resoflow_data"
  .\deploy\windows\install.ps1 -y -Port 8080 -AdminEmail admin@lab.org -AdminPassword secret
"@
    exit 0
}

Write-Host "======================================================" -ForegroundColor Cyan
Write-Host "        resoFlow Windows (WSL 2) Installer            " -ForegroundColor Cyan
Write-Host "======================================================" -ForegroundColor Cyan

# 1. Verify WSL 2 availability
try {
    $wslStatus = wsl.exe --status 2>&1
} catch {
    Write-Host "Error: Windows Subsystem for Linux (WSL 2) is not installed." -ForegroundColor Red
    Write-Host "Please install WSL 2 by running: wsl --install" -ForegroundColor Yellow
    exit 1
}

# 2. Check WSL systemd configuration
Write-Host "`n[1/4] Checking WSL 2 systemd support..." -ForegroundColor Blue
$wslConfCheck = wsl.exe -e sh -c "grep -E '^\s*systemd\s*=\s*true' /etc/wsl.conf 2>/dev/null || true"
if (-not $wslConfCheck) {
    Write-Host "Enabling systemd in /etc/wsl.conf..." -ForegroundColor Yellow
    wsl.exe -u root -e sh -c "mkdir -p /etc && (grep -q '\[boot\]' /etc/wsl.conf 2>/dev/null || echo '[boot]' >> /etc/wsl.conf) && (grep -q 'systemd=true' /etc/wsl.conf 2>/dev/null || echo 'systemd=true' >> /etc/wsl.conf)"
    Write-Host "Systemd configured in WSL 2. Restarting WSL instance..." -ForegroundColor Green
    wsl.exe --shutdown
    Start-Sleep -Seconds 3
}

# 3. Resolve repo path in WSL
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRootWin = (Resolve-Path "$scriptDir\..\..").Path
$repoRootWsl = (wsl.exe -e wslpath -u "$repoRootWin").Trim()

# 4. Construct argument string for install.sh
$argsList = @()
if ($Port) { $argsList += "-p $Port" }
if ($ApiPort) { $argsList += "--api-port $ApiPort" }
if ($Lan) { $argsList += "--lan" }
if ($Bind) { $argsList += "--bind $Bind" }
if ($DataDir) {
    # Convert Windows data dir path to WSL path if provided
    $dataDirWsl = (wsl.exe -e wslpath -u "$DataDir").Trim()
    $argsList += "-d `"$dataDirWsl`""
}
if ($AdminEmail) { $argsList += "--admin-email `"$AdminEmail`"" }
if ($AdminPassword) { $argsList += "--admin-password `"$AdminPassword`"" }
if ($AdminName) { $argsList += "--admin-name `"$AdminName`"" }
if ($SkipAdmin) { $argsList += "--skip-admin" }
if ($NonInteractive) { $argsList += "-y" }

$argsString = $argsList -join " "

# 5. Execute install.sh inside WSL 2
Write-Host "`n[2/4] Running resoFlow deployment inside WSL 2..." -ForegroundColor Blue
$cmd = "cd '$repoRootWsl' && bash deploy/install.sh $argsString"
wsl.exe -e bash -c "$cmd"
if ($LASTEXITCODE -ne 0) {
    Write-Host "Error: Installation failed inside WSL 2." -ForegroundColor Red
    exit $LASTEXITCODE
}

# 6. Create Desktop Shortcut
Write-Host "`n[3/4] Creating Windows Desktop Shortcut..." -ForegroundColor Blue
$targetUrl = "http://127.0.0.1:$Port"
$desktopPath = [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::DesktopDirectory)
$shortcutPath = Join-Path $desktopPath "resoFlow.url"

$shortcutContent = @"
[InternetShortcut]
URL=$targetUrl
IconIndex=0
"@
Set-Content -Path $shortcutPath -Value $shortcutContent -Encoding ASCII
Write-Host "✓ Desktop shortcut created: $shortcutPath" -ForegroundColor Green

Write-Host "`n======================================================" -ForegroundColor Green
Write-Host "✓ resoFlow is successfully installed and running!" -ForegroundColor Green
Write-Host "======================================================" -ForegroundColor Green
Write-Host "Access resoFlow in your web browser:" -ForegroundColor Cyan
Write-Host "  $targetUrl`n" -ForegroundColor Green
