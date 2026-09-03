<#
.SYNOPSIS
    Pulls a fresh capture snapshot off the production host and opens the HTML report.

.DESCRIPTION
    Triggers the FerryTracker-Backup scheduled task on the remote host over CIM/DCOM,
    waits for the new snapshot to land, copies it down, and runs the report generator
    against the copy. The report generator opens the database read-write and applies
    migrations, so it is never pointed at the live capture database.

    WinRM and SSH are closed on the production host. DCOM is the working channel, and
    triggering the task needs administrator rights on that host.

.EXAMPLE
    .\Get-CaptureReport.ps1

.EXAMPLE
    .\Get-CaptureReport.ps1 -SkipBackup
#>
[CmdletBinding()]
param(
    [string] $ComputerName = 'jimbrownhome',
    [string] $BackupTaskName = 'FerryTracker-Backup',
    [string] $BackupShare,
    [string] $OutputDir = (Join-Path $env:TEMP 'ferry-prod'),
    [int]    $TimeoutSec = 180,
    [switch] $SkipBackup
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not $BackupShare) { $BackupShare = "\\$ComputerName\c`$\ProgramData\ferry-tracker\backups" }
$RepoRoot = Split-Path -Parent $PSScriptRoot

$script:step = 0
function Write-Step { param([string] $Message) $script:step++; Write-Host ("`n[{0}] {1}" -f $script:step, $Message) -ForegroundColor Cyan }
function Write-Ok { param([string] $Message) Write-Host ("      OK    {0}" -f $Message) -ForegroundColor Green }
function Write-Info { param([string] $Message) Write-Host ("      ..    {0}" -f $Message) -ForegroundColor DarkGray }

function Get-NewestBackup {
    Get-ChildItem -Path (Join-Path $BackupShare '*.db') -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
}

# --- 1. Preflight ------------------------------------------------------------

Write-Step 'Preflight'

if (-not (Test-Path -LiteralPath $BackupShare)) {
    throw "Cannot reach $BackupShare. Check that $ComputerName is up and that you have admin rights on it."
}
Write-Ok ("backup share reachable at {0}" -f $BackupShare)

$npx = Get-Command npx.cmd -ErrorAction SilentlyContinue
if (-not $npx) { $npx = Get-Command npx -ErrorAction SilentlyContinue }
if (-not $npx) { throw 'npx is not on PATH. Install Node 22+ or open a shell that can see it.' }

if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot 'node_modules'))) {
    throw "No node_modules under $RepoRoot. Run npm ci first."
}
Write-Ok ("repo ready at {0}" -f $RepoRoot)

$before = Get-NewestBackup
if ($before) { Write-Info ("newest existing snapshot: {0}" -f $before.Name) }

# --- 2. Trigger a fresh snapshot --------------------------------------------

if ($SkipBackup) {
    Write-Step 'Fresh snapshot skipped'
}
else {
    Write-Step ("Triggering {0} on {1}" -f $BackupTaskName, $ComputerName)

    $session = $null
    try {
        $session = New-CimSession -ComputerName $ComputerName `
            -SessionOption (New-CimSessionOption -Protocol DCOM) -OperationTimeoutSec 30
        Start-ScheduledTask -TaskName $BackupTaskName -CimSession $session

        # The task returns before the file is flushed, so wait on the file rather than the task.
        $deadline = (Get-Date).AddSeconds($TimeoutSec)
        while ((Get-Date) -lt $deadline) {
            Start-Sleep -Seconds 3
            $state = (Get-ScheduledTask -TaskName $BackupTaskName -CimSession $session).State
            if ($state -eq 'Ready') { break }
            Write-Info ("task state {0}" -f $state)
        }

        $info = Get-ScheduledTaskInfo -TaskName $BackupTaskName -CimSession $session
        if ($info.LastTaskResult -ne 0) {
            throw ("{0} exited with {1}. Check the task history on {2}." -f $BackupTaskName, $info.LastTaskResult, $ComputerName)
        }
        Write-Ok ('backup task finished with exit code 0')
    }
    finally {
        if ($session) { Remove-CimSession -CimSession $session }
    }
}

# --- 3. Wait for the snapshot to settle -------------------------------------

Write-Step 'Waiting for the snapshot'

$deadline = (Get-Date).AddSeconds($TimeoutSec)
$snapshot = $null
while ((Get-Date) -lt $deadline) {
    $candidate = Get-NewestBackup
    if ($candidate -and (-not $before -or $SkipBackup -or $candidate.FullName -ne $before.FullName)) {
        # A VACUUM INTO target grows while it is being written, so require a stable size.
        $firstLength = $candidate.Length
        Start-Sleep -Seconds 2
        $recheck = Get-Item -LiteralPath $candidate.FullName
        if ($recheck.Length -eq $firstLength -and $recheck.Length -gt 0) { $snapshot = $recheck; break }
        Write-Info ('still growing')
        continue
    }
    Start-Sleep -Seconds 2
}

if (-not $snapshot) { throw "No new snapshot appeared in $BackupShare within $TimeoutSec seconds." }
Write-Ok ("{0} ({1:N0} bytes, written {2})" -f $snapshot.Name, $snapshot.Length, $snapshot.LastWriteTime)

# --- 4. Copy it down ---------------------------------------------------------

Write-Step 'Copying the snapshot'

New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
$local = Join-Path $OutputDir 'ferry-capture.db'
Copy-Item -LiteralPath $snapshot.FullName -Destination $local -Force
Write-Ok ("copied to {0}" -f $local)

# --- 5. Build and open the report -------------------------------------------

Write-Step 'Building the report'

Push-Location $RepoRoot
try {
    & $npx.Source tsx server/src/report/captureReport.ts $local
    if ($LASTEXITCODE -ne 0) { throw "Report generation failed with exit code $LASTEXITCODE." }
}
finally { Pop-Location }

Write-Ok ("report at {0}" -f (Join-Path $OutputDir 'capture-report.html'))
