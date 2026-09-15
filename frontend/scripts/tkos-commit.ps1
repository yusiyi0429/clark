# TKOS -- commit the working tree in two logical commits.
#
#   cd <repo>\clark-main
#   powershell -ExecutionPolicy Bypass -File .\scripts\tkos-commit.ps1
#
# Why a script instead of running git from the agent side: the repo is reached
# through a mount that forbids unlink(), so git creates .git/index.lock and then
# cannot remove it -- every later git call is blocked by a lock git made itself.
# Git has to run natively on Windows.
#
# Commit messages are Chinese, so they are embedded base64 and written to temp
# UTF-8 files, then passed via `git commit -F`. This script stays pure ASCII, so
# Windows PowerShell 5.1 (which reads .ps1 as GBK without a BOM) cannot mangle it.
#
# This script does NOT push. Review the two commits first, then push yourself.

# NOT "Stop": PowerShell turns any stderr output from a native command into a
# terminating NativeCommandError under Stop, and git writes its LF/CRLF
# normalisation warnings to stderr. We check $LASTEXITCODE explicitly instead.
$ErrorActionPreference = "Continue"

# git speaks UTF-8; the console defaults to the ANSI codepage (GBK on a Chinese
# Windows), which renders Chinese commit subjects as mojibake. Display only --
# the stored commit object is UTF-8 either way.
$__prevOut = [Console]::OutputEncoding
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
function Say ($m) { Write-Host "`n$m" -ForegroundColor Cyan }
function Ok  ($m) { Write-Host "  [ OK ] $m" -ForegroundColor Green }
function Note($m) { Write-Host "  [ -- ] $m" -ForegroundColor DarkYellow }
function Bad ($m) { Write-Host "  [FAIL] $m" -ForegroundColor Red }
function Dim ($m) { Write-Host "         $m" -ForegroundColor DarkGray }

$root = $PSScriptRoot
if (-not $root) { $root = (Get-Location).Path }
if ((Split-Path -Leaf $root) -eq "scripts") { $root = Split-Path -Parent $root }
Set-Location $root
Write-Host "repo: $root"

if (-not (Test-Path ".git")) { Bad "not a git repo"; exit 1 }

# ---------------------------------------------------------------- stale lock
Say "=== Stale lock ==="
# Age is a bad proxy for "is this lock live". The real question is whether any
# git process is actually holding it. A lock with no git process behind it is
# stale no matter how fresh its timestamp is -- which is exactly what happens
# when git runs over a mount that forbids unlink(): it writes index.lock, then
# cannot remove it, and every later call trips over a lock git made itself.
if (Test-Path ".git\index.lock") {
  $age  = (Get-Date) - (Get-Item ".git\index.lock").LastWriteTime
  $live = @(Get-Process git -ErrorAction SilentlyContinue)
  Note ("index.lock exists, age {0:N1} min, git processes running: {1}" -f $age.TotalMinutes, $live.Count)
  if ($live.Count -eq 0) {
    Remove-Item ".git\index.lock" -Force
    Ok "removed -- no git process was holding it"
  } elseif ($age.TotalMinutes -gt 5) {
    Remove-Item ".git\index.lock" -Force
    Ok "removed -- git is running but this lock is over 5 min old"
  } else {
    Bad "a git process is running and the lock is fresh -- wait for it, or close VS Code's git panel, then rerun"
    $live | ForEach-Object { Dim ("  pid {0} started {1}" -f $_.Id, $_.StartTime) }
    exit 1
  }
} else { Ok "no lock" }

# ------------------------------------------------------------------ identity
Say "=== Identity ==="
$n = (git config user.name)  2>$null
$e = (git config user.email) 2>$null
if (-not $n -or -not $e) {
  git config --local user.name  "Sean Sun"
  git config --local user.email "wezvwolf@gmail.com"
  Note "identity was unset -- set repo-local to match your existing commits"
}
Ok ("{0} <{1}>" -f (git config user.name), (git config user.email))

