# TKOS local verification -- Windows PowerShell 5.1 compatible
#
#   cd <repo>\clark-main
#   powershell -ExecutionPolicy Bypass -File .\scripts\tkos-verify.ps1
#
# ASCII only on purpose: Windows PowerShell 5.1 reads .ps1 as the system ANSI
# codepage (GBK on a Chinese Windows) unless the file has a UTF-8 BOM, which
# mangles non-ASCII text and can swallow a closing quote.
#
# Section A: environment check (works without Docker)
# Section B: verification -- Docker route if available, pnpm route otherwise

$ErrorActionPreference = "Continue"
$ProgressPreference    = "SilentlyContinue"

function Say ($m) { Write-Host "`n$m" -ForegroundColor Cyan }
function Ok  ($m) { Write-Host "  [ OK ] $m" -ForegroundColor Green }
function Note($m) { Write-Host "  [ -- ] $m" -ForegroundColor DarkYellow }
function Bad ($m) { Write-Host "  [FAIL] $m" -ForegroundColor Red }
function Dim ($m) { Write-Host "         $m" -ForegroundColor DarkGray }

# Script lives in <repo>/scripts, so the repo root is its parent.
$root = $PSScriptRoot
if (-not $root) { $root = (Get-Location).Path }
if ((Split-Path -Leaf $root) -eq "scripts") { $root = Split-Path -Parent $root }
Set-Location $root
Write-Host "TKOS verify -- root: $root"
Write-Host "PowerShell $($PSVersionTable.PSVersion)"

# ---------------------------------------------------------------- A. tooling
Say "=== A1. Tooling ==="

$has = @{}
foreach ($t in @("node","pnpm","docker","git")) {
  $cmd = Get-Command $t -ErrorAction SilentlyContinue
  $has[$t] = [bool]$cmd
  if ($cmd) {
    $v = (& $t --version 2>&1 | Select-Object -First 1)
    Ok "$t $v"
  } else {
    Note "$t  NOT INSTALLED"
  }
}

$has["dockerd"] = $false
if ($has["docker"]) {
  docker info 2>&1 | Out-Null
  if ($LASTEXITCODE -eq 0) {
    $has["dockerd"] = $true
    Ok "docker daemon running"
  } else {
    Note "docker installed but daemon not running -- start Docker Desktop, then rerun"
  }
}

# ------------------------------------------------------------------ A2. files
Say "=== A2. Files in place ==="

$need = @(
  "Dockerfile",
  ".dockerignore",
  "next.config.ts",
  "docker-compose.yml",
  ".env.docker.example",
  "src\app\api\health\route.ts",
  "scripts\resolve-request.json"
)
$missing = 0
foreach ($f in $need) {
  if (Test-Path $f) { Ok $f } else { Bad "$f  MISSING"; $missing++ }
}

if (Test-Path ".env.docker") {
  Ok ".env.docker exists"
} else {
  if (Test-Path ".env.docker.example") {
    Copy-Item ".env.docker.example" ".env.docker"
    Note ".env.docker created -- fill in TKOS_API_KEY and a model key, then rerun"
  }
}

# ------------------------------------------------------------- A3. reachability
# Read config out of .env.docker once -- used by A3 and A4.
function Get-EnvValue($name) {
  if (-not (Test-Path ".env.docker")) { return "" }
  foreach ($line in (Get-Content ".env.docker")) {
    if ($line -match ("^\s*" + $name + "\s*=\s*(.+?)\s*$")) {
      return $Matches[1].Trim().Trim([char]34, [char]39)
    }
  }
  return ""
}
$ontologyBase = Get-EnvValue "TKOS_ONTOLOGY_BASE_URL"
if (-not $ontologyBase) { $ontologyBase = "http://115.190.213.44:8000" }

Say "=== A3. Network reachability (this section is what I need back) ==="
Dim "401 / 403 means REACHABLE (just unauthenticated) -- that is a good result."
Dim "0 / timeout means NOT reachable."

# PowerShell 5.1 has no -SkipHttpErrorCheck, so non-2xx arrives as an exception.
function Probe($label, $url) {
  $code = 0
  $err  = ""
  try {
    $r = Invoke-WebRequest -Uri $url -Method GET -TimeoutSec 15 -UseBasicParsing -ErrorAction Stop
    $code = [int]$r.StatusCode
  } catch {
    if ($_.Exception.Response -ne $null) {
      try { $code = [int]$_.Exception.Response.StatusCode } catch { $code = 0 }
    }
    if ($code -eq 0) {
      $err = ($_.Exception.Message -split "`r?`n")[0]
    }
  }
  $pad = $label.PadRight(16)
  if ($code -ge 200 -and $code -lt 500) { Ok  "$pad HTTP $code" }
  elseif ($code -ge 500)                { Note "$pad HTTP $code" }
  else                                  { Bad "$pad UNREACHABLE  $err" }
  return $code
}

$results = @{}
$results["ontology"] = Probe "ontology-api"  "$ontologyBase/health"
$results["deepseek"] = Probe "deepseek"      "https://api.deepseek.com/v1/models"
$results["ark"]      = Probe "volcengine-ark" "https://ark.cn-beijing.volces.com/api/v3/models"
$results["bedrock"]  = Probe "aws-bedrock"   "https://bedrock-runtime.us-east-1.amazonaws.com/"

