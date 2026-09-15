# TKOS -- commit this round (A4 deep research, A2 framing, A10 write-back, A6 observer).
#
#   cd C:\Users\10021\Desktop\clark\clark-main
#   powershell -ExecutionPolicy Bypass -File .\scripts\tkos-commit-a4.ps1
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

# Hard refusals: secrets, build output, runtime snapshot, ontology samples,
# and the transfer tarballs that land in the repo root.
$danger = $entries | Where-Object {
  $_ -match "\.env\.local|\.env\.docker$|/\.data/|\.tgz|node_modules|\.next/|resolve-sample|render-sample|_to_delete"
}
if ($danger) {
  Bad "refusing -- these must not be committed:"
  $danger | ForEach-Object { Write-Host "    $_" -ForegroundColor Red }
  Dim "if a .tgz or _to_delete/ shows up here, .gitignore did not take -- check it before forcing"
  exit 1
}
Ok "no secrets / build output / runtime snapshot / transfer tarballs in the set"

# The four new agents plus the two shared modules. A half set does not compile:
# store.ts imports all four runners.
Say "=== Required files present ==="
$need = @(
  "src\lib\agent\json.ts",
  "src\lib\agent\rules.ts",
  "src\lib\agent\a2\run.ts",
  "src\lib\agent\a4\prompt.ts",
  "src\lib\agent\a4\validate.ts",
  "src\lib\agent\a4\run.ts",
  "src\lib\agent\a10\run.ts",
  "src\lib\agent\a6\observe.ts"
)
$absent = 0
foreach ($f in $need) {
  if (Test-Path $f) { Ok $f } else { Bad "$f  MISSING"; $absent++ }
}
if ($absent -gt 0) { Bad "$absent file(s) missing -- do not commit a half set"; exit 1 }

# Cheap correctness gate before the commit. tsc is what caught the four missing
# client.ts forwards -- `const api: Api` makes a forgotten method a type error.
Say "=== Typecheck + lint ==="
if (Get-Command pnpm -ErrorAction SilentlyContinue) {
  npx tsc --noEmit -p tsconfig.json
  if ($LASTEXITCODE -ne 0) { Bad "tsc failed -- fix before committing"; exit 1 }
  Ok "tsc clean"
  npx eslint src --max-warnings=0
  if ($LASTEXITCODE -ne 0) { Bad "eslint failed"; exit 1 }
  Ok "eslint clean"
} else {
  Note "pnpm not on PATH -- skipped typecheck"
}

Say "=== Committing in 5s -- Ctrl+C to abort ==="
Start-Sleep -Seconds 5

