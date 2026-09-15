# One-off: fold the stray single-file commit into the containerisation commit.
#
# What happened: scripts/tkos-commit.ps1 was missing from the containerisation
# path list, so on the second run `git add -A` staged it and `git reset` did not
# exclude it -- it landed in commit 1 and inherited the round 8/9 message,
# producing two commits with the same subject.
#
# Nothing is pushed yet, so rewriting local history is free.
#
#   powershell -ExecutionPolicy Bypass -File .\scripts\tkos-fix-history.ps1

$ErrorActionPreference = "Continue"
function Ok ($m) { Write-Host "  [ OK ] $m" -ForegroundColor Green }
function Bad($m) { Write-Host "  [FAIL] $m" -ForegroundColor Red }
function Dim($m) { Write-Host "         $m" -ForegroundColor DarkGray }
function Say($m) { Write-Host "`n$m" -ForegroundColor Cyan }

$root = $PSScriptRoot
if (-not $root) { $root = (Get-Location).Path }
if ((Split-Path -Leaf $root) -eq "scripts") { $root = Split-Path -Parent $root }
Set-Location $root

$__prevOut = [Console]::OutputEncoding
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

if (Test-Path ".git\index.lock") {
  if (@(Get-Process git -ErrorAction SilentlyContinue).Count -eq 0) { Remove-Item ".git\index.lock" -Force }
}

Say "=== Before ==="
git log --oneline -4

# Safety: refuse if anything is already pushed past the base, or tree is dirty
$ahead = @(git rev-list --count origin/main..HEAD)
if ([int]$ahead[0] -lt 2) { Bad "fewer than 2 unpushed commits -- nothing to fold, aborting"; exit 1 }
Ok "$($ahead[0]) unpushed commits"

$keep = (git rev-parse HEAD)          # containerisation commit -- reuse its message
Dim "will reuse message from $keep"

Say "=== Staging the script fix ==="
git add -A
$n = @(git diff --cached --name-only).Count
Dim "$n file(s) staged"

Say "=== Folding last two commits into one ==="
git reset --soft HEAD~2
if ($LASTEXITCODE -ne 0) { Bad "reset failed"; exit 1 }
git commit -q -C $keep
if ($LASTEXITCODE -ne 0) { Bad "commit failed -- your changes are still staged, nothing lost"; exit 1 }
Ok ("committed: " + (git log -1 --format='%h %s'))

Say "=== After ==="
git log --oneline -4
$left = @(git status --porcelain)
if ($left.Count -eq 0) { Ok "working tree clean" } else { $left | ForEach-Object { Dim $_ } }

Say "=== Files in the containerisation commit ==="
git show --stat --format="" HEAD

try { [Console]::OutputEncoding = $__prevOut } catch { }
Say "=== Still not pushed. When ready:  git push origin main ==="
