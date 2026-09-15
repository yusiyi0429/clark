# TKOS -- commit this round (data layer + model slots).
#
#   cd <repo>\clark-main
#   powershell -ExecutionPolicy Bypass -File .\scripts\tkos-commit-a1.ps1
#
# Commits EVERYTHING currently uncommitted as one logical change. It prints the
# file list first -- if something unexpected is in there, Ctrl+C before the
# 5 second pause ends.
#
# Not "Stop": PowerShell turns native-command stderr into a terminating error
# under Stop, and git writes its LF/CRLF notes to stderr.
$ErrorActionPreference = "Continue"
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

$__prevOut = [Console]::OutputEncoding
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

if (-not (Test-Path ".git")) { Bad "not a git repo"; exit 1 }

Say "=== Stale lock ==="
if (Test-Path ".git\index.lock") {
  $live = @(Get-Process git -ErrorAction SilentlyContinue)
  if ($live.Count -eq 0) { Remove-Item ".git\index.lock" -Force; Ok "removed -- no git process held it" }
  else { Bad "a git process is running -- close VS Code's git panel, then rerun"; exit 1 }
} else { Ok "no lock" }

$n = (git config user.name) 2>$null
if (-not $n) {
  git config --local user.name  "Sean Sun"
  git config --local user.email "wezvwolf@gmail.com"
  Note "identity was unset -- set repo-local"
}
Ok ("{0} <{1}>" -f (git config user.name), (git config user.email))

Say "=== Change set ==="
$entries = @(git status --porcelain)
if ($entries.Count -eq 0) { Ok "nothing to commit"; exit 0 }
$entries | ForEach-Object { Dim $_ }
Dim ("{0} entries" -f $entries.Count)

# Hard refusals: secrets, build output, the runtime snapshot
$danger = $entries | Where-Object { $_ -match "\.env\.local|\.env\.docker$|/\.data/|\.tgz|node_modules|\.next/" }
if ($danger) {
  Bad "refusing -- these must not be committed:"
  $danger | ForEach-Object { Write-Host "    $_" -ForegroundColor Red }
  exit 1
}
Ok "no secrets / build output / runtime snapshot in the set"

Say "=== Committing in 5s -- Ctrl+C to abort ==="
Start-Sleep -Seconds 5

