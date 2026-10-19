<#
.SYNOPSIS
    Installs Ferry Tracker as a boot-start service on a Windows host.

.DESCRIPTION
    Clones or updates the repository, builds it, writes the production .env.local,
    and registers two scheduled tasks: the server itself (at startup, as SYSTEM)
    and a weekly SQLite backup. Also opens the firewall port and stops the machine
    from sleeping.

    Safe to re-run. Every step checks for the existing state first.

.PARAMETER StagedEnvFile
    A .env.local to copy WSDOT_API_ACCESS_CODE out of. CATCH_TOKEN is copied too when
    present. Only those two are taken; every other setting is written fresh. Neither
    value is ever printed.

.EXAMPLE
    .\Install-FerryTracker.ps1 -Verbose

.EXAMPLE
    .\Install-FerryTracker.ps1 -SkipClone -SkipTests
#>
[CmdletBinding()]
param(
    [string] $InstallRoot = 'C:\Files\Dev\main\ferry-tracker',
    [string] $DataDir = 'C:\ProgramData\ferry-tracker',
    [string] $StagedEnvFile = (Join-Path $PSScriptRoot '.env.local'),
    [int]    $Port = 8787,
    [string] $RepoUrl = 'https://github.com/purduepete/ferry-tracker.git',
    [string] $Branch = 'main',
    [string] $NodeExe = 'C:\Files\ScoopApps\apps\nodejs\current\node.exe',
    [int]    $RetentionDays = 180,
    [int]    $MinFreeDiskMb = 5120,
    [switch] $SkipClone,
    [switch] $SkipTests,
    [switch] $KeepStagedEnv
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$TaskName = 'FerryTracker'
$BackupTaskName = 'FerryTracker-Backup'
$WatchdogTaskName = 'FerryTracker-Watchdog'
$TunnelServiceName = 'cloudflared'
$FirewallRuleName = 'Ferry Tracker (TCP 8787)'

$script:step = 0
function Write-Step { param([string] $Message) $script:step++; Write-Host ("`n[{0}] {1}" -f $script:step, $Message) -ForegroundColor Cyan }
function Write-Ok { param([string] $Message) Write-Host ("      OK    {0}" -f $Message) -ForegroundColor Green }
function Write-Info { param([string] $Message) Write-Host ("      ..    {0}" -f $Message) -ForegroundColor DarkGray }
function Write-Warn { param([string] $Message) Write-Host ("      WARN  {0}" -f $Message) -ForegroundColor Yellow }

function Invoke-Checked {
    param([string] $FilePath, [string[]] $Arguments, [string] $WorkingDirectory, [string] $What)
    Write-Info ("{0} {1}" -f $FilePath, ($Arguments -join ' '))
    Push-Location $WorkingDirectory
    try {
        & $FilePath @Arguments
        if ($LASTEXITCODE -ne 0) { throw "$What failed with exit code $LASTEXITCODE." }
    }
    finally { Pop-Location }
}

# --- 1. Preflight ------------------------------------------------------------

Write-Step 'Preflight'

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not ([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'This script must run from an elevated PowerShell session. Right-click PowerShell and choose "Run as administrator".'
}
Write-Ok ("elevated as {0}" -f $identity.Name)

if (-not (Test-Path -LiteralPath $NodeExe)) { throw "node.exe not found at $NodeExe. Pass -NodeExe with the correct path." }
$nodeVersion = & $NodeExe --version
$nodeMajor = [int]($nodeVersion.TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 22) { throw "Node $nodeVersion is too old. The workspace requires Node 22 or newer." }
Write-Ok ("node {0} at {1}" -f $nodeVersion, $NodeExe)

$npmCmd = $null
# An elevated session may not carry the Scoop shims on PATH, so prefer the npm beside node.exe.
$npmBesideNode = Join-Path (Split-Path -Parent $NodeExe) 'npm.cmd'
if (Test-Path -LiteralPath $npmBesideNode) { $npmCmd = $npmBesideNode }
else {
    $found = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $found) { $found = Get-Command npm -ErrorAction SilentlyContinue }
    if ($found) { $npmCmd = $found.Source }
}
if (-not $npmCmd) { throw "npm was not found beside $NodeExe or on PATH for this elevated session." }
Write-Ok ("npm at {0}" -f $npmCmd)

$gitCmd = Get-Command git -ErrorAction SilentlyContinue
if (-not $gitCmd -and -not $SkipClone) { throw 'git was not found on PATH. Install Git, or clone manually and re-run with -SkipClone.' }
if ($gitCmd) { Write-Ok ("git at {0}" -f $gitCmd.Source) }

$freeMb = [math]::Round((Get-PSDrive -Name ($InstallRoot.Substring(0, 1))).Free / 1MB)
if ($freeMb -lt ($MinFreeDiskMb + 2048)) {
    Write-Warn ("only {0} MB free on {1}: capture stops writing archives below {2} MB" -f $freeMb, $InstallRoot.Substring(0, 1), $MinFreeDiskMb)
}
else { Write-Ok ("{0} MB free on drive {1}" -f $freeMb, $InstallRoot.Substring(0, 1)) }

$portOwner = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
$existingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($portOwner -and -not $existingTask) {
    throw "Port $Port is already in use by PID $($portOwner[0].OwningProcess) and it is not a Ferry Tracker task. Free the port or pass a different -Port."
}

# --- 2. Source ---------------------------------------------------------------

Write-Step 'Source checkout'

if ($SkipClone) {
    if (-not (Test-Path -LiteralPath (Join-Path $InstallRoot 'package.json'))) { throw "-SkipClone was given but $InstallRoot does not contain a checkout." }
    Write-Ok 'skipped by request'
}
elseif (Test-Path -LiteralPath (Join-Path $InstallRoot '.git')) {
    Invoke-Checked -FilePath $gitCmd.Source -Arguments @('fetch', 'origin', $Branch) -WorkingDirectory $InstallRoot -What 'git fetch'
    # A production box never carries local commits, so hard reset is the honest update.
    Invoke-Checked -FilePath $gitCmd.Source -Arguments @('reset', '--hard', "origin/$Branch") -WorkingDirectory $InstallRoot -What 'git reset'
    Write-Ok ("updated {0} to origin/{1}" -f $InstallRoot, $Branch)
}
else {
    $parent = Split-Path -Parent $InstallRoot
    if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
    Invoke-Checked -FilePath $gitCmd.Source -Arguments @('clone', '--branch', $Branch, $RepoUrl, $InstallRoot) -WorkingDirectory $parent -What 'git clone'
    Write-Ok ("cloned into {0}" -f $InstallRoot)
}

$head = & $gitCmd.Source -C $InstallRoot rev-parse --short HEAD
Write-Ok ("HEAD is {0}" -f $head)

# --- 3. Configuration --------------------------------------------------------

Write-Step 'Configuration'

$envPath = Join-Path $InstallRoot '.env.local'
# The script gets run from the staging folder and from the checkout's own deploy folder,
# so look in both plus the repo root rather than trusting one path.
$candidates = @(
    $envPath
    $StagedEnvFile
    (Join-Path $PSScriptRoot '.env.local')
    (Join-Path (Split-Path -Parent $PSScriptRoot) '.env.local')
    'C:\Files\Dev\main\_ferry-deploy\.env.local'
) | Where-Object { $_ } | Select-Object -Unique

# Last, not first, on every key below: dotenv keeps the last occurrence, so reading the first one
# from a file that picked up a duplicate would rewrite .env.local with a value the server never used.
$accessCodeLine = $null
$accessCodeFile = $null
foreach ($candidate in $candidates) {
    if (-not (Test-Path -LiteralPath $candidate)) { Write-Info ("no file at {0}" -f $candidate); continue }
    $accessCodeLine = Get-Content -LiteralPath $candidate | Where-Object { $_ -match '^\s*WSDOT_API_ACCESS_CODE\s*=\s*\S' } | Select-Object -Last 1
    if ($accessCodeLine) { $accessCodeFile = $candidate; Write-Ok ("access code carried over from {0}" -f $candidate); break }
    Write-Warn ("{0} exists but has no WSDOT_API_ACCESS_CODE line" -f $candidate)
}
if (-not $accessCodeLine) {
    throw ("No WSDOT_API_ACCESS_CODE found. Checked:`n  " + ($candidates -join "`n  ") + "`nPut a line reading WSDOT_API_ACCESS_CODE=<key> in any one of those and re-run.")
}

# The watch token is optional: with no line here the server 404s /api/catch. A staged file wins
# over the installed one so a rotation is a drop-and-rerun, and the installed file is the fallback
# so an ordinary redeploy does not silently wipe the token the Shortcut is already using.
$catchTokenLine = $null
foreach ($candidate in (@($candidates | Where-Object { $_ -ne $envPath }) + $envPath)) {
    if (-not (Test-Path -LiteralPath $candidate)) { continue }
    $catchTokenLine = Get-Content -LiteralPath $candidate | Where-Object { $_ -match '^\s*CATCH_TOKEN\s*=\s*\S' } | Select-Object -Last 1
    if ($catchTokenLine) { Write-Ok ("watch token carried over from {0}" -f $candidate); break }
}
if (-not $catchTokenLine) { Write-Info 'no CATCH_TOKEN found, so /api/catch will return 404' }

$lines = @(
    '# Written by deploy/Install-FerryTracker.ps1. Hand edits survive only until the next run.'
    'DATA_SOURCE=live'
    $accessCodeLine.Trim()
    'ENABLE_RAW_INSPECTOR=true'
    "HOST=0.0.0.0"
    "PORT=$Port"
    ''
    'CAPTURE_ENABLED=true'
    "CAPTURE_DATA_DIR=$DataDir"
    "CAPTURE_DB_PATH=$(Join-Path $DataDir 'ferry-capture.db')"
    "CAPTURE_ARCHIVE_DIR=$(Join-Path $DataDir 'raw')"
    "CAPTURE_RETENTION_DAYS=$RetentionDays"
    "CAPTURE_MIN_FREE_DISK_MB=$MinFreeDiskMb"
    'CAPTURE_STATUS_ENABLED=true'
)
if ($catchTokenLine) { $lines += @('', $catchTokenLine.Trim()) }
# Windows PowerShell 5.1 writes a BOM with -Encoding utf8, and dotenv should never see one.
[IO.File]::WriteAllLines($envPath, [string[]]$lines, (New-Object Text.UTF8Encoding($false)))
Write-Ok ("wrote {0}" -f $envPath)

if (-not $KeepStagedEnv -and $accessCodeFile -and ((Resolve-Path $accessCodeFile).Path -ne (Resolve-Path $envPath).Path)) {
    Remove-Item -LiteralPath $accessCodeFile -Force
    Write-Ok ("removed the staged copy of the access code at {0}" -f $accessCodeFile)
}

foreach ($dir in @($DataDir, (Join-Path $DataDir 'raw'), (Join-Path $DataDir 'backups'))) {
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null; Write-Ok ("created {0}" -f $dir) }
    else { Write-Ok ("{0} already exists" -f $dir) }
}

