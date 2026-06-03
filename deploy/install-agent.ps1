<#
  install-agent.ps1 — install/update the Homelab agent on Windows.

  Mirrors deploy/install-agent.sh (Linux). Installs the agent under a fixed
  dir, builds it, writes a .env, and registers a hidden Scheduled Task that
  runs at logon and auto-restarts. No admin required (runs in the current
  user's context — so it runs while you're logged in).

  Prereqs: Node.js LTS + Git in PATH (winget install OpenJS.NodeJS.LTS Git.Git).

  Usage (PowerShell):
    .\install-agent.ps1 -DashboardUrl https://proxmox-01.<tailnet>.ts.net `
                         -AgentApiKey <key>  [-ServerName MyLaptop]

  For roaming devices use the Tailscale HTTPS dashboard URL and install
  Tailscale so it reports from anywhere; on the LAN, http://192.168.1.21:3000
  also works (only while home).
#>
param(
  [Parameter(Mandatory = $true)][string]$DashboardUrl,
  [Parameter(Mandatory = $true)][string]$AgentApiKey,
  [string]$ServerName = $env:COMPUTERNAME,
  [string]$RepoUrl    = "https://github.com/Ombelll/Homelab.git",
  [string]$InstallDir = "C:\homelab-agent"
)
$ErrorActionPreference = "Stop"
function Info($m) { Write-Host "[install] $m" }

# --- 1. prereqs ------------------------------------------------------------
foreach ($c in @("node", "git", "npm")) {
  if (-not (Get-Command $c -ErrorAction SilentlyContinue)) {
    throw "$c not found in PATH. Install Node.js LTS + Git first (winget install OpenJS.NodeJS.LTS Git.Git)."
  }
}
$node = (Get-Command node).Source
Info ("node {0}, git present" -f (node --version))

# --- 2. code ---------------------------------------------------------------
if (Test-Path (Join-Path $InstallDir ".git")) {
  Info "updating existing checkout in $InstallDir"
  git -C $InstallDir fetch --quiet origin
  git -C $InstallDir reset --hard --quiet origin/main
}
else {
  Info "cloning $RepoUrl -> $InstallDir"
  if (Test-Path $InstallDir) { Remove-Item -Recurse -Force $InstallDir }
  git clone --quiet $RepoUrl $InstallDir
}

# --- 3. build --------------------------------------------------------------
$agentDir = Join-Path $InstallDir "agent"
Push-Location $agentDir
try {
  Info "installing dependencies (npm ci)"
  npm ci --silent
  Info "building (npm run build)"
  npm run build --silent
  if (-not (Test-Path (Join-Path $agentDir "dist\index.js"))) {
    throw "build did not produce dist\index.js"
  }
}
finally { Pop-Location }

# --- 4. config (.env holds the key; dotenv loads it from the agent dir) ----
$envPath = Join-Path $agentDir ".env"
"DASHBOARD_URL=$DashboardUrl`r`nAGENT_API_KEY=$AgentApiKey`r`nAGENT_SERVER_NAME=$ServerName`r`n" |
  Set-Content -Path $envPath -Encoding ASCII -NoNewline
# Restrict to current user + SYSTEM + Administrators (it contains the agent key).
icacls $envPath /inheritance:r /grant:r "$($env:USERNAME):(R,W)" "SYSTEM:(R)" "Administrators:(R)" *> $null
Info "wrote $envPath (restricted ACL)"

# --- 5. scheduled task (hidden, at logon, auto-restart) --------------------
$taskName = "HomelabAgent"
$psExe = (Get-Command powershell).Source
$inner = "& '$node' dist\index.js"
$arg = "-WindowStyle Hidden -ExecutionPolicy Bypass -NonInteractive -Command `"$inner`""
$action  = New-ScheduledTaskAction -Execute $psExe -Argument $arg -WorkingDirectory $agentDir
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
  -Settings $settings -Principal $principal | Out-Null
Info "registered Scheduled Task '$taskName' (hidden, runs at logon, auto-restart)"

# --- 6. start now ----------------------------------------------------------
Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 4
$state = (Get-ScheduledTask -TaskName $taskName).State
Info "task state: $state"
Info "Done. Look for '$ServerName' in the dashboard Servers list within ~30s."