# -------------------------------------------------------------------- status
Say "=== Working tree ==="
$before = @(git status --porcelain)
Dim ("{0} entries" -f $before.Count)
if ($before.Count -eq 0) { Ok "nothing to commit"; exit 0 }

# Anything that must never be committed
$danger = $before | Where-Object { $_ -match "\.env\.local|\.env\.docker$|\.tgz|node_modules|\.next/" }
if ($danger) { Bad "refusing -- these should not be committed:"; $danger | ForEach-Object { Write-Host "    $_" }; exit 1 }
Ok "no secrets / build output in the change set"

# ------------------------------------------------- commit message temp files
$tmp1 = Join-Path $env:TEMP "tkos-msg1.txt"
$tmp2 = Join-Path $env:TEMP "tkos-msg2.txt"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

$MSG1_B64 = -join @(
  "cm91bmQgOC8577ya5r2c5Zyo6K6u6aKY6K+m5oOF6aG144CB5o6i6K6o6ZO+6Lev5Zu+6YeN5YGa44CB5Lya6K6u5Lik5oyhCgot",
  "IOaWsOWiniAvc2lnbmFscy9baWRdIOa9nOWcqOiurumimOivpuaDhe+8muW3puS+p+eqhOagjyArIOWPs+S+p+Wvueivne+8jOaV",
  "heaEj+S4jeaUvumTvui3r+WbvgogIO+8iOi/meS4gOmhteeahOS7u+WKoeaYr+WIpOaWreWAvOS4jeWAvOW+l++8jOS4jeaYr+W9",
  "ouaIkOWIpOaWre+8iQotIOaOouiuqOmTvui3r+WbviBwcm9iZS1tYXAg6YeN5YaZ5Li657yp6L+b5qCR6ICM6Z2e6IqC54K55Zu+",
  "IOKAlOKAlCDljYrlsY/lrr3luqbkuIvoioLngrnlm77lv4XnhLbmiorplb/lj6UKICDljovmiJDljYHmnaXkuKrlrZfnmoTmoIfn",
  "rb7vvIzogIzov5nlvKDlm77kuIrmnIDlgLzpkrHnmoTmgbDmgbDmmK/plb/lj6UKLSDkvJrorq7lkIjlubbkuLrkuKTmjKEgL21l",
  "ZXRpbmdzP3N0YWdlPXByZXxwb3N077ybL2lzc3Vlcy9baWRdL2JyaWVmIOaUueS4uumHjeWumuWQkQotIOWIoOaOieaKiuWFs+WM",
  "uuS4juOAjOW4puS4iuS8muOAjeaVtOadoemTvui3r++8mlByb2JlU3RhbmRpbmcg55qE6JC954K55qGj5pS55ZCNIGRpcmVjdGlv",
  "bu+8jAogIHF1ZXVlRm9yTWVldGluZyAvIGRlcXVldWVGcm9tTWVldGluZyAvIHNlbmRDYW5kaWRhdGVUb01lZXRpbmcg5LiJ5Liq",
  "IEFQSSDnp7vpmaQKLSDliKDmjonov73liqDosIPmn6XvvIhJclJlc2VhcmNoRG9jIC8gc3RhcnRJclJlc2VhcmNo77yJ44CB5q+P",
  "5pel5LiK6ZmQ44CB5LqU5qC85rWB56iL5p2h44CB5oiQ6Imy5b6956ugCi0g5paw5aKe5Li76aG16am+6am26Iix44CB6K6u6aKY",
  "5LiO5L+h5Y+35rWB5rC06aG144CB5b6F5a6a5Yy644CB55uu5qCH5Y+q6K+75qCRCi0g6LSd5aOz5qGI5LiO5ZCv5Yqo5pyf5qGI",
  "5YWl56eN5a2Q77yIc2VlZC1iZWlrZSAvIHNlZWQtbGF1bmNo77yJCgpDby1BdXRob3JlZC1CeTogQ2xhdWRlIE9wdXMgNSA8bm9y",
  "ZXBseUBhbnRocm9waWMuY29tPgpDbGF1ZGUtU2Vzc2lvbjogaHR0cHM6Ly9jbGF1ZGUuYWkvY29kZS9zZXNzaW9uXzAxUVg3WkR6",
  "Y0NtNTdZdnhDZjk1VkpEeQo="
)

