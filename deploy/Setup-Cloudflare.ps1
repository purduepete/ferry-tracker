<#
.SYNOPSIS
    Publishes Ferry Tracker at a public hostname behind Cloudflare Access, using the Cloudflare API.

.DESCRIPTION
    Replaces the dashboard click-through. Creates, in this order:
      1. A reusable Access policy allowing only the given emails
      2. A self-hosted Access application on the exact hostname
      3. A path-scoped Access application on /api/catch carrying a bypass policy
      4. A remotely-managed tunnel
      5. The tunnel ingress rule pointing at the local app
      6. A proxied CNAME to <tunnel-id>.cfargotunnel.com
      7. A response header transform rule (nosniff, X-Frame-Options, CSP)
      8. A rate limiting rule capping /api/catch

    Access comes before the DNS record on purpose. Creating the route first would publish the
    app to the internet with no policy in front of it.

    The /api/catch bypass is deliberately narrow. That path answers the Apple Watch complication,
    which cannot complete an Access email login, so the Express shared-secret header is the only
    gate on it. Deploy the token-enforcing server BEFORE creating the bypass, or the path is
    briefly public with nothing in front of it.

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
      Zone    | Zone WAF                 | Edit

    Rate limiting rules are deployed to the WAF's http_ratelimit phase, so they need Zone WAF
    rather than a permission of their own. There is no "Rate Limit Rules" entry in the picker.

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
    [string] $CatchAppName = 'Ferry Tracker watch endpoint',
    [string] $CatchPolicyName = 'Ferry Tracker watch bypass',

    # The free plan only counts over a 10 second window, so this is requests per 10 seconds, not
    # per minute. Five covers a manual tap or three without letting anyone grind the token check.
    [int] $CatchRequestsPerPeriod = 5,

    # Mirrors frontend/test/csp.test.tsx. If that test fails, it prints the new value.
    [string] $CspScriptHash = 'sha256-zmWzz+eVIE4YDlhZ1idw65PsmpiOGcNg1ZceiykhvJk=',

    [switch] $EnforceCsp,
    [switch] $Apply
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ApiBase = 'https://api.cloudflare.com/client/v4'
$RuleRef = 'ferry_tracker_security_headers'
$RateLimitRef = 'ferry_tracker_catch_ratelimit'

# 10 is the only counting period and the only mitigation timeout the free plan is entitled to.
# Anything else comes back as "not entitled to use the period 60, can only use a period among [10]".
$RateLimitPeriodSeconds = 10
$CatchPath = '/api/catch'
$script:PlannedWrites = 0

# ---------------------------------------------------------------- helpers

function Write-Step { param([string] $Text) Write-Host "`n=== $Text" -ForegroundColor Cyan }
function Write-Ok { param([string] $Text) Write-Host "    [ok]   $Text" -ForegroundColor Green }
function Write-Info { param([string] $Text) Write-Host "    $Text" -ForegroundColor Gray }
function Write-Plan { param([string] $Text) Write-Host "    [plan] $Text" -ForegroundColor Yellow }

function Copy-Rule {
    <# Projects an existing ruleset rule back into a writable body, dropping server-set fields. #>
    param([Parameter(Mandatory)][object] $Rule)

    $copy = @{ expression = $Rule.expression; action = $Rule.action }
    foreach ($field in 'ref', 'description', 'action_parameters', 'enabled', 'ratelimit') {
        if ($Rule.PSObject.Properties.Name -contains $field) { $copy[$field] = $Rule.$field }
    }
    return $copy
}

