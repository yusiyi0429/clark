$workspacePath = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../../..'))
$appsPath = Join-Path $workspacePath 'apps'
$previewPath = [System.IO.Path]::GetFullPath((Join-Path $appsPath 'web-01q'))
if (-not $previewPath.StartsWith($appsPath + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Outside workspace apps directory' }
if (Get-NetTCPConnection -State Listen -LocalPort 3600 -ErrorAction SilentlyContinue) { throw 'Stop the owned dev session before cleanup' }
if (Test-Path -LiteralPath $previewPath) {
  if ((Resolve-Path -LiteralPath $previewPath).Path -ne $previewPath) { throw 'Unexpected resolved preview path' }
  $linkPath = Join-Path $previewPath 'node_modules'
  $link = Get-Item -LiteralPath $linkPath -Force
  if (-not ($link.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { throw 'Expected dependency junction' }
  [System.IO.Directory]::Delete($linkPath)
  $otherLinks = @(Get-ChildItem -LiteralPath $previewPath -Recurse -Force | Where-Object { $_.Attributes -band [System.IO.FileAttributes]::ReparsePoint })
  if ($otherLinks.Count) { throw 'Unexpected reparse points' }
  Remove-Item -LiteralPath $previewPath -Recurse -Force
}
'Removed apps/web-01q after detaching node_modules junction; originals retained.'
Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in 3100,3200,3400,3600,4000,4100,4400,4600 } | Select-Object LocalPort,OwningProcess | ConvertTo-Json
foreach ($path in 'apps/web/src','apps/web/public','apps/web/node_modules') { "$path exists: $(Test-Path -LiteralPath (Join-Path $workspacePath $path))" }
