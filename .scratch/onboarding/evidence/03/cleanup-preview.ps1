$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../../../..')).Path
$preview = [System.IO.Path]::GetFullPath((Join-Path $repo 'apps/web-03-preview'))
$source = [System.IO.Path]::GetFullPath((Join-Path $repo 'apps/web'))
$apps = [System.IO.Path]::GetFullPath((Join-Path $repo 'apps'))
if ((Split-Path -Parent $preview) -ne $apps -or (Split-Path -Leaf $preview) -ne 'web-03-preview' -or $preview -eq $source -or -not $preview.StartsWith($repo + '\')) { throw 'Unexpected cleanup target' }
$fixturePath = Join-Path $PSScriptRoot 'browser-fixture.json'
if (Test-Path -LiteralPath $fixturePath) {
  $fixture = Get-Content -LiteralPath $fixturePath -Raw | ConvertFrom-Json
  if ($fixture.ready) {
    & node (Join-Path $PSScriptRoot 'browser-control.cjs') close | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'browser-cleanup.json')
    if ($LASTEXITCODE -ne 0) { throw 'API fixture did not acknowledge cleanup; do not assume its temporary database was removed' }
  }
}
$hashes = @()
if (Test-Path -LiteralPath $preview) {
  $previewInfo = Get-Item -LiteralPath $preview
  if ($previewInfo.LinkType) { throw 'Preview root must be a physical directory' }
  $hashes = @(foreach ($folder in @('src','public')) {
    foreach ($file in Get-ChildItem -LiteralPath (Join-Path $source $folder) -File -Recurse) {
      $relative = [System.IO.Path]::GetRelativePath($source, $file.FullName)
      $copied = Join-Path $preview $relative
      [pscustomobject]@{file=$relative;match=((Test-Path -LiteralPath $copied) -and ((Get-FileHash -LiteralPath $file.FullName).Hash -eq (Get-FileHash -LiteralPath $copied).Hash))}
    }
  })
  $hashes | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'browser-source-hashes.json')
  if (@($hashes | Where-Object { -not $_.match }).Count) { throw 'Source copy mismatch; sync and re-verify the final code before cleanup' }
  $webProcess = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'web-preview-process.json') -Raw | ConvertFrom-Json
  if ($webProcess.preview -ne $preview -or $webProcess.port -ne 3500) { throw 'Unexpected preview process metadata' }
  $processes = @(Get-CimInstance Win32_Process)
  $rootProcess = $processes | Where-Object { $_.ProcessId -eq $webProcess.pid }
  if ($rootProcess -and ($rootProcess.Name -ne 'node.exe' -or $rootProcess.CommandLine -notmatch 'next.+dev.+3500')) { throw 'Preview PID no longer identifies this Next dev server' }
  $owned = @([int]$webProcess.pid)
  do {
    $newChildren = @($processes | Where-Object { $_.ParentProcessId -in $owned -and $_.ProcessId -notin $owned } | Select-Object -ExpandProperty ProcessId)
    $owned += $newChildren
  } while ($newChildren.Count -gt 0)
  $protected = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in 3100,3200,3400,4000,4100,4400 } | Select-Object -ExpandProperty OwningProcess)
  if (@($owned | Where-Object { $_ -in $protected }).Count) { throw 'Protected service in cleanup set' }
  foreach ($ownedId in ($owned | Sort-Object -Descending)) { Stop-Process -Id $ownedId -Force -ErrorAction SilentlyContinue }
  $junction = Join-Path $preview 'node_modules'
  if ((Get-Item -LiteralPath $junction).LinkType -ne 'Junction') { throw 'Expected node_modules junction' }
  [System.IO.Directory]::Delete($junction)
  if (Test-Path -LiteralPath $junction) { throw 'Junction still present' }
  Remove-Item -LiteralPath $preview -Recurse -Force
}
$ports = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in 3100,3200,3400,3500,4000,4100,4400,4500 } | Select-Object LocalPort,OwningProcess)
[pscustomobject]@{previewRemoved= -not (Test-Path -LiteralPath $preview);sourceNodeModulesPresent=(Test-Path -LiteralPath (Join-Path $source 'node_modules'));sourceFilesCompared=$hashes.Count;allHashesMatched= -not @($hashes | Where-Object { -not $_.match }).Count;ports=$ports} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'cleanup-result.json')
Get-Content -LiteralPath (Join-Path $PSScriptRoot 'cleanup-result.json')

