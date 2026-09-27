$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '../../../..')).Path
$web = Join-Path $repo 'apps/web'
$preview = Join-Path $repo 'apps/web-gap04-preview'
if (Get-NetTCPConnection -State Listen -LocalPort 3500 -ErrorAction SilentlyContinue) { throw 'Port 3500 is already occupied; no existing process will be stopped' }
if (Test-Path -LiteralPath $preview) { throw 'Preview directory already exists' }
New-Item -ItemType Directory -Path $preview | Out-Null
foreach ($name in @('src', 'public', 'package.json', 'tsconfig.json', 'next-env.d.ts', 'next.config.ts', 'postcss.config.mjs')) {
  $source = Join-Path $web $name
  if (Test-Path -LiteralPath $source) { Copy-Item -LiteralPath $source -Destination (Join-Path $preview $name) -Recurse }
}
New-Item -ItemType Junction -Path (Join-Path $preview 'node_modules') -Target (Join-Path $web 'node_modules') | Out-Null
$env:API_SERVER_URL = 'http://127.0.0.1:4500'
$env:NEXT_TELEMETRY_DISABLED = '1'
$next = Join-Path $web 'node_modules/next/dist/bin/next'
$process = Start-Process -FilePath (Get-Command node).Source -ArgumentList @($next, 'dev', '-p', '3500', '--hostname', '127.0.0.1') -WorkingDirectory $preview -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $PSScriptRoot 'web-server.log') -RedirectStandardError (Join-Path $PSScriptRoot 'web-server-error.log')
@{ pid = $process.Id; preview = $preview; port = 3500 } | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'web-preview-process.json')
@{ pid = $process.Id; port = 3500 } | ConvertTo-Json -Compress