$MSG_B64 = -join @(
  "QTQg5rex56CUIC8gQTIg5a6a6aKYIC8gQTEwIOWGmeWbniAvIEE2IOingua1i++8muS4u+mTvui3r+WcqOecn+aVsOaNruS4iui3",
  "kemAmgoK5YWr5LiqIGFnZW50IOmHjOWJqeS4i+eahOWbm+S4quOAguWKoOS4iuS4iuS4gOi9rueahCBBM++8jOS7juOAjOa9nOWc",
  "qOiurumimOOAjeWIsOOAjOWGmeWbnuacrOS9k+OAjQrov5nmnaHpk77njrDlnKjlhajnqIvmmK/nnJ/mqKHlnovvvIzmsqHmnInk",
  "uIDmrrXov5jlnKjmlL7pooTnva7mlofmoYjjgIIKCuWunua1i++8iOeBq+WxseaWueiInyBkZWVwc2Vlay12NC1wcm8tMjYwNDI1",
  "77yMSVNTLTAwNiDmlLblhaXnu5PmnoTkuInpmLbmrrXov4Hnp7vvvInvvJoKCiAgQTMg6aKE56CUICAgIDM5cyAgIDEg6L2uICAg",
  "6LSo6YeP6Zeo5YWo6L+HCiAgQTQg5rex56CUICAgIDYwcyAgIDEg6L2uICAgMyDliKTmlq0gLyA1IEV2aWRlbmNlIC8gMiDlj43o",
  "r4EgLyA0IOS4jeehruWumuaApyAvIDE2NDgg5a2XCiAgQTIg5a6a6aKYICAgIDE3cyAgIDEg6L2uICAg44CM5Zyo5ou/5YiwIERP",
  "Qy0wOC8wOS8xMCDmraPmloflkozkuqflk4EgMS4wIOWIneatpeiQpeaUtuaVsOaNruS5i+WJje+8jAogICAgICAgICAgICAgICAg",
  "ICAgICAgICAgIOaYr+WQpuaaguWBnOWFs+S6juaUtuWFpee7k+aehOi/geenu+iKguWlj+eahOato+W8j+WGs+etlu+8n+OAjQog",
  "IEExMCDlhpnlm54gICA0MnMgICAxIOi9riAgIOS4g+imgee0oOm9kOWFqO+8jDAxLUo4IOe7meWHuuS6huWPr+WGmei/m+acrOS9",
  "k+eahOaWsOmZiOi/sOWFqOaWhwogIEE2IOWvueiwiCAgICDmtYHlvI8gICAgICAgIOaIkeivtOOAjFRva2VuIOaUtuWFpeW6lOiv",
  "peeOsOWcqOWwseWOi+e7memUgOWUruiAg+aguOOAje+8jOWug+ayoemhuuedgOivtO+8jAogICAgICAgICAgICAgICAgICAgICAg",
  "ICAgIOeUqOS4pOS4quaWh+aho+eJiOacrOWPt++8iHYwLjIgLyB2MS4w77yJ5oqK44CM6L+Y5YGc5Zyo5qaC5b+15bGC44CN5pGG",
  "5LqG5Ye65p2lCgrnoa7orqTlhpnlm57lkI4gUmUtb3BlbiBUcmlnZ2VyIOecn+eahOaMguWbnuS6huW+heWumuS6i+mhueeahOeb",
  "kea1i+mdtueCue+8jOmdtueCueaWh+ahiOaYryBBMTAg5YaZ55qECumCo+S4gOWPpeOAjOWmguaenOW3suiOt+WPliBET0MtMDgv",
  "MDkvMTAg5YWo5paH77yM5LiU4oCm5pyJ6LaF6L+HIDMg5a6255qE5aSN6LSt5oSP5ZCR4oCm5YiZ6YeN5byA44CN4oCU4oCUCumX",
  "reeOr+WcqOecn+aVsOaNruS4iuWQiOS4iuS6huOAggoKIyMgQTQg5rex56CU77yIc3JjL2xpYi9hZ2VudC9hNC/vvIkKCuS6p+WH",
  "uiBSZXNlYXJjaERvYyDlm5voioIgKyDkuIDooYzlu7rorq7liIbmtYHjgILlroPlkozlj4LogIPku7bvvIhGaXJld29ya3MgLyBN",
  "b25pY2Eg6YKj57G7CuS4gOS4h+S4ieWNg+Wtl+eahOWOn+Wni+eglOeptuaKpeWRiu+8ieS4jeaYr+S4gOS4quS4nOilv++8mumC",
  "o+S7veeahOivu+iAheaYr+imgeWQg+mAj+i/meS4qumimOeahOS6uu+8jArov5nlm5voioLmmK/lj4LosIvor7vlrozkuYvlkI7k",
  "uqTnu5nkuIDlj7fkvY3nmoTlj5boiI3nu5PmnpzjgILkuKLmjonnmoTmmK/og4zmma/lkozov4fnqIvvvIwK55WZ5LiL55qE5piv",
  "6IO95pS55Y+Y5Yaz5a6a55qE6YOo5YiG44CCTTEtQSDlj43lr7nplb/miqXlkYrnmoTnkIbnlLHkuI3mmK/plb/kuobnnIvkuI3l",
  "rozvvIwK5piv6ZW/5oql5ZGK5YWB6K645L2c6ICF5LiN5YGa5Y+W6IiNIOKAlOKAlCDogIzlj5boiI3mgbDmgbDmmK/lj4LosIvl",
  "lK/kuIDkuI3lj6/mm7/ku6PnmoTlt6XkvZzjgIIKCuS7juWPguiAg+S7tue7p+aJv+S6huS4ieagt++8muS4gOWPpeivneWIpOaW",
  "reWFiOihjOS4lOeUqOOAjOS4jeaYryBYIOiAjOaYryBZ44CN6KGo5oCB77yI5Y+q6K+044CM5pivIFnjgI0K55qE5Y+l5a2Q5rKh",
  "5rOV6KKr5Y+N6amz77yM5Lmf5bCx5rKh5rOV6KKr56Gu6K6k77yJ44CB5q+P5p2h5Yik5pat6JC95Yiw44CM5a+55oiR5Lus5oSP",
  "5ZGz552A5LuA5LmI44CN44CBCumjjumZqeS4juWPjeWFseivhuWNleeLrOaIkOiKguiAjOS4jeaYr+ihpeS4geOAggoKMTMg5p2h",
  "56Gu5a6a5oCn6Zeo44CC5LiJ5p2h5YC85b6X5Y2V6K+077yaCgotIEE0LTAzIOWPjeivgembtuadoSA9IHAw44CC6Zu25p2h5Zyo",
  "5pWw5o2u5LiK55yL6LW35p2l5b6I5bmy5YeA77yM5a6e6ZmF5piv6L+Z5Lu956CU56m25pyA5Y2x6Zmp55qECiAg54q25oCBIOKA",
  "lOKAlCDkuIDlj7fkvY3kvJrku6XkuLrlroPlt7Lnu4/ooqvljovlipvmtYvor5Xov4fkuoYKLSBBNC0wNyDlj43or4Hlv4Xpobvl",
  "hpnmuIXjgIzmiJDnq4vliLDku4DkuYjnqIvluqblsLHotrPku6Xmjqjnv7vlk6rkuIDmnaHliKTmlq3jgI3jgILlhpnkuI3lh7ro",
  "v5nlj6XnmoQKICDmmK/mhJ/mg7PvvIzkuI3mmK/lj43or4EKLSBBNC0xMyDlj43or4HkuI3og73mmK/nuq/lgYforr7mg4Xmma/j",
  "gILnrKzkuIDmrKHlrp7ot5HlsLHmkp7kuIrkuobvvJrmqKHlnovlhpnkuobjgIzoi6XluILlnLrnjq/looMKICDlh7rnjrDnqoHl",
  "j5jigKbliJnotrPku6Xmjqjnv7vnrKwgMSDmnaHjgI3vvIzor63ms5XkuIrmu6HotrMgQTQtMDfvvIzkvYblroPmmK/nvJblh7rm",
  "naXnmoTmg4Xmma/kuI3mmK8KICDlt7Lnn6Xkuovlrp7jgILliKTmja7mmK/jgIzku6Xoi6Uv5aaC5p6c5byA5aS0IOS4lCDllK/k",
  "uIDmuq/mupDmmK/oh6rlt7HnmoTmjqjmlq3jgI3jgILliqDkuIrov5nmnaHkuYvlkI4KICDph43ot5HvvIzkuKTmnaHlj43or4Hp",
  "g73mjaLmiJDkuobmnInmlofmoaPkvp3mja7nmoQKCiMjIyDni6znq4vnrKzkuozmupDlj6rlgZrlj43or4HvvIzkuI3ph43lhpnk",
  "uIDku73miqXlkYoKCuOAjOWQjOaXtueUn+aIkOS4pOS7veeLrOeri+e7k+aenOOAjeeahOS7t+WAvOS4jeWcqOS6juacieS4pOS7",
  "veWPr+eciyDigJTigJQg5Lik5Lu96K+76LW35p2l5beu5LiN5aSa55qE5oql5ZGKCuWPquS8muiuqeS4gOWPt+S9jeivu+S4pOmB",
  "jeOAguS7t+WAvOWcqOWIhuatp++8muS4pOS4quS4jeWQjOWutuaXj+eahOaooeWei+mDveaOqOS4jee/u+eahOWIpOaWre+8jOav",
  "lOS4gOS4qgrmqKHlnovoh6rlt7Hor7TjgIzmiJHlvojnoa7lrprjgI3noazlvpflpJrjgILmiYDku6UgQUxUIOeahOS6p+eJqeeb",
  "tOaOpei/myBjb3VudGVyc++8jOW4pgrjgIzni6znq4vnrKzkuozmupAgwrcgPG1vZGVsPuOAjeeahOa6r+a6kOagh+iusOOAggoK",
  "QUxUIOeOsOWcqOayoemFje+8jOi/meS4gOatpei3s+i/h+W5tuWcqOaXpeW/l+mHjOivtOa4healmumZjee6p+S6hiDigJTigJQg",
  "5LiN6Z2Z6buY77yM5Zug5Li65Y+N6K+B5p2h5pWwCuWPmOWwkeeci+i1t+adpeWDj+OAjOi/measoeayoeS7gOS5iOmjjumZqeOA",
  "jeOAggoKIyMgQTIg5a6a6aKY77yIc3JjL2xpYi9hZ2VudC9hMi9ydW4udHPvvIkKCuWug+aYr+eLrOeriyBhZ2VudCDogIzkuI3m",
  "mK/mt7HnoJTnmoTkuIDkuKrlrZfmrrXvvIzlm6DkuLrlpLHotKXmqKHlvI/lrozlhajkuI3lkIzvvJrmt7HnoJTlhpnlnY/kuobm",
  "mK8K44CM6K+05b6X5LiN5YeG44CN77yM5a6a6aKY5YaZ5Z2P5LqG5piv5oqK56CU56m26Zeu6aKY5Lyq6KOF5oiQ5Yaz562W6Zeu",
  "6aKY77yM6ICM6L+Z5Zyo5bGP5bmV5LiK55yL5LiN5Ye65p2l44CCCuOAjOaIkeS7rOivpeWmguS9leaPkOWNh+e7ree6pueOh++8",
  "n+OAjeivu+i1t+adpemdnuW4uOWDj+S4gOWPpeato+e7j+eahOmimO+8jOS9huWug+etlOS4jeWHuuadpe+8jArkuIDlj7fkvY3m",
  "i7/nnYDlroPlvIDlrozkvJrov5jmmK/ljp/lnLDjgIIKCkEyLTAzIOWwseaYr+i/meadoemXqO+8muS7peOAjOWmguS9lS/mgI7m",
  "oLcv5Li65LuA5LmI44CN5byA5aS044CB5oiW6JC95Zyo44CM546w54q2L+i2i+WKvy/lvbHlk43jgI3kuIrnmoQK5LiA5b6L5omT",
  "5Zue44CC5qOA6aqM5qCH5YeG5YaZ6L+bIHByb21wdO+8mui/meWPpeivneeahOetlOahiOW/hemhu+aYr+S4gOS4quWKqOS9nOaI",
  "luS4gOS4quWPluiIje+8jArkuI3mmK/kuIDmrrXliIbmnpDjgILmib/mjqXkurrlj6rog73ku47lkI3ljZXph4zmjJHvvIjnvJbl",
  "h7rmnaXnmoTkurrlkI3kvJrorqnkuqTmjqXljIXlj5HkuI3lh7rljrvvvInvvIwK6ZmQ5pe25LiN6K645YaZ44CM5bC95b+r44CN",
  "44CCCgrlkIzmraXnrYnmqKHlnovvvIzkuI3lgZrlkI7lj7Dku7vliqHvvJrlrprpopjmmK/ku5bmjInkuIvljrvnmoTkuIDkuKrm",
  "jInpkq7vvIzmjInkuIvljrvlsLHlnKjnrYnkuIDlj6Xor53jgIIK5Y2B5Yeg56eS5Y+v5Lul6L2s5ZyI77yM5YGa5oiQ6L2u6K+i",
  "5Y+N6ICM5pu05oWi77yM6L+Y5Lya5Ye6546w44CM5a6a5a6M5LqG5L2G5bGP5bmV5rKh5pu05paw44CN55qE5Lit6Ze05oCB44CC",
  "CgojIyBBMTAg5YaZ5Zue5o+Q5qGI77yIc3JjL2xpYi9hZ2VudC9hMTAvcnVuLnRz77yJCgrkuIPopoHntKAgKyDliKTmlq3nv7vn",
  "iYjjgILkuZ3mnaHpl6jph4zmnIDph43opoHnmoTkuInmnaHvvJoKCi0gQTEwLTAyIOOAjOaOkumZpOOAjeS4jeiDveaYr+OAjOaX",
  "oOOAjeOAguS7u+S9leWGs+WumumDveaOkumZpOS6huWIq+eahOS4nOilv++8jOWGmeS4jeWHuuadpeivtOaYjui/mOayoQogIOWB",
  "muWPluiIje+8m+ayoeacieWug++8jOWNiuW5tOWQjuOAjOaIkeS7rOW9k+WIneiAg+iZkei/h+OAjeawuOi/nOaXoOazleivgeS8",
  "qgotIEExMC0wNiDph43lvIDmnaHku7blv4XpobvmjILlvpfliLDpnbbngrnkuIrjgILjgIzlpoLmnpzmg4XlhrXmnInlj5jjgI3k",
  "uI3lj6rmmK/lhpnlvpflt64g4oCU4oCUCiAg56Gu6K6k5LmL5ZCO6L+Z5Y+l6K+d5Lya6KKr55yf55qE5oyC5oiQ55uR5rWL6Z22",
  "54K577yM5oyC5LiN5LiK5Y67562J5LqO6K6p44CM5Lya6Ieq5Yqo6YeN5byA44CN5Y+Y5oiQ5YGH6K+dCi0gQTEwLTA3IOS4jeiu",
  "uOeUqOWujOaIkOaXtuOAguaooeWei+eahOm7mOiupOivreawlOaYr+OAjOaIkeS7rOW3sue7j+WGs+WumuOAje+8jOiAjOi/meS7",
  "veS4nOilv+i/mOayoeiiqwogIOaMieS4i+ehruiupOOAgueUqOWujOaIkOaXtuWGmeS4gOS7tuayoeWPkeeUn+eahOS6i++8jOaY",
  "r+i/meWdl+Wxj+W5leS4iuacgOi0teeahOS/oeS7u+mUmeivrwoKIyMgQTYg5a+56LCI77yIaW5zdHJ1Y3Rpb25zLnRzICsgYTYv",
  "b2JzZXJ2ZS50c++8iQoK5rKh5pyJ6YeN5YaZIHByb21wdCDigJTigJQg5a6D5pys5p2l5bCx5Z+65pys5a+56b2QIHJ1YnJpY++8",
  "jOmHjeWGmeaYr+e6ryBjaHVybuOAguihpeS6huWbm+aute+8mgrmjpLniYjvvIjkuK3oi7HmlofnqbrmoLzjgIHjgIzjgI3lvJXl",
  "j7fvvInjgIHnu5PorrrlvLrluqbljLnphY3kvp3mja7jgIHmnKzkvZPkuIrkuIvmlofmmK/lgJnpgInkuI3mmK/lt7Lnoa7orqTj",
  "gIEKbWVtYmVyOiDnvJblj7fkuI3orrjlhpnov5vlm57lpI3jgIIKCua1geW8j+ayoeacieOAjOaJk+WbnumHjeeUn+aIkOOAjei/",
  "meS4qumAiemhue+8muS4gOWPt+S9jeesrOS4ieenkuWwseeci+ingeWtl+S6hu+8jOetieivtOWujOWGjeaKueaOiemHjeadpe+8",
  "jArmr5Tor7TplJnkuIDlj6Xmm7TkvKTjgILmiYDku6UgQTYg55qE6LSo6YeP5L+d6K+B5Y+q6IO96JC95ZyoIHByb21wdCDkuovl",
  "iY3lkozml6Xlv5fkuovlkI7jgIIKb2JzZXJ2ZS50cyDmmK/kuovlkI7pgqPkuIDljYog4oCU4oCUIOWPquiusOi0pu+8jOaKiuOA",
  "jOWPguiwi+acgOi/keaYr+S4jeaYr+WcqOmAgOWMluOAjeWPmOaIkOS4gOS4quiDveeci+eahArmlbDlrZfjgILnrKzkuIDmrKHl",
  "rp7ot5HlsLHorrDliLDkuIDmnaHnnJ/ov53op4TvvJpBNi0wMSDlj43pl67lhpnkuobkuKTlj6XjgIIKCiMjIOmhuuaJi+S/ruea",
  "hOS4pOS4quecnyBidWcKCjEuICoq55+t56CB5pig5bCE5LuO5p2l5rKh55Sf5pWI6L+H44CCKiogYGZldGNoSXNzdWVDb250ZXh0",
  "YCDnmoQgY29kZU9mIOaYr+WPr+mAieWPguaVsO+8jAogICDlm5vkuKrosIPnlKjngrnkuIDkuKrpg73msqHkvKAg4oCU4oCUIOS6",
  "juaYr+WOi+e8qeWZqOWvueavj+S4gOadoemDvemAgOWbniBbbWVtYmVyOnh4eF3vvIzlsY/luZXorqTkuI3lh7rjgIEKICAg54K5",
  "5LiN5byA77yM6ICMIHByb21wdCDlj6rog73lj43lpI3lj67lmLHmqKHlnovjgIzkuI3opoHlvJXnlKjlroPjgI3jgILlj6/pgInl",
  "j4LmlbDlnKjov5nph4zmmK/plJnnmoTorr7orqHvvJoKICAg5b+Y5LqG5Lyg5rKh5pyJ5Lu75L2V5oql6ZSZ77yM5Y+q5piv5oKE",
  "5oKE6YCA5YyW44CC5pS55oiQ6buY6K6k5LuOIHNlZWQg55qEIG9udG9sb2d5UmVmcyDlj43nrpfjgIIKICAg77yI5LmL5omA5Lul",
  "5LiA55u05rKh5pq06Zyy77yM5piv5Zug5Li65rKZ566x5Yiw5LiN5LqG5pys5L2T77yM6L+Z5p2h6Lev5b6E5rKh6KKr6LeR6L+H",
  "44CC77yJCjIuICoqd3JhcE9udG9sb2d5Q29udGV4dCDnmoTor7TmmI7mmK/lj43nmoQqKu+8jOWGmeedgOOAjFttZW1iZXI6eHh4",
  "XSDljp/moLfkv53nlZnljbPlj6/vvIwKICAg5bGP5bmV5Lya5oqK5a6D5Y+Y5oiQ5Y+v54K55byA55qE44CN4oCU4oCUIOmCo+aY",
  "ryBjb21waWxlLnRzIOWHuueOsOS5i+WJjeeahOaWh+ahiOOAgueFp+Wug+WBmuS8mueos+WumgogICDkuqflh7rmrbvpk77mjqXj",
  "gIIKCiMjIOmhuuW4pgoKLSDmir3lh7ogbGliL2FnZW50L2pzb24udHPvvIjmqKHlnovosIPnlKggKyBKU09OIOino+aekO+8ieS4",
  "jiBsaWIvYWdlbnQvcnVsZXMudHPvvIhHLSog5YWo5bGA6Zeo77yJ44CCCiAg5LiN5piv5Li65LqG5bCR5YaZ5Yeg6KGM77ya6KO4",
  "5byV5Y+344CBbWF4X3Rva2VucyDmiKrmlq3jgIFtYXJrZG93biDorrDlj7fov5nlh6DkuKrlnZHlr7nlm5vkuKogYWdlbnQKICDm",
  "mK/lkIzkuIDmibnvvIzlkITkv67kuIDpgY3lsLHkuIDlrprmnInkuIDlpITmvI/mjonvvIzogIzmvI/mjonnmoTpgqPlpITkvJrl",
  "nKjmvJTnpLrlvZPlpKnlh7rnjrDjgIIKICBBMyDkuIDlubbmlLnmiJDnlKjov5nkuKTkuKrmqKHlnZfvvIzlm57lvZLpgJrov4cK",
  "LSByZXNlYXJjaFN0YXR1cyDkuI3lho3lnKjjgIzmsqHmnInmiqXlkYrjgI3ml7bml6DmnaHku7bov5Tlm54gcnVubmluZ+OAguec",
  "n+aOpeS4iuaooeWei+S5i+WQjumCo+aYrwogIOWBh+ivne+8muS4gOasoeWksei0peeahOiwg+eUqOS8muiuqeWxj+W5leawuOi/",
  "nOi9rOWciOOAgueOsOWcqOaMieecn+WunuS7u+WKoeeKtuaAgeetlAotIOa3seeglOaMieiurumimOinpuWPke+8jOS4jeWGjeWF",
  "qOmHj+WQjuWPsOi3keOAguS5neS4quiurumimOS4gOi1t+a3seeglOaYr+S5neasoeWHoOWIhumSn+eahOaooeWei+iwg+eUqO+8",
  "jAogIOiAjOS7lui/meS4gOWIu+WPquWcqOeci+WFtuS4reS4gOS4qiDigJTigJQg5oiQ5pys6KaB6Lef552A5rOo5oSP5Yqb6LWw",
  "Ci0g5Lya5YmNIEJyaWVmIOaUueaIkOS7jua3seeglOWbm+iKgueOsOijhemFje+8iHN5bnRoQnJpZWbvvIzml6DmqKHlnovosIPn",
  "lKjvvInjgILlho3lj6vkuIDmrKHmqKHlnovlj6rkvJoKICDlvpfliLDkuIDku73nlKjkuI3lkIzmjqrovp7or7TlkIzkuIDku7bk",
  "uovnmoTkuJzopb/vvIzogIzkuKTku73lkIzmupDnu5PorrrmkYblnKjkuIDotbfvvIzku5bkvJrku6XkuLrpgqPmmK/kuKTkuKoK",
  "ICDni6znq4vliKTmlq0g4oCU4oCUIOmCo+aYr+S4u+WKqOWItumAoOWBh+eahOS6pOWPiemqjOivgQotIHBhc3RNZWRpYW5MYWJl",
  "bCDnnJ/nmoTljrvmlbDlt7Llrprov4fnmoTlkIznsbvorq7popjvvIzmlbDkuI3lh7rmnaXlsLHor7TjgIzpppbkvosgwrcg5peg",
  "5Y6G5Y+y5Lit5L2N44CN44CCCiAg57yW5LiA5Liq5Z+657q/5Ye65p2l77yM5bGP5bmV5LiK6YKj5Y+l44CM5q+U6L+H5Y675b+r",
  "5LqG44CN5bCx5piv5YGH55qECgojIyDov5jmsqHlgZogLyDov5jmsqHpqozor4EKCi0gQTFhIE1hdGVyaWFsaXR5IOWNoeWcqOac",
  "rOS9k+eahOS4ieS4quaOpeWPo++8iOaMiSBpZCDlj5blr7nosaEgLyDlj43lkJHkvp3otZYgLyDmjInnsbvlnovliJfkuL7vvIkK",
  "LSBBMWIgQ0VPIEludGVudCDmsqHlgZoKLSDmnKzkvZPkuIrkuIvmlofov5nmnaHot6/lvoTku43nhLbmsqHlnKjnnJ/lrp7nvZHn",
  "u5zkuIvot5Hov4fvvIjmspnnrrHliLDkuI3kuoYgMTE1LjE5MC4yMTMuNDQ6ODAwMO+8ieOAggogIOS4iumdouaJgOacieWunua1",
  "i+mDveaYryBUS09TX09OVE9MT0dZX0NPTlRFWFQ9MCDkuIvnmoTmiJDnu6kg4oCU4oCUIOijheS4iuacrOS9k+WPquS8muabtOWO",
  "mu+8jAogIOS9huesrOS4gOasoeW4puacrOS9k+eahOi/kOihjOimgeWcqOacrOacuuehruiupAotIEFSS19NT0RFTF9BTFQg6L+Y",
  "5piv56m655qE44CCQTQg55qE54us56uL56ys5LqM5rqQ44CBcnVicmljIEw0IOeahOS6pOWPiSBqdWRnZSDpg73ov5jmsqHnnJ/o",
  "t5Hov4cKLSDmnKzkvZPph4znmoTkurrlkI3mmK/jgIxDRU8g6KeS6Imy77yIRFJJIOWyl+S9je+8ieOAjei/meexu+WNoOS9je+8",
  "jOaJgOS7pSBBMiDmjJHlh7rmnaXnmoTmib/mjqXkurrlhpnnmoTmmK8KICDljaDkvY3lkI3jgILov5nmmK/mlbDmja7pl67popjk",
  "uI3mmK/ku6PnoIHpl67popjvvIzopoHlnKjmnKzkvZPpgqPovrnooaXnnJ/lkI0KCkNvLUF1dGhvcmVkLUJ5OiBDbGF1ZGUgT3B1",
  "cyA1IDxub3JlcGx5QGFudGhyb3BpYy5jb20+CkNsYXVkZS1TZXNzaW9uOiBodHRwczovL2NsYXVkZS5haS9jb2RlL3Nlc3Npb25f",
  "MDFRWDdaRHpjQ201N1l2eENmOTVWSkR5Cg=="
)

$tmp = Join-Path $env:TEMP "tkos-a4-msg.txt"
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