function Format-CFError {
    <# The rulesets API omits 'code' and hides the real cause in source.pointer / error_chain,
       and Set-StrictMode turns a missing property into its own error that buries the first one. #>
    param([object] $Errors)

    # Indexed lookup rather than .Properties.Name, which StrictMode rejects on a property-less object.
    $has = { param($o, $n) if (-not $o) { return $false }; $p = $o.PSObject.Properties[$n]; return [bool]($p -and $p.Value) }
    $out = foreach ($e in @($Errors)) {
        if ($e -isnot [psobject]) { "$e"; continue }
        $part = if (& $has $e 'code') { "$($e.code): " } else { '' }
        $part += if (& $has $e 'message') { "$($e.message)" } else { ($e | ConvertTo-Json -Depth 6 -Compress) }
        if (& $has $e 'source') { if (& $has $e.source 'pointer') { $part += " (at $($e.source.pointer))" } }
        if (& $has $e 'error_chain') { $part += ' -> ' + ((Format-CFError $e.error_chain) -join '; ') }
        $part
    }
    return @($out)
}

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
            throw "$Method $Path failed. $((Format-CFError $parsed.errors) -join ' | ')"
        }
        throw "$Method $Path failed. $detail"
    }

    if (-not $response.success) {
        throw "$Method $Path returned success=false. $((Format-CFError $response.errors) -join ' | ')"
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

# A token pasted into a terminal often arrives with a trailing space or newline, and Cloudflare
# answers that with a bare "1000: Invalid API Token" that looks like a permissions problem.
$script:Token = "$env:CLOUDFLARE_API_TOKEN".Trim()
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
    Write-Host '  Zone    | Zone WAF                  | Edit   (this is what rate limiting needs)'
    Write-Host ''
    Write-Host 'Optional, to pin the login methods on the app:'
    Write-Host '  Account | Access: Organizations, Identity Providers, and Groups | Read'
    Write-Host ''
    Write-Host 'Optional, to report on the Web Analytics beacon that the CSP blocks:'
    Write-Host '  Account | Account Settings | Read'
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

# ---------------------------------------------------------------- access application and policy

Write-Step "Access application on $Hostname"
$apps = @(Invoke-CF -Method GET -Path "/accounts/$AccountId/access/apps")
$app = $apps | Where-Object { $_.domain -eq $Hostname } | Select-Object -First 1

$allowRules = @($AllowEmail | ForEach-Object { @{ email = @{ email = $_ } } })

function Get-PolicyEmail {
    param([object] $Policy)
    @($Policy.include |
        Where-Object { $_.PSObject.Properties.Name -contains 'email' } |
        ForEach-Object { $_.email.email })
}

if ($app) {
    Write-Ok "already exists ($($app.id)), named '$($app.name)'"

    # An app built by hand carries its own policy under its own name. Reconcile that one, because a
    # second policy created alongside it is one the app never consults.
    $attached = @($app.policies)
    if ($attached.Count -eq 0) {
        $attached = @(Invoke-CF -Method GET -Path "/accounts/$AccountId/access/apps/$($app.id)/policies")
    }
    foreach ($p in $attached) {
        $e = Get-PolicyEmail $p
        Write-Info "policy '$($p.name)' [$($p.decision)] allows: $(if ($e.Count) { $e -join ', ' } else { '(no email rules)' })"
    }

    $allowPolicy = $attached | Where-Object { $_.decision -eq 'allow' } | Select-Object -First 1
    if (-not $allowPolicy) {
        throw "The app on $Hostname has no allow policy. Add one, or delete the app and re-run so this script builds both."
    }

    $current = Get-PolicyEmail $allowPolicy
    if ($current.Count -eq $AllowEmail.Count -and -not (Compare-Object -ReferenceObject $current -DifferenceObject $AllowEmail)) {
        Write-Ok "policy '$($allowPolicy.name)' already allows exactly the requested emails"
    }
    else {
        $body = @{ name = $allowPolicy.name; decision = 'allow'; include = $allowRules }
        # Reusable and legacy policies live at different paths, so fall back to the app-scoped one.
        try {
            Invoke-CFWrite -Method PUT -Path "/accounts/$AccountId/access/policies/$($allowPolicy.id)" `
                -Body $body -Description "update '$($allowPolicy.name)' to allow $($AllowEmail -join ', ')" | Out-Null
        }
        catch {
            Invoke-CFWrite -Method PUT -Path "/accounts/$AccountId/access/apps/$($app.id)/policies/$($allowPolicy.id)" `
                -Body $body -Description "update legacy policy '$($allowPolicy.name)' to allow $($AllowEmail -join ', ')" | Out-Null
        }
    }

    # An earlier run of this script creates $PolicyName before it finds the hand-built app, leaving a
    # reusable policy the app never consults. Say so rather than delete it, since the same name could
    # be in use elsewhere.
    try {
        $attachedIds = @($attached | ForEach-Object { $_.id })
        $orphans = @(Invoke-CF -Method GET -Path "/accounts/$AccountId/access/policies" |
            Where-Object { $_.name -eq $PolicyName -and $attachedIds -notcontains $_.id })
        foreach ($o in $orphans) {
            Write-Info "policy '$($o.name)' ($($o.id)) is not attached to this app and has no effect."
            Write-Info 'Delete it under Zero Trust > Access > Policies so one policy governs the app.'
        }
    }
    catch {
        Write-Info 'skipped the unattached-policy check: the token cannot list reusable policies'
    }
}
else {
    $created = Invoke-CFWrite -Method POST -Path "/accounts/$AccountId/access/policies" `
        -Body @{ name = $PolicyName; decision = 'allow'; include = $allowRules } `
        -Description "create allow policy for $($AllowEmail -join ', ')"
    $policyId = if ($created) { $created.id } else { '<policy-id-from-this-run>' }

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

# ---------------------------------------------------------------- watch endpoint bypass

Write-Step "Access bypass on $Hostname$CatchPath"
Write-Info 'Only create this once the server enforcing CATCH_TOKEN is already deployed.'

$catchDomain = "$Hostname$CatchPath"
$catchApp = $apps | Where-Object { $_.domain -eq $catchDomain } | Select-Object -First 1

if ($catchApp) {
    Write-Ok "already exists ($($catchApp.id)), named '$($catchApp.name)'"

    $catchPolicies = @($catchApp.policies)
    if ($catchPolicies.Count -eq 0) {
        $catchPolicies = @(Invoke-CF -Method GET -Path "/accounts/$AccountId/access/apps/$($catchApp.id)/policies")
    }
    if (@($catchPolicies | Where-Object { $_.decision -eq 'bypass' }).Count -gt 0) {
        Write-Ok 'bypass policy is attached'
    }
    else {
        # Without a bypass the watch gets Cloudflare's login HTML instead of JSON, and with the
        # wrong decision the path could be sitting behind nothing at all. Neither is safe to patch
        # around, so stop and let a human look.
        throw "The app on $catchDomain has no bypass policy. Delete it under Zero Trust > Access > Applications and re-run."
    }
}
else {
    $created = Invoke-CFWrite -Method POST -Path "/accounts/$AccountId/access/policies" `
        -Body @{ name = $CatchPolicyName; decision = 'bypass'; include = @(@{ everyone = @{} }) } `
        -Description "create the bypass policy for $CatchPath"
    $catchPolicyId = if ($created) { $created.id } else { '<policy-id-from-this-run>' }

    Invoke-CFWrite -Method POST -Path "/accounts/$AccountId/access/apps" `
        -Body @{
        name                 = $CatchAppName
        domain               = $catchDomain          # path-scoped, so it wins over the root app
        type                 = 'self_hosted'
        app_launcher_visible = $false
        policies             = @($catchPolicyId)
    } `
        -Description "create the path-scoped bypass app on $catchDomain" | Out-Null
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
        } | ForEach-Object { Copy-Rule $_ })
    Write-Info "preserving $($kept.Count) unrelated rule(s)"

    Invoke-CFWrite -Method PUT -Path "/zones/$zoneId/rulesets/$($phaseRuleset.id)" `
        -Body @{ rules = @($kept + $ourRule) } `
        -Description 'upsert the Ferry Tracker security header rule' | Out-Null
}