Say "=== A3 SUMMARY (copy these 4 lines back to me) ==="
foreach ($k in @("ontology","deepseek","ark","bedrock")) {
  Write-Host ("  {0,-16} {1}" -f $k, $results[$k])
}

if ($missing -gt 0) {
  Say "=== Stopping: $missing file(s) missing. ==="
  exit 1
}

# ------------------------------------------------- A4. ontology resolve sample
# Needs a real TKOS_API_KEY in .env.docker. Produces the file I need in order to
# write the ontology -> product-object mapping layer (Step 2).
Say "=== A4. Ontology resolve sample ==="

$apiKey = Get-EnvValue "TKOS_API_KEY"

if (-not $apiKey) {
  Note "TKOS_API_KEY not set in .env.docker -- skipped."
  Dim "fill it in and rerun; this step produces resolve-sample.json"
} elseif (-not (Test-Path "scripts\resolve-request.json")) {
  Note "resolve-request.json missing -- skipped"
} else {
  # POST the raw UTF-8 bytes of the request file. Do not let PowerShell 5.1
  # re-encode a string body: the query is Chinese and 5.1 defaults to Latin-1,
  # which corrupts it silently and comes back as a spurious 404.
  $bytes = [System.IO.File]::ReadAllBytes((Resolve-Path "scripts\resolve-request.json").Path)
  try {
    $resp = Invoke-WebRequest -Uri "$ontologyBase/v1/context-packs:resolve" -Method POST -UseBasicParsing -TimeoutSec 60 -Headers @{ "Authorization" = "Bearer $apiKey" } -ContentType "application/json; charset=utf-8" -Body $bytes -ErrorAction Stop
    $enc = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText((Join-Path $root "resolve-sample.json"), $resp.Content, $enc)
    Ok "resolve 200 -- wrote resolve-sample.json ($($resp.Content.Length) chars)"
    Dim "send me that file"
  } catch {
    $code = 0
    if ($_.Exception.Response -ne $null) {
      try { $code = [int]$_.Exception.Response.StatusCode } catch { $code = 0 }
    }
    if ($code -eq 401) { Bad "resolve 401 -- TKOS_API_KEY rejected" }
    elseif ($code -eq 404) { Bad "resolve 404 -- query matched no issue in the dataset" }
    elseif ($code -ne 0) { Bad "resolve HTTP $code" }
    else { Bad ("resolve failed: " + ($_.Exception.Message -split "`n")[0]) }
  }
}

# ------------------------------------------------------------------ B. verify
Say "=== B. Verification ==="

if ($has["dockerd"]) {
  Dim "Docker route: docker compose --env-file .env.docker up -d --build"
  docker compose --env-file .env.docker up -d --build
  if ($LASTEXITCODE -ne 0) {
    Bad "compose build failed -- send me the error output above"
    exit 1
  }

  Dim "waiting for services (ontology loads RDF + runs SHACL, ~30-60s)"
  $ready = $false
  for ($i = 1; $i -le 24; $i++) {
    Start-Sleep -Seconds 5
    try {
      $r = Invoke-WebRequest "http://localhost:8000/ready" -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop
      if ([int]$r.StatusCode -eq 200) { $ready = $true; break }
    } catch { }
    Write-Host ("         ...{0}s" -f ($i * 5)) -ForegroundColor DarkGray
  }
  if ($ready) { Ok "ontology /ready 200" }
  else { Bad "ontology not ready after 120s -- run: docker compose logs ontology" }

  try {
    $h = Invoke-WebRequest "http://localhost:3000/api/health" -TimeoutSec 10 -UseBasicParsing -ErrorAction Stop
    Ok "frontend /api/health $([int]$h.StatusCode)"
    Write-Host "         $($h.Content)" -ForegroundColor Gray
  } catch {
    Bad "frontend health check failed: $($_.Exception.Message)"
    Dim "run: docker compose logs frontend"
  }

  Say "Open http://localhost:3000 and click through the pages."
  Dim "stop with: docker compose down"

} else {
  Dim "No Docker daemon. Falling back to pnpm build (verifies the code, not the image)."
  try {
    if (-not $has["pnpm"]) {
      Note "pnpm missing. Run:  corepack enable ; corepack prepare pnpm@11.5.3 --activate"
      exit 1
    }
    Dim "pnpm install"
    pnpm install
    if ($LASTEXITCODE -ne 0) { Bad "pnpm install failed -- send me the error"; exit 1 }

    Dim "pnpm build  (checks that the next.config.ts change did not break anything)"
    pnpm build
    if ($LASTEXITCODE -ne 0) { Bad "pnpm build failed -- send me the error"; exit 1 }
    Ok "build passed"

    Say "Now run:  pnpm dev"
    Dim "then open  http://localhost:3000  and  http://localhost:3000/api/health"
  } finally { }
}

Say "=== Done. Send me (1) the A3 SUMMARY block  (2) resolve-sample.json if A4 worked ==="
