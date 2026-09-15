# TKOS -- pull ontology samples (resolve + render) and verify the Ark model slots.
#
#   cd <repo>\clark-main
#   powershell -ExecutionPolicy Bypass -File .\scripts\tkos-probe.ps1
#
# Reads .env.docker. Never prints key values.
#
# Two PowerShell 5.1 traps this script exists to avoid -- both bit us already:
#
#  1. Get-Content defaults to the system ANSI codepage (GBK on a Chinese
#     Windows). Our .env files carry Chinese comments; decoding UTF-8 Chinese as
#     GBK hits an illegal multibyte sequence, and .NET's replacement fallback
#     can swallow the following newline -- merging a comment line into the key
#     line after it, so the key silently reads as empty. Always -Encoding UTF8.
#
#  2. Invoke-WebRequest decodes the body with the charset from Content-Type, and
#     falls back to ISO-8859-1 when the header has none. The ontology returns
#     `application/json` with no charset, so $r.Content comes back as latin-1
#     mojibake; writing that out as UTF-8 double-encodes it. Use -OutFile, which
#     writes the raw bytes and never decodes.

$ErrorActionPreference = "Continue"
$ProgressPreference    = "SilentlyContinue"
function Say ($m) { Write-Host "`n$m" -ForegroundColor Cyan }
function Ok  ($m) { Write-Host "  [ OK ] $m" -ForegroundColor Green }
function Note($m) { Write-Host "  [ -- ] $m" -ForegroundColor DarkYellow }
function Bad ($m) { Write-Host "  [FAIL] $m" -ForegroundColor Red }
function Dim ($m) { Write-Host "         $m" -ForegroundColor DarkGray }

$root = $PSScriptRoot
if (-not $root) { $root = (Get-Location).Path }
if ((Split-Path -Leaf $root) -eq "scripts") { $root = Split-Path -Parent $root }
Set-Location $root

try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Get-EnvValue($name) {
  if (-not (Test-Path ".env.docker")) { return "" }
  # -Encoding UTF8 is load-bearing. See trap 1 in the header.
  foreach ($line in (Get-Content ".env.docker" -Encoding UTF8)) {
    $l = $line -replace "`r", ""
    if ($l.TrimStart().StartsWith("#")) { continue }
    $i = $l.IndexOf("=")
    if ($i -lt 1) { continue }
    if ($l.Substring(0, $i).Trim() -eq $name) {
      return $l.Substring($i + 1).Trim().Trim([char]34, [char]39)
    }
  }
  return ""
}

$ontBase = Get-EnvValue "TKOS_ONTOLOGY_BASE_URL"; if (-not $ontBase) { $ontBase = "http://115.190.213.44:8000" }
$ontKey  = Get-EnvValue "TKOS_API_KEY"
$arkBase = Get-EnvValue "ARK_BASE_URL";  if (-not $arkBase) { $arkBase = "https://ark.cn-beijing.volces.com/api/v3" }
$arkKey  = Get-EnvValue "ARK_API_KEY"
$mPro    = Get-EnvValue "ARK_MODEL_PRO"
$mFlash  = Get-EnvValue "ARK_MODEL_FLASH"
$mAlt    = Get-EnvValue "ARK_MODEL_ALT"

Say "=== 0. Config found (names only) ==="
foreach ($p in @(@("TKOS_ONTOLOGY_BASE_URL",$ontBase), @("TKOS_API_KEY",$ontKey), @("ARK_BASE_URL",$arkBase), @("ARK_API_KEY",$arkKey), @("ARK_MODEL_PRO",$mPro), @("ARK_MODEL_FLASH",$mFlash), @("ARK_MODEL_ALT",$mAlt))) {
  if ($p[1]) { Ok ("{0,-24} set ({1} chars)" -f $p[0], $p[1].Length) } else { Note ("{0,-24} empty" -f $p[0]) }
}

