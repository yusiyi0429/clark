# TKOS -- commit this round (A3 pre-research + ontology context + tokenking seed).
#
#   cd <repo>\clark-main
#   powershell -ExecutionPolicy Bypass -File .\scripts\tkos-commit-a3.ps1
#
# One commit on purpose: store.ts was touched by both the A3 work and the seed
# switch, so any split leaves a middle commit that does not compile. See the
# commit body.
#
# ASCII only + CRLF on purpose: Windows PowerShell 5.1 reads .ps1 as the system
# ANSI codepage (GBK on a Chinese Windows) unless there is a UTF-8 BOM, which
# mangles non-ASCII text and can swallow a closing quote. The Chinese commit
# message therefore travels as base64 and is written out as raw UTF-8 bytes.
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

# ------------------------------------------------------------------ 0. lock
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

# ------------------------------------------------------------- 1. change set
Say "=== Change set ==="
$entries = @(git status --porcelain)
if ($entries.Count -eq 0) { Ok "nothing to commit"; exit 0 }
$entries | ForEach-Object { Dim $_ }
Dim ("{0} entries" -f $entries.Count)

# Hard refusals: secrets, build output, runtime snapshot, ontology samples.
# resolve/render-sample.json carry real company operating data.
$danger = $entries | Where-Object {
  $_ -match "\.env\.local|\.env\.docker$|/\.data/|\.tgz|node_modules|\.next/|resolve-sample|render-sample"
}
if ($danger) {
  Bad "refusing -- these must not be committed:"
  $danger | ForEach-Object { Write-Host "    $_" -ForegroundColor Red }
  exit 1
}
Ok "no secrets / build output / runtime snapshot / ontology samples in the set"

# -------------------------------------------------- 2. the set must be complete
# If any of these is missing from the working tree the commit would be broken
# on arrival -- store.ts imports seed-tokenking, signal-view calls the A3 route.
Say "=== Required files present ==="
$need = @(
  "src\lib\agent\a3\prompt.ts",
  "src\lib\agent\a3\run.ts",
  "src\lib\agent\a3\validate.ts",
  "src\lib\agent\tasks.ts",
  "src\lib\ontology\client.ts",
  "src\lib\ontology\compile.ts",
  "src\lib\data\seed-tokenking.ts",
  "scripts\gen-seed-from-ontology.mjs"
)
$absent = 0
foreach ($f in $need) {
  if (Test-Path $f) { Ok $f } else { Bad "$f  MISSING"; $absent++ }
}
if ($absent -gt 0) { Bad "$absent file(s) missing -- do not commit a half set"; exit 1 }

Say "=== Committing in 5s -- Ctrl+C to abort ==="
Start-Sleep -Seconds 5

