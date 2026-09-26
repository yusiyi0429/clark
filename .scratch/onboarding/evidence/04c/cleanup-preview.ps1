$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '../../../..')).Path
$preview = (Resolve-Path (Join-Path $repo 'apps/web-04c-preview')).Path
$expected = [IO.Path]::GetFullPath((Join-Path $repo 'apps/web-04c-preview'))
if ($preview -ne $expected -or !(Split-Path $preview -Parent).Equals((Join-Path $repo 'apps'), [StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected preview directory' }
$meta = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'web-preview-process.json') -Raw | ConvertFrom-Json
if ($meta.preview -ne $preview -or $meta.port -ne 3500) { throw 'Unexpected preview process metadata' }
$processes = @(Get-CimInstance Win32_Process)
$tree = [Collections.Generic.List[int]]::new()
$tree.Add([int]$meta.pid)
for ($index=0; $index -lt $tree.Count; $index++) {
  foreach ($child in $processes | Where-Object ParentProcessId -eq $tree[$index]) { if (!$tree.Contains([int]$child.ProcessId)) {$tree.Add([int]$child.ProcessId)} }
}
foreach ($id in @($tree.ToArray()) | Sort-Object -Descending) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 600
if (Get-Process -Id $tree.ToArray() -ErrorAction SilentlyContinue) { throw 'Preview process still exists' }
if (Get-NetTCPConnection -State Listen -LocalPort 3500 -ErrorAction SilentlyContinue) { throw '3500 is still in use; refusing directory removal' }
$link = Get-Item -LiteralPath (Join-Path $preview 'node_modules')
if ($link.LinkType -ne 'Junction' -or $link.Target -ne (Join-Path $repo 'apps/web/node_modules')) { throw 'Unexpected dependency junction' }
$link.Delete()
if (Get-ChildItem -LiteralPath $preview -Recurse -Force | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }) { throw 'Unexpected remaining reparse point' }
Remove-Item -LiteralPath $preview -Recurse -Force
$ports = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object LocalPort -in @(3100,3200,3400,4000,4100,4400,3500,4500) | Select-Object LocalPort,OwningProcess)
@{ previewRemoved=!(Test-Path -LiteralPath $preview); stoppedPids=$tree.ToArray(); ports=$ports; sourceIntact=(Test-Path -LiteralPath (Join-Path $repo 'apps/web/src')); dependenciesIntact=(Test-Path -LiteralPath (Join-Path $repo 'apps/web/node_modules')) } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'cleanup-preview.json')