# ---------------------------------------------------------------- watch endpoint rate limit

Write-Step "Rate limiting rule on $CatchPath"

# The endpoint sits outside Access, so the edge caps it before the token check ever runs. Upstream
# WSDOT calls are cached for 30s inside the server, so this protects the box, not the WSDOT quota.
$catchRule = @{
    ref         = $RateLimitRef
    description = 'Ferry Tracker watch endpoint'
    # Path is the only request field the free plan can match on, so the rule cannot be pinned to a
    # hostname. No other host in the zone serves this path, and the worst case is a 429 there too.
    expression  = "(starts_with(http.request.uri.path, `"$CatchPath`"))"
    action      = 'block'
    ratelimit   = @{
        # ip.src paired with cf.colo.id is the only characteristic set the free plan allows.
        characteristics     = @('ip.src', 'cf.colo.id')
        period              = $RateLimitPeriodSeconds
        requests_per_period = $CatchRequestsPerPeriod
        mitigation_timeout  = $RateLimitPeriodSeconds
    }
}

$rateRuleset = $rulesets |
Where-Object { $_.phase -eq 'http_ratelimit' -and $_.kind -eq 'zone' } |
Select-Object -First 1

if (-not $rateRuleset) {
    Invoke-CFWrite -Method POST -Path "/zones/$zoneId/rulesets" `
        -Body @{
        name        = 'Zone-level Rate Limiting Ruleset'
        description = 'Created by Setup-Cloudflare.ps1'
        kind        = 'zone'
        phase       = 'http_ratelimit'
        rules       = @($catchRule)
    } `
        -Description "create the rate limiting ruleset capping $CatchPath at $CatchRequestsPerPeriod per ${RateLimitPeriodSeconds}s" | Out-Null
}
else {
    Write-Info "ruleset $($rateRuleset.id) exists"
    $rateDetail = Invoke-CF -Method GET -Path "/zones/$zoneId/rulesets/$($rateRuleset.id)"
    $existingRateRules = @()
    if ($rateDetail.PSObject.Properties.Name -contains 'rules' -and $rateDetail.rules) {
        $existingRateRules = @($rateDetail.rules)
    }

    $keptRate = @($existingRateRules | Where-Object {
            -not ($_.PSObject.Properties.Name -contains 'ref' -and $_.ref -eq $RateLimitRef)
        } | ForEach-Object { Copy-Rule $_ })
    Write-Info "preserving $($keptRate.Count) unrelated rule(s)"
    if ($keptRate.Count -gt 0) {
        Write-Info 'The free plan allows a single rate limiting rule, so this write may be rejected.'
    }

    Invoke-CFWrite -Method PUT -Path "/zones/$zoneId/rulesets/$($rateRuleset.id)" `
        -Body @{ rules = @($keptRate + $catchRule) } `
        -Description "upsert the $CatchPath rate limit at $CatchRequestsPerPeriod per ${RateLimitPeriodSeconds}s" | Out-Null
}

# ---------------------------------------------------------------- web analytics beacon

Write-Step 'Web Analytics beacon'

# Cloudflare injects static.cloudflareinsights.com into proxied responses and script-src blocks it.
# Per-hostname exclude rules need a Pro plan, so automatic injection is turned off for the whole
# zone under Web Analytics > Manage site. This only reports drift; the fix is a dashboard click.
$rumSites = $null
try {
    $rumSites = @(Invoke-CF -Method GET -Path "/accounts/$AccountId/rum/site_info/list")
}
catch {
    Write-Info 'skipped: the token cannot read Web Analytics sites'
    Write-Info 'Add "Account | Account Settings | Read" to check this automatically.'
}

if ($null -ne $rumSites) {
    $rumSite = $null
    foreach ($s in $rumSites) {
        if ($s.PSObject.Properties.Name -notcontains 'ruleset' -or -not $s.ruleset) { continue }
        if ($s.ruleset.PSObject.Properties.Name -notcontains 'zone_tag') { continue }
        if ($s.ruleset.zone_tag -eq $zoneId) { $rumSite = $s; break }
    }

    if (-not $rumSite) {
        Write-Ok "no Web Analytics site covers $ZoneName, so nothing is injecting the beacon"
    }
    elseif ($rumSite.PSObject.Properties.Name -contains 'auto_install' -and $rumSite.auto_install) {
        Write-Info 'auto_install is ON, so the beacon will be injected and the CSP will block it.'
        Write-Info "Web Analytics > Manage site ($ZoneName) > Enable with JS Snippet installation > Update."
    }
    else {
        Write-Ok "automatic injection is off for $ZoneName"
    }
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
    $cspStep = if ($EnforceCsp) {
        "Browse https://$Hostname with devtools open and confirm zero CSP violations.
     A blocked script means re-running without -EnforceCsp until the policy is right."
    }
    else {
        "Browse https://$Hostname with devtools open, confirm zero CSP violations,
     then re-run this script with -EnforceCsp -Apply."
    }
    Write-Host @"

Still yours to do:
  1. Run data/cloudflared-install-command.txt on jimbrownhome (elevated), then delete the file.
  2. sc.exe failure cloudflared reset= 86400 actions= restart/5000/restart/10000/restart/60000
  3. $cspStep
  4. Set HEALTHCHECKS_URL and re-run Install-FerryTracker.ps1 for the watchdog task.
  5. Reboot and re-check https://$Hostname, so the tasks and the tunnel prove they come back.
"@ -ForegroundColor Gray
}
else {
    Write-Host "Dry run complete. $($script:PlannedWrites) write(s) planned." -ForegroundColor Yellow
    Write-Host 'Re-run with -Apply to perform them.' -ForegroundColor Yellow
}