# --- 4. Build ----------------------------------------------------------------

Write-Step 'Install and build'

# npm ci unlinks node_modules first, and the running server holds better-sqlite3's native
# .node open, so on a re-run the install dies with EPERM unless the task is stopped first.
$serverWasRunning = [bool](Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)
if ($serverWasRunning) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    $freed = $false
    foreach ($attempt in 1..20) {
        Start-Sleep -Seconds 1
        if (-not (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)) { $freed = $true; break }
    }
    if ($freed) { Write-Ok ("stopped '{0}' so its native modules can be replaced" -f $TaskName) }
    else { Write-Warn ("'{0}' was asked to stop but port {1} is still held. npm ci may fail on a locked file." -f $TaskName, $Port) }
}

try {
    Invoke-Checked -FilePath $npmCmd -Arguments @('ci') -WorkingDirectory $InstallRoot -What 'npm ci'
    Write-Ok 'dependencies installed'

    Invoke-Checked -FilePath $npmCmd -Arguments @('run', 'build') -WorkingDirectory $InstallRoot -What 'npm run build'
    foreach ($artifact in @('shared\dist', 'server\dist\index.js', 'frontend\dist\index.html')) {
        if (-not (Test-Path -LiteralPath (Join-Path $InstallRoot $artifact))) { throw "Build finished but $artifact is missing." }
    }
    Write-Ok 'shared, server, and frontend built'

    if ($SkipTests) { Write-Ok 'tests skipped by request' }
    else {
        Invoke-Checked -FilePath $npmCmd -Arguments @('test') -WorkingDirectory $InstallRoot -What 'npm test'
        Write-Ok 'test suite passed'
    }
}
catch {
    # Leaving the box offline because a build broke is worse than serving the previous version.
    if ($serverWasRunning) {
        Write-Warn ("build failed, restarting '{0}' on the previous build" -f $TaskName)
        Start-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    }
    throw
}

