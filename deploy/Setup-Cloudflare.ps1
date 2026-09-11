<#
.SYNOPSIS
    Publishes Ferry Tracker at a public hostname behind Cloudflare Access, using the Cloudflare API.

.DESCRIPTION
    Replaces the dashboard click-through. Creates, in this order:
      1. A reusable Access policy allowing only the given emails
      2. A self-hosted Access application on the exact hostname
      3. A remotely-managed tunnel
      4. The tunnel ingress rule pointing at the local app
      5. A proxied CNAME to <tunnel-id>.cfargotunnel.com
      6. A response header transform rule (nosniff, X-Frame-Options, CSP)

    Access comes before the DNS record on purpose. Creating the route first would publish the
    app to the internet with no policy in front of it.

    Every step is idempotent: it looks for an existing object by name before creating one, so a
    failed run is safe to re-run. Nothing is written without -Apply.

.PARAMETER AllowEmail
    Email addresses permitted to authenticate. Everyone else is denied.

.PARAMETER Apply
    Perform the writes. Without this the script only reads and prints what it would send.

.PARAMETER EnforceCsp
    Send the CSP as enforcing. Default is Content-Security-Policy-Report-Only, which is the
    safe first deploy: violations appear in the browser console and nothing breaks.

.EXAMPLE
    $env:CLOUDFLARE_API_TOKEN = '...'   # set this yourself, in a terminal, never in a script
    .\deploy\Setup-Cloudflare.ps1 -AllowEmail you@example.com
    .\deploy\Setup-Cloudflare.ps1 -AllowEmail you@example.com -Apply

.NOTES
    Required API token permissions:
      Account | Cloudflare Tunnel        | Edit
      Account | Access: Apps and Policies| Edit
      Account | Account Rulesets         | Read
      Zone    | DNS                      | Edit
      Zone    | Transform Rules          | Edit

    Optional:
      Account | Access: Organizations, Identity Providers, and Groups | Read
    Without it the app offers every login method on the account instead of a pinned list.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string[]] $AllowEmail,

    [string] $AccountId = 'ec74856ed4fe9f15833c5419011f2507',
    [string] $ZoneName = 'jimlertech.com',
    [string] $Hostname = 'ferry.jimlertech.com',
    [string] $TunnelName = 'ferry-tracker',
    [string] $ServiceUrl = 'http://127.0.0.1:8787',
    [string] $AppName = 'Ferry Tracker',
    [string] $PolicyName = 'Ferry Tracker owner',

    # Mirrors frontend/test/csp.test.tsx. If that test fails, it prints the new value.
    [string] $CspScriptHash = 'sha256-RTo1ES63Gvwfm2inULbUlEb1terAlBsDvZcJV/RoLZM=',

    [switch] $EnforceCsp,
    [switch] $Apply
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ApiBase = 'https://api.cloudflare.com/client/v4'
$RuleRef = 'ferry_tracker_security_headers'
$script:PlannedWrites = 0

# ---------------------------------------------------------------- helpers

function Write-Step { param([string] $Text) Write-Host "`n=== $Text" -ForegroundColor Cyan }
function Write-Ok { param([string] $Text) Write-Host "    [ok]   $Text" -ForegroundColor Green }
function Write-Info { param([string] $Text) Write-Host "    $Text" -ForegroundColor Gray }
function Write-Plan { param([string] $Text) Write-Host "    [plan] $Text" -ForegroundColor Yellow }