$MSG_B64 = -join @(
  "5pWw5o2u5bGC5pCs5Yiw5pyN5Yqh56uvICsg5qih5Z6L5qe95L2NCgrlr7nosaHlupPljp/mnaXmlbTkuKrmtLvlnKjmtY/op4jl",
  "majlhoXlrZjph4zvvIzliLfmlrDljbPmuIXpm7bjgILnjrDlnKjlrp7njrDmkKzliLAgc3RvcmUudHPvvIhzZXJ2ZXItb25see+8",
  "ie+8jArliY3nq68gY2xpZW50LnRzIOWPmOaIkCA1NCDkuKrovazlj5Hlo7PvvIzlhajpg6jmiZMgUE9TVCAvYXBpL2RhdGHjgIIK",
  "Ci0gc3RvcmUudHPvvIgyNzExIOihjO+8iT0g5Y6fIGNsaWVudC50cyDlhajmlofvvIzpgLvovpHkuIDooYzmsqHliqjvvIzlj6rl",
  "iqAgc2VydmVyLW9ubHkg5a6I5Y2r5LiO6JC955uY6ZKp5a2QCi0gY2xpZW50LnRz77yIMTMxIOihjO+8ieWjsOaYjuS4uiBgY29u",
  "c3QgYXBpOiBBcGlg77yIQXBpID0gdHlwZW9mIHN0b3JlLmFwae+8ieKAlOKAlAogIOWwkeS4gOS4quaWueazleOAgeWkmuS4gOS4",
  "quaWueazleOAgeS7u+S9leetvuWQjeWvueS4jeS4iu+8jHRzYyDnm7TmjqXmiqXplJnjgILmiYDku6UgNzAg5aSEIGFwaS4qIOiw",
  "g+eUqOeCuQogIOWSjCB+NDAg5aSEIHVzZVJlc291cmNlIOS4gOS4quWtl+mDveayoeaUuQotIHNoYXJlZC50cyDmlLbkuKTovrnl",
  "hbHnlKjnmoTluLjph4/kuI7nuq/lh73mlbDvvIhST1VURV9MQUJFTCAvIGNhcmRTb3VyY2VMYWJlbCDnrYnvvInjgIIKICBUT0RB",
  "WSDkuI7kuKTkuKrlhpnlm57luLjph4/mlLbmlZvliLDov5nph4zvvIxzZWVkLnRzIOaUueS4uiByZS1leHBvcnTvvIzpgb/lhY3k",
  "uKTlpITlrprkuYnmvILnp7sKLSBhcGkvZGF0YS9yb3V0ZS50cyDljZUgUlBDIOerr+eCue+8jOeZveWQjeWNleWwseaYryBhcGkg",
  "6Ieq5bex55qE6ZSu44CC5a6D5LiN5piv5YWs5byAIEFQSe+8jAogIDE6MSDmmKDlsITmiY3og73orqnosIPnlKjngrnpm7bmlLnl",
  "iqjvvJvpk7ogNTQg5p2hIFJFU1Qg6Lev55Sx5Y+q5piv5oqK5ZCM5LiA5Lu25LqL5YaZIDU0IOmBjQotIHBlcnNpc3QudHMgSlNP",
  "TiDlv6vnhacgKyDljp/lrZDlhpnvvIjlhYjlhpkgdG1wIOWGjSByZW5hbWXvvInjgILlv6vnhafph4zlrZjnp43lrZDmjIfnurnv",
  "vIznp43lrZDkuIDmlLkKICDlsLHoh6rliqjkvZzlup/ph43lu7og4oCU4oCUIOWQpuWImeaUueS6huenjeWtkOWNtOeci+S4jeWI",
  "sOWPmOWMlu+8jOS8muaOkuafpeW+iOS5hQotIHNsZWVwKDIwMCw2MDApIOS7juavj+S4quaWueazleeahOWbuuWumuWKqOS9nOaU",
  "ueaIkCBUS09TX0ZBS0VfTEFURU5DWSDlvIDlhbPjgILmkKzliLDmnI3liqHnq6/lkI4KICDnnJ/lrp4gSFRUUCDoh6rluKblvoDo",
  "v5TvvIzlho3lj6DkuIDlsYLlgYflu7bov5/mmK/lnKjmtarotLnnnJ/lrp7ml7bpl7QKLSByZXNldFRvU2VlZCgpIOa8lOekuuWJ",
  "jeS4gOmUruWbnuWIsOenjeWtkOaAge+8jOS4jeeUqOmHjeWQr+i/m+eoiwoK6aG65bim55qE5pS255uK77ya56eN5a2Q5pWw5o2u",
  "5LiN5YaN6L+b5a6i5oi356uvIGJ1bmRsZe+8jOaehOW7uuS6p+eJqemHjOWuouaIt+erryBjaHVuayDmkJzkuI3liLDjgIzmiL/m",
  "h4Lmh4LjgI3jgIIK5Lul5YmN5rWP6KeI5Zmo6KaB5LiL6L296YKjIDE0MEtC44CCCgrmqKHlnovmp73kvY3vvIhsaWIvYWdlbnQv",
  "bW9kZWxzLnRz77yJ77yaCgotIOaMieinkuiJsumFjeS4jeaMieWOguWVhumFjSDigJTigJQgUFJPIOS4u+WvueivneS4jumrmOi0",
  "qOmHj+eUn+aIkCAvIEZMQVNIIOmrmOmikei9u+S7u+WKoSAvIEFMVCDkuqTlj4nmoKHpqowKLSAvYXBpL2NoYXQg5LuO5YaZ5q27",
  "55qEIGRlZXBzZWVrLXY0LWZsYXNoIOaUuei1sCBQUk8g5qe95L2N77ya5a6D6KaB57uZ5Ye65Y+v6K+B5Lyq55qE5Yik5pat77yM",
  "CiAg5piv6LSo6YeP5pWP5oSf6ICM6Z2e6YCf5bqm5pWP5oSf55qE5Lu75YqhCi0g5pys54mI5LiN5o6l5aKD5aSW5qih5Z6L44CC",
  "QUxUIOW/hemhu+WSjCBQUk8g5LiN5ZCM5a625pePIOKAlOKAlCDkuqTlj4kganVkZ2Ug55qE55CG55Sx5LiN5piv44CM55So5LiN",
  "5ZCM5Y6C5ZWG44CN77yMCiAg5piv6Ieq5bex5Yik6Ieq5bex5Lya56iz5a6a6YCa6L+H6Ieq5bex55qE5aSx6LSl5qih5byP77yM",
  "6ICM6YCa6L+H546H5Y+N6ICM5pu05aW955yL44CC5ZCM5a625peP5oiW57y6IEFMVCDml7YKICDlkK/liqjml6Xlv5flkYrorabv",
  "vIzlj6rlkYrorabkuI3pmLvmlq0KLSDngavlsbHmlrnoiJ/mnKzouqvmmK/lpJrmqKHlnovnvZHlhbPvvIzkuqTlj4nmoKHpqozk",
  "uI3pnIDopoHlh7rlooPjgILlsIbmnaXmjaLlm54gQmVkcm9jayDmlLnnjq/looPlj5jph4/ljbPlj68KCkRvY2tlcmZpbGUg5Yqg",
  "IC9hcHAvLmRhdGEg5Y2377yMLmdpdGlnbm9yZSDlv73nlaUgLy5kYXRhL+OAggoK6aqM6K+B77yadHNjIOmbtumUmeivr+OAgWVz",
  "bGludCDlubLlh4DjgIFwbnBtIGJ1aWxkIOmAmui/h+OAgnN0YW5kYWxvbmUg54us56uL6L+Q6KGM5LiL55SoIENocm9taXVtCui3",
  "keS6hiA3IOS4qumhtemdouWKoOS4gOasoeWGmeaTjeS9nO+8jFJQQyDlhaggMjAw44CB5o6n5Yi25Y+wIDAg6ZSZ6K+v77yb54q2",
  "5oCB5rS76L+H6YeN5ZCv44CB5oyH57q55a+55LiN5LiK5pe2CuWbnuiQveenjeWtkOOAgeW7tui/n+W8gOWFs+eUn+aViO+8iDAu",
  "MDE2cyDihpIgMC4yNHPvvInjgIIKCkNvLUF1dGhvcmVkLUJ5OiBDbGF1ZGUgT3B1cyA1IDxub3JlcGx5QGFudGhyb3BpYy5jb20+",
  "CkNsYXVkZS1TZXNzaW9uOiBodHRwczovL2NsYXVkZS5haS9jb2RlL3Nlc3Npb25fMDFRWDdaRHpjQ201N1l2eENmOTVWSkR5Cg=="
)


$tmp = Join-Path $env:TEMP "tkos-a1-msg.txt"
[System.IO.File]::WriteAllBytes($tmp, [Convert]::FromBase64String($MSG_B64))

git add -A
if ($LASTEXITCODE -ne 0) { Bad "git add failed"; exit 1 }
git commit -q -F $tmp
if ($LASTEXITCODE -ne 0) { Bad "commit failed -- changes still staged, nothing lost"; exit 1 }
Remove-Item $tmp -Force -ErrorAction SilentlyContinue
Ok ("committed: " + (git log -1 --format='%h %s'))

Say "=== Result ==="
git log --oneline -4
git show --stat --format="" HEAD | Select-Object -Last 40
$left = @(git status --porcelain)
if ($left.Count -eq 0) { Ok "working tree clean" } else { $left | ForEach-Object { Dim $_ } }

try { [Console]::OutputEncoding = $__prevOut } catch { }
Say "=== Not pushed. When ready:  git push origin main ==="
Dim "undo but keep files:  git reset --soft HEAD~1"