# --- 5. Host settings --------------------------------------------------------

Write-Step 'Host settings'

if (Get-NetFirewallRule -DisplayName $FirewallRuleName -ErrorAction SilentlyContinue) {
    Set-NetFirewallRule -DisplayName $FirewallRuleName -LocalPort $Port -Profile Private -Enabled True | Out-Null
    Write-Ok ("firewall rule '{0}' updated" -f $FirewallRuleName)
}
else {
    New-NetFirewallRule -DisplayName $FirewallRuleName -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port -Profile Private | Out-Null
    Write-Ok ("firewall rule '{0}' created for the Private profile" -f $FirewallRuleName)
}

foreach ($setting in @('standby-timeout-ac', 'hibernate-timeout-ac', 'disk-timeout-ac')) {
    & powercfg.exe /change $setting 0 | Out-Null
}
Write-Ok 'sleep, hibernate, and disk timeouts disabled on AC power'

# --- 6. Scheduled tasks ------------------------------------------------------

Write-Step 'Scheduled tasks'

$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest

$serverTrigger = New-ScheduledTaskTrigger -AtStartup
# Tailscale and DHCP are not up the instant the service control manager is.
$serverTrigger.Delay = 'PT30S'
$serverAction = New-ScheduledTaskAction -Execute $NodeExe -Argument 'server\dist\index.js' -WorkingDirectory $InstallRoot
$serverSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -RestartInterval (New-TimeSpan -Minutes 1) -RestartCount 999 -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $TaskName -Principal $principal -Trigger $serverTrigger -Action $serverAction -Settings $serverSettings `
    -Description 'Ferry Tracker WSDOT explorer and capture loop.' -Force | Out-Null
Write-Ok ("'{0}' registered: at startup, SYSTEM, restarts every minute on failure" -f $TaskName)

$backupScript = Join-Path $InstallRoot 'deploy\backup-db.mjs'
if (Test-Path -LiteralPath $backupScript) {
    $backupTrigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At '03:30'
    $backupAction = New-ScheduledTaskAction -Execute $NodeExe -Argument 'deploy\backup-db.mjs' -WorkingDirectory $InstallRoot
    $backupSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 1) -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName $BackupTaskName -Principal $principal -Trigger $backupTrigger -Action $backupAction -Settings $backupSettings `
        -Description 'Weekly VACUUM INTO backup of the Ferry Tracker capture database.' -Force | Out-Null
    Write-Ok ("'{0}' registered: Sundays at 03:30" -f $BackupTaskName)
}
else { Write-Warn "deploy\backup-db.mjs is missing, so the weekly backup task was skipped." }

