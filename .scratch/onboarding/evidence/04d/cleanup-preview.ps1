$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path -LiteralPath '.').Path
$preview = [System.IO.Path]::GetFullPath((Join-Path $repo 'apps/web-04d-preview'))
$expected = 'C:\Users\10021\Desktop\clark\Tianshu-MVP\apps\web-04d-preview'
if ($preview -ne $expected -or -not $preview.StartsWith($repo + '\')) { throw 'Unexpected cleanup target' }
$source = Join-Path $repo 'apps/web'
$hashes = foreach ($folder in @('src','public')) {
  foreach ($file in Get-ChildItem -LiteralPath (Join-Path $source $folder) -File -Recurse) {
    $relative = [System.IO.Path]::GetRelativePath($source, $file.FullName)
    $copied = Join-Path $preview $relative
    $match = (Test-Path -LiteralPath $copied) -and ((Get-FileHash -LiteralPath $file.FullName).Hash -eq (Get-FileHash -LiteralPath $copied).Hash)
    [pscustomobject]@{file=$relative;match=$match}
  }
}
$hashes | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath '.scratch/onboarding/evidence/04d/browser-source-hashes.json'
if (@($hashes | Where-Object { -not $_.match }).Count) { throw 'Source copy mismatch' }
$owned = @(66624,67800,33456,33196,43340,64876,66436,19184,17508)
$protected = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in 3100,3200,3400,4000,4100,4400 } | Select-Object -ExpandProperty OwningProcess)
if (@($owned | Where-Object { $_ -in $protected }).Count) { throw 'Protected service in cleanup set' }
foreach ($id in $owned) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
$junction = Join-Path $preview 'node_modules'
if ((Get-Item -LiteralPath $junction).LinkType -ne 'Junction') { throw 'Expected node_modules junction' }
[System.IO.Directory]::Delete($junction)
if (Test-Path -LiteralPath $junction) { throw 'Junction still present' }
Remove-Item -LiteralPath $preview -Recurse -Force
$ports = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in 3100,3200,3400,3500,4000,4100,4400,4500 } | Select-Object LocalPort,OwningProcess)
[pscustomobject]@{previewRemoved= -not (Test-Path -LiteralPath $preview);sourceNodeModulesPresent=(Test-Path -LiteralPath (Join-Path $source 'node_modules'));sourceFilesCompared=$hashes.Count;allHashesMatched=$true;ports=$ports} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath '.scratch/onboarding/evidence/04d/cleanup-result.json'
Get-Content -LiteralPath '.scratch/onboarding/evidence/04d/cleanup-result.json'
