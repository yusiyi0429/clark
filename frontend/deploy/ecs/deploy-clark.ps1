param(
  [string]$HostName = "115.191.26.230",
  [string]$UserName = "tokenhub-deploy",
  [string]$KeyPath = "C:\Users\10021\Desktop\clark\tokenhub-prod-ssh.pem",
  [switch]$RefreshSecrets
)

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$releaseId = (Get-Date -Format "yyyyMMddTHHmmss") + "-clark"
$archive = Join-Path $env:TEMP ($releaseId + ".tgz")
$target = "${UserName}@${HostName}"
$knownHosts = Join-Path $env:TEMP "tokenhub-prod-known_hosts"
$sshOptions = @(
  "-i", $KeyPath,
  "-o", "BatchMode=yes",
  "-o", "ConnectTimeout=12",
  "-o", "StrictHostKeyChecking=yes",
  "-o", "UserKnownHostsFile=$knownHosts",
  "-o", "KexAlgorithms=curve25519-sha256"
)
$started = [Diagnostics.Stopwatch]::StartNew()

try {
  & tar -czf $archive `
    --exclude=.git `
    --exclude=node_modules `
    --exclude=.next `
    --exclude=.next-* `
    --exclude=.data `
    --exclude=.env.local `
    --exclude=.env.development.local `
    --exclude=.env.docker `
    --exclude='*.tgz' `
    -C $projectRoot .
  if ($LASTEXITCODE -ne 0) { throw "Failed to create release archive." }

  $sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash.ToLowerInvariant()

  & scp @sshOptions `
    $archive `
    (Join-Path $PSScriptRoot "deploy-release.sh") `
    (Join-Path $PSScriptRoot "nginx-clark-internal.conf") `
    "${target}:/tmp/"
  if ($LASTEXITCODE -ne 0) { throw "Failed to upload release inputs." }

  if ($RefreshSecrets) {
    $envLocal = Join-Path $projectRoot ".env.local"

    # The manual radar used to dial out to the lab bench, so this spot warned when
    # TKOS_LAB_BASE_URL pointed at loopback (inside the container 127.0.0.1 is the
    # container itself). That whole link moved into this repo on 2026-08-31, so
    # there is no longer any runtime value that must differ between the dev box and
    # production -- .env.local can be shipped as-is.
    # (This file stays ASCII on purpose: PowerShell 5.1 reads a BOM-less UTF-8
    # script as the local ANSI codepage, which mangles non-ASCII and can break
    # string terminators outright.)

    & scp @sshOptions $envLocal "${target}:/tmp/clark-main.env"
    if ($LASTEXITCODE -ne 0) { throw "Failed to upload runtime secrets." }
  }

  $remoteSetup = "sudo install -m 755 /tmp/deploy-release.sh /usr/local/sbin/clark-deploy-release" +
    " && sudo install -m 644 /tmp/nginx-clark-internal.conf /etc/tokenhub/nginx-clark-internal.conf"
  if ($RefreshSecrets) {
    $remoteSetup += " && sudo install -m 600 /tmp/clark-main.env /etc/tokenhub/clark-main.env" +
      " && rm -f /tmp/clark-main.env"
  }

  & ssh @sshOptions $target $remoteSetup
  if ($LASTEXITCODE -ne 0) { throw "Failed to install release inputs." }

  & ssh @sshOptions $target `
    "sudo /usr/local/sbin/clark-deploy-release $releaseId /tmp/$releaseId.tgz $sha256"
  if ($LASTEXITCODE -ne 0) { throw "Clark deployment failed." }
}
finally {
  if (Test-Path $archive) { Remove-Item -LiteralPath $archive -Force }
  $started.Stop()
}

Write-Output ("release={0}" -f $releaseId)
Write-Output ("total_seconds={0}" -f [math]::Round($started.Elapsed.TotalSeconds, 1))