$watchdogScript = Join-Path $InstallRoot 'deploy\watchdog.mjs'
if (Test-Path -LiteralPath $watchdogScript) {
    $watchdogTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).Date -RepetitionInterval (New-TimeSpan -Minutes 15)
    $watchdogAction = New-ScheduledTaskAction -Execute $NodeExe -Argument 'deploy\watchdog.mjs' -WorkingDirectory $InstallRoot
    $watchdogSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName $WatchdogTaskName -Principal $principal -Trigger $watchdogTrigger -Action $watchdogAction -Settings $watchdogSettings `
        -Description 'Ferry Tracker health check: tunnel, port, capture freshness, free disk.' -Force | Out-Null
    Write-Ok ("'{0}' registered: every 15 minutes" -f $WatchdogTaskName)
    if (-not $env:HEALTHCHECKS_URL) {
        Write-Warn 'HEALTHCHECKS_URL is not set, so a dead machine will not alert. Set it as a machine-scoped variable.'
    }
}
else { Write-Warn "deploy\watchdog.mjs is missing, so the watchdog task was skipped." }

# The tunnel is what makes the app public, so a rebuild that loses it should be loud.
$tunnel = Get-Service -Name $TunnelServiceName -ErrorAction SilentlyContinue
if (-not $tunnel) {
    Write-Warn ("The '{0}' service is not installed, so ferry.jimlertech.com is NOT reachable. Install it with 'cloudflared service install <token>'." -f $TunnelServiceName)
}
else {
    if ($tunnel.StartType -ne 'Automatic') { Write-Warn ("The '{0}' service start type is {1}, not Automatic, so it will not survive a reboot." -f $TunnelServiceName, $tunnel.StartType) }
    if ($tunnel.Status -ne 'Running') { Write-Warn ("The '{0}' service is {1}, not Running, so the public hostname is down." -f $TunnelServiceName, $tunnel.Status) }
    if ($tunnel.StartType -eq 'Automatic' -and $tunnel.Status -eq 'Running') { Write-Ok ("'{0}' service is running and set to start automatically" -f $TunnelServiceName) }
}

# --- 7. Start and verify -----------------------------------------------------

Write-Step 'Start and verify'

Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Start-ScheduledTask -TaskName $TaskName
Write-Info 'waiting for the server to answer'

$health = $null
foreach ($attempt in 1..30) {
    Start-Sleep -Seconds 2
    try { $health = Invoke-RestMethod "http://127.0.0.1:$Port/api/health" -TimeoutSec 3; break } catch { }
}
if (-not $health) { throw "The server did not answer http://127.0.0.1:$Port/api/health within 60 seconds. Check Task Scheduler history for '$TaskName'." }
if ($health.source -ne 'live') { throw "The server started but reports source '$($health.source)'. It should be 'live'." }
Write-Ok ("/api/health is ok and reporting the live WSDOT feed")

Write-Info 'waiting for the first capture cycle'
Start-Sleep -Seconds 30
$capture = Invoke-RestMethod "http://127.0.0.1:$Port/api/capture/status" -TimeoutSec 5
Write-Ok ("/api/capture/status answered")
$capture | ConvertTo-Json -Depth 6 | Write-Host

$dbFile = Join-Path $DataDir 'ferry-capture.db'
if (Test-Path -LiteralPath $dbFile) { Write-Ok ("capture database is {0} KB" -f [math]::Round((Get-Item $dbFile).Length / 1KB)) }
else { Write-Warn "no capture database at $dbFile yet." }

# --- 8. Summary --------------------------------------------------------------

$addresses = Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -ne '127.0.0.1' } | Select-Object -ExpandProperty IPAddress

Write-Host "`n================ Ferry Tracker is deployed ================" -ForegroundColor Green
Write-Host ("  checkout   {0} at {1}" -f $InstallRoot, $head)
Write-Host ("  data       {0}" -f $DataDir)
Write-Host ("  tasks      {0}, {1}, {2}" -f $TaskName, $BackupTaskName, $WatchdogTaskName)
foreach ($address in $addresses) { Write-Host ("  reachable  http://{0}:{1}/" -f $address, $Port) }
Write-Host "`n  Reboot once to confirm capture resumes without a login." -ForegroundColor Yellow
Write-Host "===========================================================`n" -ForegroundColor Green