function Invoke-CF {
    <# Thin wrapper that surfaces Cloudflare's own error text instead of a bare 400. #>
    param(
        [Parameter(Mandatory)][string] $Method,
        [Parameter(Mandatory)][string] $Path,
        [object] $Body
    )

    $params = @{
        Method      = $Method
        Uri         = "$ApiBase$Path"
        Headers     = @{ Authorization = "Bearer $($script:Token)" }
        ContentType = 'application/json'
    }
    if ($PSBoundParameters.ContainsKey('Body') -and $null -ne $Body) {
        $params.Body = ($Body | ConvertTo-Json -Depth 12 -Compress)
    }

    try {
        $response = Invoke-RestMethod @params
    }
    catch {
        $detail = $_.ErrorDetails.Message
        if (-not $detail) { throw "$Method $Path failed. $($_.Exception.Message)" }

        $parsed = $null
        try { $parsed = $detail | ConvertFrom-Json } catch { $parsed = $null }

        if ($parsed -and $parsed.PSObject.Properties.Name -contains 'errors' -and $parsed.errors) {
            $messages = @($parsed.errors | ForEach-Object { "$($_.code): $($_.message)" })
            throw "$Method $Path failed. $($messages -join ' | ')"
        }
        throw "$Method $Path failed. $detail"
    }

    if (-not $response.success) {
        $messages = @($response.errors | ForEach-Object { "$($_.code): $($_.message)" })
        throw "$Method $Path returned success=false. $($messages -join ' | ')"
    }
    return $response.result
}

function Invoke-CFWrite {
    <# Honors -Apply. In dry-run mode it prints the exact body and returns $null. #>
    param(
        [Parameter(Mandatory)][string] $Method,
        [Parameter(Mandatory)][string] $Path,
        [object] $Body,
        [Parameter(Mandatory)][string] $Description
    )

    $script:PlannedWrites++
    if (-not $Apply) {
        Write-Plan "$Description"
        Write-Info "$Method $Path"
        if ($null -ne $Body) {
            ($Body | ConvertTo-Json -Depth 12).Split("`n") | ForEach-Object { Write-Info "  $_" }
        }
        return $null
    }
    Write-Info "$Method $Path"
    $result = if ($null -ne $Body) { Invoke-CF -Method $Method -Path $Path -Body $Body }
    else { Invoke-CF -Method $Method -Path $Path }
    Write-Ok $Description
    return $result
}

# ---------------------------------------------------------------- token

$script:Token = $env:CLOUDFLARE_API_TOKEN
if ([string]::IsNullOrWhiteSpace($script:Token)) {
    Write-Host ''
    Write-Host 'CLOUDFLARE_API_TOKEN is not set.' -ForegroundColor Red
    Write-Host ''
    Write-Host 'Create a token at https://dash.cloudflare.com/profile/api-tokens with:'
    Write-Host '  Account | Cloudflare Tunnel         | Edit'
    Write-Host '  Account | Access: Apps and Policies | Edit'
    Write-Host '  Account | Account Rulesets          | Read'
    Write-Host '  Zone    | DNS                       | Edit'
    Write-Host '  Zone    | Transform Rules           | Edit'
    Write-Host ''
    Write-Host 'Optional, to pin the login methods on the app:'
    Write-Host '  Account | Access: Organizations, Identity Providers, and Groups | Read'
    Write-Host ''
    Write-Host 'Then set it in a terminal window OUTSIDE VS Code, so the value is never'
    Write-Host 'captured into a chat transcript:'
    Write-Host '  $env:CLOUDFLARE_API_TOKEN = ''<paste>'''
    Write-Host ''
    throw 'CLOUDFLARE_API_TOKEN is not set.'
}