# UTF-8 commit message, base64 so this file stays pure ASCII.
$MSG_B64 = -join @(
  "QTMg6aKE56CUIEFnZW50ICsg5pys5L2T5LiK5LiL5paH5Y6L57ypICsg56eN5a2Q5o2i5oiQ6K+N5YWD5LqR6ZuGCgrkuIDmrKHm",
  "j5DkuqTvvIzkuI3mmK/kuKTmrKHvvJpzdG9yZS50cyDlkIzml7booqvov5nkuKTku7bkuovmlLnliLDvvIzmi4blvIDkvJrnlZnk",
  "uIvkuIDkuKrnvJbor5HkuI3ov4cK55qE5Lit6Ze05o+Q5Lqk77yI6KaB5LmIIGltcG9ydCDkuIDkuKrov5jkuI3lrZjlnKjnmoQg",
  "c2VlZC10b2tlbmtpbmfvvIzopoHkuYggc2lnbmFsLXZpZXcK6LCD5LiA5Liq6L+Y5LiN5a2Y5Zyo55qEIHN0YXJ0UHJlUmVzZWFy",
  "Y2jvvInjgIIKCiMjIEEzIOmihOeglO+8iHNyYy9saWIvYWdlbnQvYTMv77yJCgpDUTEwMSDCpzA0IOeahOinhOWImeWFiOiQveaI",
  "kCB2YWxpZGF0ZS50cyDnmoTnoa7lrprmgKfmo4Dmn6XvvIzlho3lhpkgcHJvbXB044CC6aG65bqP5piv5Yi75oSP55qE77yaCuWP",
  "r+aVsOeahOS4nOilv++8iOWPpeaVsOOAgUV2aWRlbmNlIOWdl+aVsOOAgea6r+a6kOacieaXoOOAgeWtl+aVsO+8ieS6pOe7meag",
  "oemqjOWZqOaVsOW5tuaJk+Wbnu+8jHByb21wdArph4zor7TkuIDpgY3lj6rkuLrlh4/lsJHph43or5XmrKHmlbDvvIzkuI3mib/m",
  "i4Xkv53or4HjgIIKCi0gdmFsaWRhdGUudHMgIDkg5p2h56Gs6Zeo44CCS2V5IFRha2Vhd2F5IDMtNCDlj6XmmK8qKuS4jeWQq+WP",
  "jemXruautSoq55qEIOKAlOKAlCDlj43pl67mmK/moLzlvI8KICDopoHmsYLkuI3mmK/orrror4Hlj6XvvIznrpfov5vljrvkvJrm",
  "iorlkIjmoLznmoTnqL/lrZDmiZPlm57jgILlj6bmo4AgRXZpZGVuY2UgMi00IOadoeOAgeavj+adoeW4pua6r+a6kOOAgQogIOaX",
  "oCBtYXJrZG93biDorrDlj7fvvIhBZ2VudFRleHQg5oyJ57qv5paH5pys5riy5p+T77yM5YaZICoqIOS8muWOn+agt+aYvuekuuaI",
  "kOaYn+WPt++8ieOAgeaXoOWvueWGsuivjeOAgQogIHNvV2hhdCDokL3lnKjljrvnlZnliKTmlq3kuIrjgIHlhajmlocgPD05MDAg",
  "5a2XCi0gcHJvbXB0LnRzICAgIOi0n+S+i+S8mOWFiOOAgkNRMTAxIMKnMDQg55qE5aSx6LSl5qih5byP5o+P6L+w55qE5q2j5piv",
  "5qih5Z6L55qE6buY6K6k6KGM5Li677yM6K+0CiAg44CM5LiN6KaB5YGa5LuA5LmI44CN5q+U6K+044CM6KaB5YGa5LuA5LmI44CN",
  "566h55So44CC5pyA5YWz6ZSu5LiA5p2h77yadGFrZSDkuI4gc29XaGF0IOS4jeiDveaJk+aetiDigJTigJQKICB0YWtlIOaKiuiu",
  "rumimOeahOetlOahiOivtOatu+S6huOAgXNvV2hhdCDlj4jor7TkuI3lgLzlvpfmt7HnoJTvvIzpgqPmmK/liKTmlq3pg73kuIvl",
  "rozkuobov5jnoJTnqbbku4DkuYgKLSBydW4udHMgICAgICAg6LCD55SoICsg5qCh6aqMICsg6YeN5L+u5pyA5aSaIDIg6L2u44CC",
  "cmVzcG9uc2VfZm9ybWF0PWpzb25fb2JqZWN077ya5qih5Z6LCiAg5ZyoIEpTT04g5a2X56ym5Liy6YeM5YaZ6KO4ICIg5piv57uT",
  "5p6E6Zeu6aKY77yM55So57uT5p6E5omL5q616Kej5Yaz77yM5LiN6Z2gIHByb21wdCDmgbPmsYLjgIIKICBtYXhfdG9rZW5zIDQw",
  "MDAg5bm25qOAIGZpbmlzaF9yZWFzb249bGVuZ3Ro77yb6ZmN57qn57uT5p6c54Wn5qC36JC95bqT77yM5LiN5oqK44CM5rKh5YaZ",
  "5a6M44CNCiAg5Lyq6KOF5oiQ44CM5rKh55Sf5oiQ44CNCi0gdGFza3MudHMgICAgIOi/m+eoi+WGheS7u+WKoeihqOOAguWQjCBr",
  "ZXkg5bey5Zyo6LeR5bCx55u05o6l6L+U5Zue77yM5LiN5o6S6Zif77yb6YeN5ZCv5oqKIHJ1bm5pbmcKICDph43nva7miJAgaWRs",
  "Ze+8jOWQpuWImeS4gOasoeW0qea6g+S8muiuqemCo+S4quiurumimOawuOi/nOaYvuekuuOAjOato+WcqOmihOeglOOAjQoK5a6e",
  "5rWL77yaSVNTLTAwNiDotbDngavlsbHmlrnoiJ8gZGVlcHNlZWstdjQtcHJv77yMNzItODRz77yMMiDova7miJDmlofvvIjnrKzk",
  "uIDova7lm6AgNSDlj6XooqsK5omT5Zue77yJ77yM5YWo6Zeo6YCa6L+H44CC5Lqn5Ye66YeM5pyJ5pys5L2T5LiK5LiL5paH6YeM",
  "5rKh5pyJ55qE57u85ZCIIOKAlOKAlCDkuKTmnaHnur/nmoQgRFJJIOaYr+WQjOS4gOS4quS6uu+8jArkurrlipvlhbHkuqvjgILm",
  "i78gMTEg5Liq5Lq66YCg5Y+N5L6L5Zue5b2SIDExLzExIOWRveS4re+8jOmhuuaJi+WcqOaJi+WGmeeahOenjeWtkOaWh+ahiOmH",
  "jOafpeWHuiA0IOWkhArnnJ/lrp7nvLrpmbfjgIIKCiMjIOacrOS9k+aOpeWFpe+8iHNyYy9saWIvb250b2xvZ3kv77yJCgotIGNs",
  "aWVudC50cyAgIOiwgyAvdjEvY29udGV4dC1wYWNrczpyZW5kZXIg56Gu5a6a5oCn5qih5byP44CC5aSx6LSl5LiA5b6L6L+U5Zue",
  "CiAge29rOmZhbHNlLCByZWFzb259IOiAjOS4jeaKmyDigJTigJQg5pys5L2T5LiN5Zyo77yM5LiA5Y+35L2N54Wn5qC36KaB6IO9",
  "5a+56K+dCi0gY29tcGlsZS50cyAg56Gu5a6a5oCn5Y6L57yp5Zmo44CCcmVuZGVyZWQuY29udGVudCDnm7TmjqXlloLmqKHlnovm",
  "mK/mtarotLnvvJo0NSUg5piv6ZSa54K55byA6ZSA77yMCiAgNjUg5p2h5YWz57O76YeMIDE5IOadoeiHquaMh++8iOOAjOW3suef",
  "pee8uuWPo+OAjeOAjOadpea6kOOAjei/meexu+aMh+WbnuiHquW3seeahOi+ue+8ie+8jG91dGNvbWVzIOWOu+mHjQogIOWQjiAy",
  "MCDlj5ggMTLjgILmjIkgbWVtYmVyX2lkIOWOu+mHjeOAgeWJpeiHquaMh+S4juWuoeiuoeWFs+ezu+OAgeaIkOWRmCBpZCDmmKDl",
  "sITmiJDnn63noIHjgIHkv53nlZkKICDorqTnn6XnirbmgIHmoIfnrb7jgIIxNjU0MSAtPiAxMDAyMSDlrZfnrKYKCuS4jeWOi+e8",
  "qeeahOS7o+S7t+S4jeaYr+WkmuiKsemCo+eCuemSse+8jOaYr+aooeWei+iiq+WZqumfs+W4puWBj+S5i+WQjuWcqOivhOa1i+mH",
  "jOihqOeOsOS4uuOAjOaooeWei+S4jeihjOOAje+8jArogIzov5nkuKrlvZLlm6Dlh6DkuY7kuI3lj6/og73lgZrlr7njgIIKCiMj",
  "IOenjeWtkOaNouaIkOivjeWFg+S6kembhu+8iHNjcmlwdHMvZ2VuLXNlZWQtZnJvbS1vbnRvbG9neS5tanPvvIkKCuS9k+mqjOWv",
  "ueixoeS7juaIv+aHguaHguaUueaIkOivjeWFg+S6kembhuiHquW3seeahOS4gOWPt+S9je+8jOWJjeerr+enjeWtkOWwseW/hemh",
  "u+aYr+ivjeWFg+S6kembhueahOecn+aVsOaNruOAggoK55Sf5oiQ5Zmo5LuO5pys5L2TIFRyaUcg55u05o6l5LqnIHNlZWQtdG9r",
  "ZW5raW5nLnRz77yaOCDkuKrln5/jgIExMCDkuKrkurrvvIh2aWV3ZXI95YiY5piO5Y2O77yJ44CBCjM1IOadoeWIpOaWreOAgTkg",
  "5Liq6K6u6aKYICsgOSDlvKDljaHjgIEyMiDku73mlofmoaPjgIEzIOW8oCBNaXNzaW9uIENhcmTvvIzlpJbliqAgODEg5p2h55+t",
  "56CB5YiwCm1lbWJlciBpZCDnmoTmmKDlsITvvIhvbnRvbG9neVJlZnPvvInigJTigJQgQTMg55qE5rqv5rqQ5Y+q6K645YaZ55+t",
  "56CB77yMbWVtYmVyOiDlvIDlpLTnmoTmnKzkvZPlhoXpg6gK57yW5Y+35bGP5bmV6K6k5LiN5Ye644CB54K55LiN5byA44CC6YeN",
  "6LeR5a2X6IqC5LiA6Ie044CCCgrouKnliLDkuKTlpITvvJoKLSDmj5Dor7flj7AgMCDlvKDljaHvvJpsaXN0UGVuZGluZyDmjIkg",
  "VE9EQVkg6L+H5rukIGRpZ2VzdHPvvIznlJ/miJDlmajoh6rlt7Hlhpnmrbvkuobml6XmnJ/jgIIKICDmlLnmiJDku44gc2hhcmVk",
  "LnRzIOWvvOWFpeWQjOS4gOS4qiBUT0RBWQotIC9zaWduYWxzL1tpZF0g5omT5LiN5byA77yaOSDkuKrorq7popjmsqHmnInlr7nl",
  "upTnmoTljaHjgILooaXnlJ/miJAgQ2FyZHMgKyBkaWdlc3RzCgrmoLjlv4Ppl63njq/lnKjnnJ/mlbDmja7kuIrot5HpgJrvvJow",
  "MS1KOOOAjOaUtuWFpee7k+aehOS4iemYtuautei/geenu+OAjXN0YW5kaW5nIOWPmOaIkCBzaGFraW5n77yMCuiiqyBJU1MtMDA2",
  "IOWKqOaRh+OAggoKIyMg546v5aKD5Y+Y6YePCgpUS09TX09OVE9MT0dZX0NPTlRFWFQg6buY6K6k5LuOIDAg5pS55oiQIDEg4oCU",
  "4oCUIOW9k+WIneWFs+aOieaYr+WboOS4uuacrOS9k+aVsOaNruaYr+ivjeWFg+S6kembhuOAgQrliY3nq6/np43lrZDmmK/miL/m",
  "h4Lmh4LvvIzmiZPlvIDlv4XnhLYgbm9fbWF0Y2jjgILnjrDlnKjkuKTovrnlkIzmupDvvIzpgqPkuKrnkIbnlLHmsqHkuobjgIIK",
  "LmVudi5leGFtcGxlIOihpeS4iiA1IOS4quatpOWJjeWPquWGmeWcqCAuZW52LmRvY2tlci5leGFtcGxlIOmHjOeahOW8gOWFs++8",
  "m+eUqCBwbnBtIGRldgrnmoTkurrku6XliY3moLnmnKznnIvkuI3liLDlroPku6zlrZjlnKjjgIIKCiMjIOi/mOayoemqjOivgeea",
  "hAoKVEtPU19PTlRPTE9HWV9DT05URVhUPTEg6L+Z5p2h6Lev5b6E5rKh5Zyo55yf5a6e572R57uc5LiL6LeR6L+HIOKAlOKAlCDm",
  "spnnrrHliLDkuI3kuoYKMTE1LjE5MC4yMTMuNDQ6ODAwMOOAguesrOS4gOasoeW4puacrOS9k+S4iuS4i+aWh+eahOmihOeglOim",
  "geWcqOacrOacuuehruiupOS4gOmBjeOAggoKQ28tQXV0aG9yZWQtQnk6IENsYXVkZSBPcHVzIDUgPG5vcmVwbHlAYW50aHJvcGlj",
  "LmNvbT4KQ2xhdWRlLVNlc3Npb246IGh0dHBzOi8vY2xhdWRlLmFpL2NvZGUvc2Vzc2lvbl8wMVFYN1pEemNDbTU3WXZ4Q2Y5NVZK",
  "RHkK"
)

$tmp = Join-Path $env:TEMP "tkos-a3-msg.txt"
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
