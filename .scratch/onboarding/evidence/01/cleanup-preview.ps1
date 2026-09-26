# Remove only this ticket's two preview copies, unlinking junctions before recursion.
$workspacePath = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../../..'))
$onboardingPath = Join-Path $workspacePath '.scratch/onboarding'
foreach ($copyName in @('preview-web', 'runtime-web')) {
  $copyPath = [System.IO.Path]::GetFullPath((Join-Path $onboardingPath $copyName))
  if (-not $copyPath.StartsWith($onboardingPath + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Path outside ticket directory' }
  if (-not (Test-Path -LiteralPath $copyPath)) { continue }
  $resolvedCopy = (Resolve-Path -LiteralPath $copyPath).Path
  if ($resolvedCopy -ne $copyPath) { throw 'Unexpected preview path' }
  foreach ($linkName in @('node_modules', 'src', 'public')) {
    $linkPath = Join-Path $copyPath $linkName
    if (Test-Path -LiteralPath $linkPath) {
      $link = Get-Item -LiteralPath $linkPath -Force
      if ($link.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
        # Non-recursive Directory.Delete removes the junction itself, never its target.
        [System.IO.Directory]::Delete($linkPath)
      }
    }
  }
  $otherLinks = @(Get-ChildItem -LiteralPath $copyPath -Recurse -Force | Where-Object { $_.Attributes -band [System.IO.FileAttributes]::ReparsePoint })
  if ($otherLinks.Count) { throw 'Unexpected reparse points; refusing recursive cleanup' }
  Remove-Item -LiteralPath $copyPath -Recurse -Force
  Write-Output "Removed own preview: $copyName"
}
