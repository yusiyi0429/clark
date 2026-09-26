$workspacePath = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../../..'))
$scratchPath = Join-Path $workspacePath '.scratch'
$previewPath = [System.IO.Path]::GetFullPath((Join-Path $scratchPath 'preview-web-01p'))
if (-not $previewPath.StartsWith($scratchPath + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Outside workspace scratch directory' }
if (-not (Test-Path -LiteralPath $previewPath)) { return }
if ((Resolve-Path -LiteralPath $previewPath).Path -ne $previewPath) { throw 'Unexpected resolved preview path' }
$linkPath = Join-Path $previewPath 'node_modules'
if (Test-Path -LiteralPath $linkPath) {
  $link = Get-Item -LiteralPath $linkPath -Force
  if (-not ($link.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { throw 'Expected dependency junction' }
  [System.IO.Directory]::Delete($linkPath)
}
$otherLinks = @(Get-ChildItem -LiteralPath $previewPath -Recurse -Force | Where-Object { $_.Attributes -band [System.IO.FileAttributes]::ReparsePoint })
if ($otherLinks.Count) { throw 'Unexpected reparse points; refusing recursive cleanup' }
Remove-Item -LiteralPath $previewPath -Recurse -Force
'Removed only .scratch/preview-web-01p; source/dependency directories retained'