Write-Host "Ferry Tracker -> Cloudflare" -ForegroundColor White
Write-Host ("mode: {0}" -f $(if ($Apply) { 'APPLY (writes are real)' } else { 'DRY RUN (no writes)' })) `
    -ForegroundColor $(if ($Apply) { 'Red' } else { 'Yellow' })

Write-Step 'Verifying API token'
$tokenStatus = Invoke-CF -Method GET -Path '/user/tokens/verify'
Write-Ok "token status: $($tokenStatus.status)"

# ---------------------------------------------------------------- zone

Write-Step "Resolving zone $ZoneName"
$zones = @(Invoke-CF -Method GET -Path "/zones?name=$ZoneName")
if ($zones.Count -eq 0) { throw "Zone $ZoneName not found, or the token cannot see it." }
$zoneId = $zones[0].id
Write-Ok "zone id $zoneId (status: $($zones[0].status))"

Write-Step "Pre-flight: checking for an existing DNS record at $Hostname"
$existingDns = @(Invoke-CF -Method GET -Path "/zones/$zoneId/dns_records?name=$Hostname")
$dnsRecord = if ($existingDns.Count -gt 0) { $existingDns[0] } else { $null }
if ($dnsRecord) {
    Write-Info "found $($dnsRecord.type) -> $($dnsRecord.content) (proxied: $($dnsRecord.proxied))"
    if ($dnsRecord.type -ne 'CNAME' -or $dnsRecord.content -notlike '*.cfargotunnel.com') {
        throw "$Hostname already has a $($dnsRecord.type) record pointing at $($dnsRecord.content). Remove it first, or this script would overwrite something in use."
    }
    Write-Ok 'existing record already points at a tunnel, will reuse'
}
else {
    Write-Ok 'clear'
}

# ---------------------------------------------------------------- identity providers

Write-Step 'Reading identity providers'

# Optional. Reading this list needs 'Access: Organizations, Identity Providers, and Groups'.
# Without it, allowed_idps is omitted and Access offers every login method on the account.
$idpIds = @()
try {
    $idps = @(Invoke-CF -Method GET -Path "/accounts/$AccountId/access/identity_providers")
}
catch {
    $idps = @()
    Write-Info "could not read: $($_.Exception.Message)"
}

if ($idps.Count -eq 0) {
    Write-Info 'No providers returned. The app will offer every login method configured on the account.'
    Write-Info "To pin specific providers, add 'Access: Organizations, Identity Providers, and Groups | Read' to the token."
}
else {
    foreach ($idp in $idps) { Write-Info "$($idp.name)  [$($idp.type)]  $($idp.id)" }
    $idpIds = @($idps | ForEach-Object { $_.id })
    Write-Ok "$($idpIds.Count) provider(s) will be offered at login"
}

# ---------------------------------------------------------------- access policy

Write-Step "Access policy: $PolicyName"
$policies = @(Invoke-CF -Method GET -Path "/accounts/$AccountId/access/policies")
$policy = $policies | Where-Object { $_.name -eq $PolicyName } | Select-Object -First 1

if ($policy) {
    Write-Ok "already exists ($($policy.id))"
    $policyId = $policy.id
}
else {
    $policyBody = @{
        name     = $PolicyName
        decision = 'allow'
        include  = @($AllowEmail | ForEach-Object { @{ email = @{ email = $_ } } })
    }
    $created = Invoke-CFWrite -Method POST -Path "/accounts/$AccountId/access/policies" `
        -Body $policyBody -Description "create allow policy for $($AllowEmail -join ', ')"
    $policyId = if ($created) { $created.id } else { '<policy-id-from-this-run>' }
}

# ---------------------------------------------------------------- access application

Write-Step "Access application: $AppName"
$apps = @(Invoke-CF -Method GET -Path "/accounts/$AccountId/access/apps")
$app = $apps | Where-Object { $_.domain -eq $Hostname } | Select-Object -First 1