$MSG2_B64 = -join @(
  "5a655Zmo5YyW77yac3RhbmRhbG9uZSDkuqfnianjgIFEb2NrZXJmaWxl44CB5YGl5bq35o6i6ZKICgotIG5leHQuY29uZmlnLnRz",
  "IOW8gCBvdXRwdXQ6ICJzdGFuZGFsb25lIu+8m+e7mSAvYXBpL2NoYXQg6KGlIG5vLXRyYW5zZm9ybSDkuI4KICBYLUFjY2VsLUJ1",
  "ZmZlcmluZzogbm/vvIhTU0Ug5Zyo5Y+N5Luj5ZCO6Z2i5b+F6aG75YWz57yT5Yay77yJCi0gRG9ja2VyZmlsZSDlm5vmrrXlvI8g",
  "YmFzZS9kZXBzL2J1aWxkL3J1bm5lcu+8jOmdniByb290IOi/kOihjO+8jOW4piBoZWFsdGhjaGVjawogIMK3IOS4jeeUqCBjb3Jl",
  "cGFjayDigJTigJQg5a6D5YaZ5q27IHJlZ2lzdHJ5Lm5wbWpzLm9yZ++8jOWbveWGheS4jeWPr+i+vuS4lOaXoOazleaMh+WQkemV",
  "nOWDj+a6kO+8mwogICAg5pS555SoIG5wbSBpIC1nIHBucG3vvIxyZWdpc3RyeSDnlLEgTlBNX1JFR0lTVFJZIOWPguaVsOaOp+WI",
  "tu+8jOm7mOiupCBucG1taXJyb3IKICDCtyBiYXNlIOWxguWPquijheS4gOasoSBwbnBt77yaYnVpbGRraXQg5bm26KGM6LeRIGRl",
  "cHMg5LiOIGJ1aWxk77yM5Lik5LiqIHN0YWdlIOWQhOijheS4gOmBjeS8muWBtuWPkeWksei0pQotIGFwaS9zcGVhayDkuI4gYXBp",
  "L3R0cy9wcmVnZW4g55qEIHByb2Nlc3MuY3dkKCkg5YqgIHR1cmJvcGFja0lnbm9yZeOAggogIOi/kOihjOaXtui3r+W+hOS8muiu",
  "qemdmeaAgeWIhuaekOaKiuaVtOS4qumhueebru+8iHNyYy/jgIFkb2NzL+OAgWFzc2V0cy/jgIFERUNJU0lPTlMubWTjgIFIQU5E",
  "T0ZGLm1k77yJCiAgdHJhY2Ug6L+bIHNlcnZlciDkuqfnianvvJvliqDkuIrkuYvlkI4gc3RhbmRhbG9uZSDlj6rliakgbm9kZV9t",
  "b2R1bGVzIC8gcGFja2FnZS5qc29uIC8KICBzZXJ2ZXIuanMgLyAubmV4dAotIOaWsOWiniAvYXBpL2hlYWx0aCDlrZjmtLvmjqLp",
  "kojvvIzlm57miqXkuIvmuLjphY3nva7mmK/lkKblsLHkvY3vvIjlj6rmiqUgdHJ1ZS9mYWxzZe+8jOS4jeaatOmcsuWAvO+8iQot",
  "IGRvY2tlci1jb21wb3NlLnltbCDlj6rmnoTlu7rmnKzku5PlupPjgILmnKzkvZMgUnVudGltZSBBUEkg5piv5aSW6YOo5L6d6LWW",
  "77yM55SxIE9udG9sb2d5IOWfn+mDqOe9su+8jAogIOmAmui/hyBUS09TX09OVE9MT0dZX0JBU0VfVVJMIOaMh+WQke+8m+eUqOeb",
  "uOWvuei3r+W+hOWOu+aehOW7uueItuebruW9leeahOWFhOW8n+mhueebruWcqOS7u+S9leaehOW7uuacuuS4iumDveS8muaWrQot",
  "IC5naXRpZ25vcmUg55qEIC5lbnYqIOaKiuaooeadv+aWh+S7tuS5n+WQg+S6hu+8jOWKoCAhLmVudi5leGFtcGxlIOS4jiAhLmVu",
  "di5kb2NrZXIuZXhhbXBsZQotIHNjcmlwdHMvdGtvcy12ZXJpZnkucHMx77ya546v5aKD5L2T5qOA44CB5Ye6572R5o6i5rWL44CB",
  "5pys5L2TIHJlc29sdmUg5Y+W5qC3Cgrlt7Lpqozor4HvvJpwbnBtIGJ1aWxkIOmAmui/h++8jHN0YW5kYWxvbmUg54us56uL6L+Q",
  "6KGM5pe2IDEzIOS4qumhtemdouWFqCAyMDDjgIHpnZnmgIHotYTmupAgMjAw44CBCuWBpeW6t+aOoumSiOato+W4uOOAgemmlumh",
  "tea4suafk+WHuuecn+WGheWuuQoKQ28tQXV0aG9yZWQtQnk6IENsYXVkZSBPcHVzIDUgPG5vcmVwbHlAYW50aHJvcGljLmNvbT4K",
  "Q2xhdWRlLVNlc3Npb246IGh0dHBzOi8vY2xhdWRlLmFpL2NvZGUvc2Vzc2lvbl8wMVFYN1pEemNDbTU3WXZ4Q2Y5NVZKRHkK"
)