function Post-Ontology($label, $path, $bodyBytes, $outFile) {
  $url = "$ontBase$path"
  try {
    # -OutFile writes raw bytes. See trap 2 in the header.
    Invoke-WebRequest -Uri $url -Method POST -UseBasicParsing -TimeoutSec 120 -Headers @{ "Authorization" = "Bearer $ontKey" } -ContentType "application/json; charset=utf-8" -Body $bodyBytes -OutFile $outFile -ErrorAction Stop
    $n = (Get-Item $outFile).Length
    Ok "$label 200 -- wrote $outFile ($n bytes)"
    return $true
  } catch {
    $c = 0; if ($_.Exception.Response) { try { $c = [int]$_.Exception.Response.StatusCode } catch {} }
    if ($c -eq 401) { Bad "$label 401 -- TKOS_API_KEY rejected" }
    elseif ($c -eq 404) { Bad "$label 404 -- query matched no issue" }
    elseif ($c -eq 422) { Bad "$label 422 -- request rejected (see minimum_required_chars if render)" }
    elseif ($c -ne 0) { Bad "$label HTTP $c" }
    else { Bad ("$label failed: " + (($_.Exception.Message -split "`n")[0])) }
    return $false
  }
}

Say "=== 1. resolve ==="
if (-not $ontKey) { Bad "TKOS_API_KEY empty" }
elseif (-not (Test-Path "scripts\resolve-request.json")) { Bad "scripts\resolve-request.json missing" }
else {
  $req = [System.IO.File]::ReadAllBytes((Resolve-Path "scripts\resolve-request.json").Path)
  Post-Ontology "resolve" "/v1/context-packs:resolve" $req "resolve-sample.json" | Out-Null
}

Say "=== 2. render (deterministic) ==="
if ($ontKey -and (Test-Path "scripts\resolve-request.json")) {
  # Wrap the same resolve_request; ask for the full budget so we can see what
  # gets dropped at smaller ones (render_omissions).
  $inner = [System.IO.File]::ReadAllText((Resolve-Path "scripts\resolve-request.json").Path, [System.Text.Encoding]::UTF8)
  $wrap  = '{"resolve_request":' + $inner + ',"render_options":{"format":"markdown","mode":"deterministic","include_structured":false,"max_chars":24000,"language":"zh-CN"}}'
  $b     = [System.Text.Encoding]::UTF8.GetBytes($wrap)
  Post-Ontology "render" "/v1/context-packs:render" $b "render-sample.json" | Out-Null
}

Say "=== 3. Ark model slots ==="
function Probe-Model($slot, $id) {
  if (-not $id) { Note ("{0,-6} not configured" -f $slot); return }
  $body = '{"model":"' + $id + '","max_tokens":1,"messages":[{"role":"user","content":"hi"}]}'
  $b = [System.Text.Encoding]::UTF8.GetBytes($body)
  try {
    $r = Invoke-WebRequest -Uri "$arkBase/chat/completions" -Method POST -UseBasicParsing -TimeoutSec 60 -Headers @{ "Authorization" = "Bearer $arkKey" } -ContentType "application/json" -Body $b -ErrorAction Stop
    $j = $r.Content | ConvertFrom-Json
    Ok ("{0,-6} {1}  -> echoed model={2}" -f $slot, $id, $j.model)
  } catch {
    $c = 0; $detail = ""
    if ($_.Exception.Response) {
      try { $c = [int]$_.Exception.Response.StatusCode } catch {}
      try {
        $sr = New-Object IO.StreamReader($_.Exception.Response.GetResponseStream())
        $detail = ($sr.ReadToEnd() -replace '\s+',' ')
        if ($detail.Length -gt 240) { $detail = $detail.Substring(0,240) }
      } catch {}
    }
    Bad ("{0,-6} {1}  -> HTTP {2}  {3}" -f $slot, $id, $c, $detail)
  }
}
if (-not $arkKey) { Bad "ARK_API_KEY empty" }
else {
  Probe-Model "PRO"   $mPro
  Probe-Model "FLASH" $mFlash
  Probe-Model "ALT"   $mAlt
  if (-not $mAlt) { Dim "ALT empty -- cross-model judge and dual research degrade; fill before A-3/A-4" }
}

Say "=== Done. Send me resolve-sample.json + render-sample.json + the section-3 output. ==="
Dim "both sample files are gitignored -- they carry company data"