if ($app) {
    Write-Ok "already exists ($($app.id)) on $($app.domain)"
}
else {
    $appBody = @{
        name                      = $AppName
        domain                    = $Hostname          # exact host, never a wildcard
        type                      = 'self_hosted'
        session_duration          = '730h'             # 1 month
        auto_redirect_to_identity = $false             # keep the chooser so a second IdP is reachable
        app_launcher_visible      = $true
        policies                  = @($policyId)
    }
    if ($idpIds.Count -gt 0) { $appBody.allowed_idps = $idpIds }

    Invoke-CFWrite -Method POST -Path "/accounts/$AccountId/access/apps" `
        -Body $appBody -Description "create self-hosted app on $Hostname" | Out-Null
}

# ---------------------------------------------------------------- tunnel

Write-Step "Tunnel: $TunnelName"
$tunnels = @(Invoke-CF -Method GET -Path "/accounts/$AccountId/cfd_tunnel?name=$TunnelName&is_deleted=false")
$tunnel = $tunnels | Where-Object { $_.name -eq $TunnelName } | Select-Object -First 1

if ($tunnel) {
    Write-Ok "already exists ($($tunnel.id)), status: $($tunnel.status)"
    $tunnelId = $tunnel.id
}
else {
    $created = Invoke-CFWrite -Method POST -Path "/accounts/$AccountId/cfd_tunnel" `
        -Body @{ name = $TunnelName; config_src = 'cloudflare' } `
        -Description "create remotely-managed tunnel $TunnelName"
    $tunnelId = if ($created) { $created.id } else { '<tunnel-id-from-this-run>' }
}

Write-Step 'Tunnel ingress'
$ingressBody = @{
    config = @{
        ingress = @(
            @{ hostname = $Hostname; service = $ServiceUrl; originRequest = @{} }
            @{ service = 'http_status:404' }   # catch-all is required by cloudflared
        )
    }
}
Invoke-CFWrite -Method PUT -Path "/accounts/$AccountId/cfd_tunnel/$tunnelId/configurations" `
    -Body $ingressBody -Description "route $Hostname -> $ServiceUrl" | Out-Null

# ---------------------------------------------------------------- dns

Write-Step "DNS record for $Hostname"
$target = "$tunnelId.cfargotunnel.com"
if ($dnsRecord) {
    if ($dnsRecord.content -eq $target -and $dnsRecord.proxied) {
        Write-Ok 'already correct'
    }
    else {
        Invoke-CFWrite -Method PATCH -Path "/zones/$zoneId/dns_records/$($dnsRecord.id)" `
            -Body @{ type = 'CNAME'; name = $Hostname; content = $target; proxied = $true } `
            -Description "repoint CNAME to $target" | Out-Null
    }
}
else {
    Invoke-CFWrite -Method POST -Path "/zones/$zoneId/dns_records" `
        -Body @{ type = 'CNAME'; name = $Hostname; content = $target; proxied = $true; comment = 'Ferry Tracker via Cloudflare Tunnel' } `
        -Description "create proxied CNAME -> $target" | Out-Null
}

# ---------------------------------------------------------------- security headers

Write-Step 'Response header transform rule'

$csp = @(
    "default-src 'self'"
    "script-src 'self' '$CspScriptHash'"
    "style-src 'self' https://fonts.googleapis.com"
    "font-src 'self' https://fonts.gstatic.com"
    "img-src 'self' data: https://images.wsdot.wa.gov"
    "connect-src 'self'"
    "frame-ancestors 'none'"
    "base-uri 'self'"
    "form-action 'self'"
    "object-src 'none'"
) -join '; '

$cspHeader = if ($EnforceCsp) { 'Content-Security-Policy' } else { 'Content-Security-Policy-Report-Only' }
Write-Info "CSP header: $cspHeader"

# Excluding /cdn-cgi/ keeps these headers off Cloudflare's own Access login page. A CSP mistake
# there would break the login screen itself, and LAN would be the only way back in.
$expression = "(http.host eq `"$Hostname`" and not starts_with(http.request.uri.path, `"/cdn-cgi/`"))"

$ourRule = @{
    ref               = $RuleRef
    description       = 'Ferry Tracker security headers'
    expression        = $expression
    action            = 'rewrite'
    action_parameters = @{
        headers = @{
            'X-Content-Type-Options' = @{ operation = 'set'; value = 'nosniff' }
            'X-Frame-Options'        = @{ operation = 'set'; value = 'DENY' }
            "$cspHeader"             = @{ operation = 'set'; value = $csp }
        }
    }
}

$rulesets = @(Invoke-CF -Method GET -Path "/zones/$zoneId/rulesets")
$phaseRuleset = $rulesets |
Where-Object { $_.phase -eq 'http_response_headers_transform' -and $_.kind -eq 'zone' } |
Select-Object -First 1