$MSG3_B64 = -join @(
  "5YqgIC5naXRhdHRyaWJ1dGVzIOW5tuaMieWug+mHjeaWsOinhOiMg+WMluihjOWwvgoK5LuT5bqT5LiA55u05rKh5pyJIC5naXRh",
  "dHRyaWJ1dGVz77yM6KGM5bC+5a6M5YWo5Lqk57uZ5ZCE5Lq655qEIGNvcmUuYXV0b2NybGbjgILnu5PmnpzmmK/vvJoKTGludXgg",
  "5L6n5YaZ5YWl55qE5paH5Lu25pivIExG44CBV2luZG93cyDkvqcgY2hlY2tvdXQg5Ye65p2l55qE5pivIENSTEbvvIzkuKTovrnk",
  "uIDnorDlsLHkuqfnlJ8KIuWGheWuueS4gOS4quWtl+ayoeWPmOOAgeaVtOS4quaWh+S7tumDveeul+aUueS6hiLnmoTlgYcgZGlm",
  "ZiDigJTigJQgcG5wbS13b3Jrc3BhY2UueWFtbCDlt7Lnu4/lm6DmraQK6KKr6K+v5Yik6L+H5LiA5qyh44CCCgrnjrDlnKjnu5/k",
  "uIDkuLrku5PlupPlhoXlkozlt6XkvZzljLrpg73nlKggTEbvvIgucHMxIOS+i+Wklu+8jOS/neaMgSBDUkxG77yJ77yM5LqM6L+b",
  "5Yi25pi+5byP5qCHIGJpbmFyeeOAggrlrZfkvZPpgqPmnaHlsKTlhbbopoHntKfvvJpzcmMvYXBwL2ZvbnRzLyoud29mZjIg6KKr",
  "6KGM5bC+6L2s5o2i5pS55Z2P5Lya6K6pIG5leHQgYnVpbGQg5Lul5LiA5p2hCueci+S4jeWHuuWOn+WboOeahCBUdXJib3BhY2sg",
  "cGFuaWMg5aSx6LSl44CCCgrmnKzmrKHmj5DkuqTmmK8gZ2l0IGFkZCAtLXJlbm9ybWFsaXplIC4g55qE57uT5p6c77yM5Y+q5pyJ",
  "6KGM5bC+5Y+Y5YyW77yM5rKh5pyJ5YaF5a655Y+Y5YyW44CCCgpDby1BdXRob3JlZC1CeTogQ2xhdWRlIE9wdXMgNSA8bm9yZXBs",
  "eUBhbnRocm9waWMuY29tPgpDbGF1ZGUtU2Vzc2lvbjogaHR0cHM6Ly9jbGF1ZGUuYWkvY29kZS9zZXNzaW9uXzAxUVg3WkR6Y0Nt",
  "NTdZdnhDZjk1VkpEeQo="
)

