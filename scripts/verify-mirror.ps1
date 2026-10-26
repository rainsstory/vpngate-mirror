<#
.SYNOPSIS
  Verify that a vpngate mirror endpoint returns a usable VPN Gate aggregate CSV.

.DESCRIPTION
  Checks HTTP status, payload signature (*vpn_servers + #HostName,... header),
  row count and country distribution, and prints the top countries. Exits
  non-zero when the endpoint is unreachable or the payload is not VPN Gate CSV.

.PARAMETER BaseUrl
  Oracle-like base, without the /api/iphone/ suffix. Defaults to the deployed
  GitHub Pages URL for this repository.

.EXAMPLE
  pwsh ./scripts/verify-mirror.ps1 -BaseUrl "https://alice.github.io/vpngate-mirror"
#>
[CmdletBinding()]
param(
    [string]$BaseUrl = "https://<owner>.github.io/vpngate-mirror",
    [int]$TimeoutSec = 60,
    [switch]$AsJson
)

$ErrorActionPreference = 'Stop'
$url = ($BaseUrl.TrimEnd('/')) + '/api/iphone/'

Write-Host "GET $url" -ForegroundColor Cyan
$sw = [System.Diagnostics.Stopwatch]::StartNew()
try {
    $resp = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec $TimeoutSec
}
catch {
    Write-Host "FAIL: request error: $($_.Exception.Message)" -ForegroundColor Red
    exit 2
}
$sw.Stop()

$text = $resp.Content
$result = [ordered]@{
    url         = $url
    status      = [int]$resp.StatusCode
    bytes       = $text.Length
    elapsed_ms  = [int]$sw.ElapsedMilliseconds
    content_type = $resp.Headers['Content-Type']
    ok          = $false
    rows        = 0
    countries   = @{}
    reasons     = @()
}

if (-not $text.StartsWith('*vpn_servers')) { $result.reasons += 'missing *vpn_servers' }
if (-not $text.Contains('#HostName,IP,Score')) { $result.reasons += 'missing CSV header' }

$header = $null
$rows = @()
foreach ($line in ($text -split "`r?`n")) {
    if (-not $line) { continue }
    if ($line.StartsWith('*')) { continue }
    if ($line.StartsWith('#')) { $header = $line.Substring(1).Split(','); continue }
    $rows += ,($line.Split(','))
}

if (-not $header) { $result.reasons += 'no column header' }
else {
    $i = [Array]::IndexOf($header, 'CountryShort')
    if ($i -ge 0) {
        $counts = @{}
        foreach ($r in $rows) {
            if ($r.Count -le $i) { continue }
            $cc = $r[$i]
            if ($counts.ContainsKey($cc)) { $counts[$cc]++ } else { $counts[$cc] = 1 }
        }
        $result.countries = $counts
    } else { $result.reasons += 'CountryShort column absent' }
}

$result.rows = $rows.Count
if ($rows.Count -lt 10) { $result.reasons += "only $($rows.Count) rows" }
$result.ok = ($result.reasons.Count -eq 0)

if ($AsJson) {
    $result | ConvertTo-Json -Depth 4
}
else {
    Write-Host ("status={0} bytes={1} rows={2} elapsed={3}ms ct={4}" -f `
        $result.status, $result.bytes, $result.rows, $result.elapsed_ms, $result.content_type)
    if ($result.countries.Count -gt 0) {
        $top = $result.countries.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 10
        Write-Host "countries:" (($top | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join ' ')
        if ($result.countries.ContainsKey('VN')) {
            Write-Host "VN servers: $($result.countries['VN'])" -ForegroundColor Yellow
        } else {
            Write-Host "VN servers: 0" -ForegroundColor DarkGray
        }
    }
    if ($result.ok) { Write-Host "OK" -ForegroundColor Green }
    else { Write-Host ("FAIL: " + ($result.reasons -join '; ')) -ForegroundColor Red }
}

if (-not $result.ok) { exit 1 }