if (-not $phaseRuleset) {
    Invoke-CFWrite -Method POST -Path "/zones/$zoneId/rulesets" `
        -Body @{
        name        = 'Zone-level Response Headers Transform Ruleset'
        description = 'Created by Setup-Cloudflare.ps1'
        kind        = 'zone'
        phase       = 'http_response_headers_transform'
        rules       = @($ourRule)
    } `
        -Description 'create response header ruleset with the Ferry Tracker rule' | Out-Null
}
else {
    Write-Info "ruleset $($phaseRuleset.id) exists"
    $rulesetDetail = Invoke-CF -Method GET -Path "/zones/$zoneId/rulesets/$($phaseRuleset.id)"
    $existingRules = @()
    if ($rulesetDetail.PSObject.Properties.Name -contains 'rules' -and $rulesetDetail.rules) {
        $existingRules = @($rulesetDetail.rules)
    }

    # Keep every other rule in the zone untouched; replace only ours.
    $kept = @($existingRules | Where-Object {
            -not ($_.PSObject.Properties.Name -contains 'ref' -and $_.ref -eq $RuleRef)
        } | ForEach-Object {
            $r = @{ expression = $_.expression; action = $_.action }
            if ($_.PSObject.Properties.Name -contains 'ref') { $r.ref = $_.ref }
            if ($_.PSObject.Properties.Name -contains 'description') { $r.description = $_.description }
            if ($_.PSObject.Properties.Name -contains 'action_parameters') { $r.action_parameters = $_.action_parameters }
            if ($_.PSObject.Properties.Name -contains 'enabled') { $r.enabled = $_.enabled }
            $r
        })
    Write-Info "preserving $($kept.Count) unrelated rule(s)"

    Invoke-CFWrite -Method PUT -Path "/zones/$zoneId/rulesets/$($phaseRuleset.id)" `
        -Body @{ rules = @($kept + $ourRule) } `
        -Description 'upsert the Ferry Tracker security header rule' | Out-Null
}

# ---------------------------------------------------------------- connector install command

Write-Step 'Connector install command'

if ($Apply) {
    # The tunnel token is a credential. It is written to a gitignored file rather than printed,
    # so it cannot end up in terminal scrollback or a chat transcript.
    $tunnelToken = Invoke-CF -Method GET -Path "/accounts/$AccountId/cfd_tunnel/$tunnelId/token"
    $repoRoot = Split-Path -Parent $PSScriptRoot
    $outDir = Join-Path $repoRoot 'data'
    $outFile = Join-Path $outDir 'cloudflared-install-command.txt'

    New-Item -ItemType Directory -Path $outDir -Force | Out-Null
    Set-Content -Path $outFile -Value "cloudflared.exe service install $tunnelToken" -Encoding utf8 -NoNewline

    Write-Ok "written to $outFile"
    Write-Info 'Run it in an ELEVATED PowerShell on jimbrownhome, then delete the file.'
    Write-Info 'data/ is gitignored, so the token will not be committed.'
}
else {
    Write-Plan 'fetch the tunnel token and write data/cloudflared-install-command.txt'
    Write-Info 'The token is never printed to the console.'
}

# ---------------------------------------------------------------- summary

Write-Host ''
if ($Apply) {
    Write-Host 'Done.' -ForegroundColor Green
    Write-Host @"

Still yours to do:
  1. Run data/cloudflared-install-command.txt on jimbrownhome (elevated), then delete the file.
  2. sc.exe failure cloudflared reset= 86400 actions= restart/5000/restart/10000/restart/60000
  3. Browse https://$Hostname with devtools open, confirm zero CSP violations,
     then re-run this script with -EnforceCsp -Apply.
  4. Set HEALTHCHECKS_URL and re-run Install-FerryTracker.ps1 for the watchdog task.
"@ -ForegroundColor Gray
}
else {
    Write-Host "Dry run complete. $($script:PlannedWrites) write(s) planned." -ForegroundColor Yellow
    Write-Host 'Re-run with -Apply to perform them.' -ForegroundColor Yellow
}
