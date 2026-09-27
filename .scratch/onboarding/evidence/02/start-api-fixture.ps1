$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../../../..')).Path
if (Get-NetTCPConnection -State Listen -LocalPort 4500 -ErrorAction SilentlyContinue) { throw 'Port 4500 is already occupied; no existing process will be stopped' }
$portsFile = Join-Path $PSScriptRoot 'ports-before.json'
if (-not (Test-Path -LiteralPath $portsFile)) {
  @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in 3100,3200,3400,3500,4000,4100,4400,4500 } | Select-Object LocalPort,OwningProcess) | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath $portsFile
}
$runner = Join-Path $repo 'apps/api/node_modules/tsx/dist/cli.mjs'
$fixture = Join-Path $PSScriptRoot 'radar-server.ts'
$process = Start-Process -FilePath (Get-Command node).Source -ArgumentList @($runner, $fixture) -WorkingDirectory $repo -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $PSScriptRoot 'api-server.log') -RedirectStandardError (Join-Path $PSScriptRoot 'api-server-error.log')
@{ launcherPid = $process.Id; port = 4500; fixture = $fixture } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'api-launch-process.json')
@{ launcherPid = $process.Id; port = 4500 } | ConvertTo-Json -Compress