[System.IO.File]::WriteAllBytes($tmp1, [Convert]::FromBase64String($MSG1_B64))
[System.IO.File]::WriteAllBytes($tmp2, [Convert]::FromBase64String($MSG2_B64))

# ----------------------------------------------------- the containerisation set
# Everything else is your round 8/9 product work.
$deployPaths = @(
  "Dockerfile",
  ".dockerignore",
  "docker-compose.yml",
  ".env.example",
  ".env.docker.example",
  ".gitignore",
  ".gitattributes",
  "next.config.ts",
  "src/app/api/health/route.ts",
  "src/app/api/speak/route.ts",
  "src/app/api/tts/pregen/route.ts",
  "scripts/tkos-verify.ps1",
  "scripts/tkos-commit.ps1",
  "scripts/resolve-request.json"
)

# ------------------------------------------------------------------ commit 1
Say "=== Commit 1/2 -- round 8/9 product work ==="
git add -A
if ($LASTEXITCODE -ne 0) { Bad "git add failed"; exit 1 }
foreach ($p in $deployPaths) { git reset -q -- $p | Out-Null }

$staged1 = @(git diff --cached --name-only)
if ($staged1.Count -eq 0) {
  Note "nothing left for commit 1 -- skipping"
} else {
  Dim ("{0} files" -f $staged1.Count)
  git commit -q -F $tmp1
  if ($LASTEXITCODE -ne 0) { Bad "commit 1 failed"; exit 1 }
  Ok ("committed: " + (git log -1 --format='%h %s'))
}

# ------------------------------------------------------------------ commit 2
Say "=== Commit 2/2 -- containerisation ==="
foreach ($p in $deployPaths) { if (Test-Path $p) { git add -- $p } }
$staged2 = @(git diff --cached --name-only)
if ($staged2.Count -eq 0) {
  Note "nothing to commit for containerisation"
} else {
  $staged2 | ForEach-Object { Dim $_ }
  git commit -q -F $tmp2
  if ($LASTEXITCODE -ne 0) { Bad "commit 2 failed"; exit 1 }
  Ok ("committed: " + (git log -1 --format='%h %s'))
}

# ------------------------------------------------------- commit 3 (renormalise)
Say "=== Commit 3/3 -- line-ending renormalisation ==="
if (Test-Path ".gitattributes") {
  git add --renormalize .
  $staged3 = @(git diff --cached --name-only)
  if ($staged3.Count -eq 0) {
    Ok "nothing to renormalise -- tree already matches .gitattributes"
  } else {
    Dim ("{0} files renormalised (line endings only, no content change)" -f $staged3.Count)
    $tmp3 = Join-Path $env:TEMP "tkos-msg3.txt"
    [System.IO.File]::WriteAllBytes($tmp3, [Convert]::FromBase64String($MSG3_B64))
    git commit -q -F $tmp3
    if ($LASTEXITCODE -ne 0) { Bad "commit 3 failed" } else { Ok ("committed: " + (git log -1 --format='%h %s')) }
    Remove-Item $tmp3 -Force -ErrorAction SilentlyContinue
  }
} else {
  Note ".gitattributes not present -- skipped"
}

Remove-Item $tmp1, $tmp2 -Force -ErrorAction SilentlyContinue
try { [Console]::OutputEncoding = $__prevOut } catch { }

# -------------------------------------------------------------------- result
Say "=== Result ==="
git log --oneline -5
$left = @(git status --porcelain)
if ($left.Count -eq 0) { Ok "working tree clean" }
else { Note ("{0} entries still uncommitted:" -f $left.Count); $left | ForEach-Object { Write-Host "    $_" } }

Say "=== Not pushed. Review, then: git push origin main ==="
Dim "to undo both commits but keep the files:  git reset --soft HEAD~3   (or HEAD~2 if commit 3 was skipped)"
