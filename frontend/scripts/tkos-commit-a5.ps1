# TKOS -- commit this round (ISS-101 + doc bodies + Judgement Graph).
#
#   cd C:\Users\10021\Desktop\clark\clark-main
#   powershell -ExecutionPolicy Bypass -File .\scripts\tkos-commit-a5.ps1
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
  "src\lib\data\seed-agent-domain.ts",
  "src\lib\agent\a6\extract.ts",
  "src\components\advisor\judgement-graph.tsx",
  "src\lib\data\store.ts",
  "src\lib\agent\a4\prompt.ts"
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
  "MDQg5Z+f55yf5a6e6K6u6aKYIElTUy0xMDHvvJpNaXNzaW9uIENhcmQg5Lqk5Y+J6K+75Ye65p2l55qEIDgvMjIg5Yay56qBCgrn",
  "rKzkuIDmibnluKbmraPmlofnmoTmlofmoaPvvIzku6Xlj4rnrKzkuIDkuKrkuI3mmK/ku47mnKzkvZPnlJ/miJDjgIHogIzmmK/k",
  "u47kuKTlvKDljaHlubbmjpLnnIvlh7rmnaXnmoTorq7popjjgIIKCiMjIElTUy0xMDEKCk1DLTIg6YeM56iL56KRIDgvMjIg5pS+",
  "6Ze46K+E5Lyw77yM6aOO6Zmp5aSE572u5YaZ5q2744CM57K+5bqm5LiN6L6+5qCH5bCx5bu26ZW/5b2x5a2Q77yM5LiN5o+Q5YmN",
  "5pS+6Ze444CN44CCCk1DLTUg6YeM56iL56KRIDgvMjIg6L2oIEEg6Zet546v77yM5oiQ5Yqf6K+B5o2u4pGi6KaB5rGC44CM4oml",
  "MSDkuKogRGVjaXNpb24g5Y+v5rqv5rqQ5YiwIFNlbnNvciDljaHniYfjgI3jgIIKCuS4gOW8oOWNoeeahOmqjOaUtuivgeaNru+8",
  "jOWJjee9ruS+nei1luaYr+WPpuS4gOW8oOWNoeaUvumXuO+8m+S4pOW8oOWNoeeahOmHjOeoi+eikeaYr+WQjOS4gOWkqe+8m+iA",
  "jOWug+S7rOeahOmjjumZqQrlpITnva7mlrnlkJHnm7jlj43jgILkuKTlvKDljaHlkIToh6rpg73lr7nvvIzlkIjotbfmnaXmmK/k",
  "uIDkuKrlv4XpobvnlLHkuIDlj7fkvY3mi43mnb/nmoTlj5boiI3vvJrlrojnsr7luqbpl6jvvIwK6L+Y5piv5a6I5YyX5p6B5pif",
  "5pel5pyf44CCCgrlroPliqjmkYcgMDQg5Z+f5LuF5pyJ55qE5Lik5p2h5Zyo54mI5Yik5pat77yIMDQtSjEg57K+5bqm5LyY5YWI",
  "5LqO5Y+s5ZueIC8gMDQtSjIg5YWI6L2oIEEg5ZCO6L2oIELvvInjgIIK5Y2h54mH5p2l5rqQ5qCH55qE5pivIGRyacK35a2Z6ZOt",
  "5rO9IOiAjOS4jeaYryByYWRhciDigJTigJQg6Zu36L6+6L+Y5rKh5YGa77yM5qCH5oiQIHJhZGFyIOetieS6juaKigrjgIzmnInk",
  "urrlnKjlpJbpnaLnm6/nnYDlj5jljJbjgI3ov5nkuKrlj6/kv6HluqbmnaXmupDkvKrpgKDlh7rmnaXjgIIKCiMjIOaJi+WGmeen",
  "jeWtkOWNleeLrOaIkOaWh+S7tgoKc2VlZC10b2tlbmtpbmcudHMg5piv55Sf5oiQ54mp77yM5aS05LiA6KGM5YaZ552A5LiN6KaB",
  "5omL5pS544CCTWlzc2lvbiBDYXJkIOWSjOWkjeebmOi/mOayoei/m+acrOS9k++8jArnoazloZ7ov5vnlJ/miJDmlofku7bkvJrl",
  "nKjkuIvmrKHph43ot5Hml7booqvpnZnpu5jlhrLmjonvvIzkuZ/kvJrorqnjgIzlsY/luZXkuIrnmoTkuJzopb/mmK/kuI3mmK/m",
  "naXoh6rmnKzkvZPjgI0K6L+Z5Liq6Zeu6aKY5rKh5rOV5Zue562U44CC5omA5Lul5Y2V54usIHNlZWQtYWdlbnQtZG9tYWluLnRz",
  "77yM5p2l5rqQ5YaZ5riF5qWa77yM6L+b5LqG5pys5L2T5bCx5Yig5o6J5a6DCuiuqeeUn+aIkOWZqOaOpeeuoeOAggoKIyMg5L+u",
  "5LqG5Lik5Liq6K6p5paH5qGj5q2j5paH55m95Yqg55qEIGJ1ZwoKMS4gKirmnInmraPmlofnmoTmlofmoaPmsLjov5zov5vkuI3k",
  "uoYgcHJvbXB044CCKiog5Y+W5paH5qGj5pivIGBzdG9yZS5kb2NzLnNsaWNlKDAsIDEwKWDvvIwKICAg6ICM5pys5L2T5p2l55qE",
  "IDIyIOS7vSBTb3VyY2VSZWNvcmQg5YWo5piv56m65q2j5paH44CB5YWo5o6S5Zyo5YmN6Z2i44CC5rex56CU6YeM6YKj5Y+lCiAg",
  "IOOAjERPQy0wOSDmoIfkuLrpq5jnrqHorqjorrrnqL8gdjAuMu+8jOivtOaYjuS7jeWkhOS6juaXqeacn+iuqOiuuumYtuauteOA",
  "jeWwseaYr+i/meS5iOadpeeahCDigJTigJQKICAg5a6D5omL5LiK5Y+q5pyJ5paH5Lu25ZCN77yM5Y+q6IO95LuO5paH5Lu25ZCN",
  "5o6o44CC546w5Zyo5pyJ5q2j5paH55qE5o6S5YmN6Z2i44CCCjIuICoq5pyA55u45YWz55qE6YKj5Lu95Zug5Li65aSq6ZW/6KKr",
  "5pW05Lu95Lii5o6J44CCKiog5o6S5Yiw5YmN6Z2i5LmL5ZCO77yMMTU3MjMg5a2X55qEIE1pc3Npb24gQ2FyZHMKICAg6LaF6L+H",
  "IDEyMDAwIOmihOeul+iiq+i3s+i/h++8jOS6juaYr+aKpeWRiuWFqOeoi+W8leeUqOasoeebuOWFs+eahOWkjeebmO+8jOi/mOWc",
  "qOOAjOS4jeehruWumuaAp+OAjemHjOWGmQogICDjgIzpnIDopoHosIPpmIUgRE9DLTUx44CN4oCU4oCUIOiAjCBET0MtNTEg5bCx",
  "5Zyo5omL6L6544CC5Lii5byD5q+U5oiq5pat5pu057Of77ya5oiq5pat6Iez5bCR6L+Y5Ymp5LiA5Y2K44CCCiAgIOaUueaIkOaI",
  "quaWre+8jOW5tuS4lCoq5oqK5oiq5LqG5aSa5bCR5YaZ6L+b5q2j5paHKirvvJrjgIzlhbEgTiDlrZfvvIzlj6rnu5nkuobliY0g",
  "TSDlrZfvvIzov5jmnIkgSyDlrZfmsqHnu5njgI3jgIIKICAg5qih5Z6L5LqO5piv5Lya5oqK5rKh6K+75Yiw55qE6YOo5YiG5YaZ",
  "6L+b5LiN56Gu5a6a5oCn77yM6ICM5LiN5piv5YGH6KOF6K+75a6M5LqG44CCCgpwcm9tcHQg6YeM5Lmf5YiG5LqG5Lik5qCP77ya",
  "5pyJ5q2j5paH55qE55u05o6l57uZ5YWo5paH77yM5Y+q5pyJ5qCH6aKY55qE5piO6K+044CM5L2g5Y+q5pyJ5qCH6aKY77yMCuS4",
  "jeiuuOS7juagh+mimOWPjeaOqOWGheWuuSDigJTigJQg5LuO5paH5Lu25ZCN5o6o5Ye657uP6JCl57uT6K6677yM6K+76LW35p2l",
  "5ZKM55yf5YiG5p6Q5LiA5qC377yM6ICM5a6D5piv54yc55qE44CN44CCCgojIyDlrp7mtYvvvIhJU1MtMTAx77yM5pa56IifIGRl",
  "ZXBzZWVrLXY0LXBybyArIGRvdWJhbyDnrKzkuozmupDvvIkKCuS/ruS5i+WJje+8muWFqOeoi+W8leeUqCBET0MtNTLvvIzliKTm",
  "lq3lgZzlnKjjgIzlhYjljpjmuIXmmK/lkKbmnoTmiJDnoazliY3mj5DjgI3vvIznrYnkuo7msqHooajmgIHjgIIK5L+u5LmL5ZCO",
  "77ya5Yik5pat5Y+Y5oiQ44CM5LiN5piv5YWI5a6I6L2oIEEg6Zet546v5pel5pyf77yM6ICM5piv5YWI5a6IIFNlbnNvciDmlL7p",
  "l7jpl6jmp5vjgI3vvIwK5rqv5rqQ5YaZ55qE5pivIERPQy01MSDCtyBNQy0yIOWFs+mUrui3r+W+hOS4jumjjumZqSAvIERPQy01",
  "MSDCtyBNQy01IOaIkOWKn+ivgeaNruS4jumjjumZqeOAggoK54us56uL56ys5LqM5rqQ77yIZG91YmFv77yJ6L+Z5qyh5om+5Yiw",
  "IDIg5p2h55yf5Y+N6K+B77yM6ICM5LiU5piv56Gs55qE77yaCuOAjE1DLTUg5oiQ5Yqf6K+B5o2u4pGi5pyq6ZmE5Yqg6LGB5YWN",
  "5p2h5qy+77yMU2Vuc29yIOacqui/h+mXqOWwseaXoOWQiOazleWNoeeJh++8jOivpeivgeaNruW/heeEtue8uuWkseOAjeKAlOKA",
  "lArlroPlnKjmi7/mib/or7rljaHnmoTmnaHmrL7ljrvlhrLkuLvmupDnmoTliKTmlq3jgILov5nmmK8gQUxUIOanveS9jeesrOS4",
  "gOasoeecn+ato+W5sua0u+OAggoKIyMgSnVkZ2VtZW50IEdyYXBo77ya6K6u6aKY56CU56m25bem5qCP6YeN5YGaCgrmjInmiKrl",
  "m77ph43lgZrjgILml6fnmoTmjqLorqjpk77ot6/lm77mmK/kuIDmo7UqKua0nuingeagkSoq77yI6IqC54K55piv5LuO5oql5ZGK",
  "6YeM6K+75Ye655qE5Yik5pat77yM5Y+v5Lul5YiG5Y+J77yJ77ybCuaWsOeahOaYr+S4gOadoSoq5Yik5pat55qE54mI5pys6ZO+",
  "KirvvJpK4oKAIOKGkiBDRU8g6L+96ZeuIOKGkiBK4oKBIOKGkiBDRU8g6L+96ZeuIOKGkiBK4oKC77yM5q+P5LiA54mI5peB6L65",
  "5Y+q5YaZCuOAjOWPmOWMlu+8mkEg4oaSIELjgI3vvIzkuI3ph43ov7DliKTmlq0g4oCU4oCUIOS4gOWPt+S9jeWbnuWktOajgOaf",
  "peaXtumXrueahOaYr+OAjOWTquS4gOatpeWPmOeahOOAjeOAggoKIyMjIErigoAg5piv5oqV5b2x77yM5LiN5piv5paw5Y+r5LiA",
  "5qyh5qih5Z6LCgpK4oKAIOeahOWGheWuueWFqOmDqOW3sue7j+WcqCBSZXNlYXJjaERvYyDph4zvvJrmgLvliKTmlq3mmK8ganVk",
  "Z21lbnRbMF3vvIzkuInmnaHljp/lm6DmmK8ga2V5RXZpZGVuY2XvvIwK44CM5LuN54q56LGr44CN5piv5pyA6KaB57Sn55qE6YKj",
  "5p2hIHVua25vd25z44CC5YaN5Y+r5LiA5qyh5qih5Z6L5Y+q5Lya5b6X5Yiw5LiA5Lu95o2i5LqG5o6q6L6e55qE5ZCM5rqQ57uT",
  "6K66IOKAlOKAlArogIzkuKTku73mjqrovp7kuI3lkIznmoTlkIzmupDnu5PorrrmkYblnKjkuIDlj7fkvY3pnaLliY3vvIzku5bk",
  "vJrku6XkuLrpgqPmmK/kuKTkuKrni6znq4vliKTmlq3jgIIqKumCo+aYr+WcqOS4u+WKqArliLbpgKDlgYfnmoTkuqTlj4npqozo",
  "r4HjgIIqKiDlkowgc3ludGhCcmllZiDlkIzkuIDkuKrnkIbnlLHjgIIKCuS7o+S7t+aYryBK4oKAIOeahOaOqui+nuWPlyBBNCDn",
  "uqbmnZ/vvJvmlLbnm4rmmK/lroPlkozmiqXlkYrmsLjov5zkuIDoh7TvvIzngrnjgIzljp/mlofjgI3ot7Pov4fljrvlr7nlvpfk",
  "uIrjgIIK5LiJ5p2h5Y6f5Zug5ZCE6Ieq6IO96Lez5Yiw5oql5ZGK6YeM5a+55bqU55qE6YKj5LiA5Y+l77yIcmVhc29uc1tpXSDi",
  "hpQga2V5RXZpZGVuY2VbaV3vvInjgIIKCuOAjOS7jeeKueixq+OAjeS4uuepuuaXtuWxj+W5leaYjuivtOOAjOWPguiwi+ayoeac",
  "ieWGmeWHuuS7u+S9leS7jeeKueixq+eahOWcsOaWuSDigJTigJQg6L+Z5pys6Lqr5YC85b6X5oKo6Zeu5LiA5Y+l5Li6CuS7gOS5",
  "iOOAje+8jOS4jeeVmeeZveOAgueVmeeZveivu+i1t+adpeWDj+OAjOi/meS4quWIpOaWreayoeacieW8seeCueOAje+8jOiAjOec",
  "n+WunuaDheWGteaYr+WPguiwi+ayoeWGmeWHuuW8seeCue+8jArov5nkuKTku7bkuovnmoTlkKvkuYnnm7jlj43jgIIKCiMjIyDk",
  "u4DkuYjnrpfjgIzlrp7otKjlj5jljJbjgI3nlLHmqKHlnovliKTvvIzkuI3nlLHor43ooajliKQKCuaWsOWiniBsaWIvYWdlbnQv",
  "YTYvZXh0cmFjdC50c+OAguavj+i9ruWvueivneS5i+WQjui3keS4gOasoSBmbGFzaCDliIbnsbvvvIzliKTlrprliKTmlq3mnInm",
  "sqHmnInooqsK5a6e6LSo5Yqo5pGH44CCKirlroPmnIDph43opoHnmoTooYzkuLrmmK/ku4DkuYjpg73kuI3lgZoqKiDigJTigJQg",
  "5LiA5Zy65rex6IGK5Y2B5Yeg6L2u77yM55yf5q2j5pS55Y+Y5Yik5pat55qE5Y+v6IO9CuWPquacieS4pOS4iei9ru+8jOWFtuS9",
  "meaYr+a+hOa4heOAgeihpeS6i+WunuOAgeS4gOWPt+S9jeWcqOaDs+OAgumCo+S6m+S4gOadoemDveS4jei/m+Wbvu+8m+i/m+S6",
  "hu+8jOW3puagj+WwseaYrwrnrKzkuozku73ogYrlpKnorrDlvZXvvIzogIzlroPlrZjlnKjnmoTlhajpg6jnkIbnlLHmgbDmgbDm",
  "mK/lroPkuI3mmK/jgIIKCnByb21wdCDnmoTph43lv4Plm6DmraTkuI3lnKjjgIzmgI7kuYjmj4/ov7Dlj5jljJbjgI3vvIzlnKjj",
  "gIzku4DkuYjkuI3nrpflj5jljJbjgI3vvIzpu5jorqTnrZTmoYjmmK8gZmFsc2XjgIIK5Yik5o2u5b6I56Gs77yaKirog73kuI3o",
  "g73lhpnlh7rkuIDkuKogZnJvbSDihpIgdG8g55qE5a+55a2QKirvvIzlhpnkuI3lh7rlsLHmmK/msqHmlLnjgILku6PnoIHph4zl",
  "ho3mn6XkuIDpgY3vvJoK6K+05LqG44CM5pS55LqG44CN5Y2057uZ5LiN5Ye6IGZyb20vdG8g5oiW5paw5Yik5pat5YWo5paH77yM",
  "6ZmN57qn5oiQ44CM5rKh5pS544CN6ICM5LiN5piv5omT5Zue6YeN55Sf5oiQIOKAlOKAlArph43nlJ/miJDkvJror7Hlr7zlroPm",
  "ioogZnJvbS90byDnvJblh7rmnaXlh5HpvZDvvIzogIzmiJHku6zopoHnmoTmgbDmgbDmmK/lroPmlaLor7TjgIzmsqHmlLnjgI3j",
  "gIIKCuS4uuS7gOS5iOS4jeS7juWvueivnea1gemHjOino+aekO+8muWIpOaWreacieayoeacieWPmOaYr+ivreS5iemXrumimOOA",
  "gueUqOato+WImeWSjOWFs+mUruivjeWwseaYryBBNi0wNSDmoL3ov4fnmoQK6YKj5Liq6Lef5aS0IOKAlOKAlCDmjaLkuKror7Tm",
  "s5XlsLHmvI/vvIzlh7rnjrDkuIDkuKrjgIzmiYDku6XjgI3lsLHor6/mlL7jgIIKCiMjIyDml4HmlK/kv53nlZnvvIzkvYbljovo",
  "p4bop4nmnYPph40KCuS4gOWPt+S9jeacieaXtuaPkOeahOS4jeaYr+WvueW9k+WJjeWIpOaWreeahOi0qOeWke+8jOaYr+WPpuS4",
  "gOS4quaWueWQkeOAguehrOWhnui/m+S4u+mTvuS8muiuqeeJiOacrOWPt+WPmOaIkOa1geawtOi0pu+8mwrkuKLmjonlj4jnrYnk",
  "uo7lkYror4nku5bjgIzkvaDor7TnmoTkuI3nrpfmlbDjgI3igJTigJQg6ICM5Zu+5LiN5piv5Y+C6LCL55qE6L6T5Ye677yM5piv",
  "6L+Z5Zy656CU6K6o55qE6K6w5b2V44CCCuaJgOS7pee8qei/m+OAgeaXoOeJiOacrOWPt+OAgeS4jeWNoOS4u+i9qOOAguaXgeaU",
  "r+W/hemhu+WGmeWHuuOAjOS4uuS7gOS5iOaJo+edgOi/meS7tuiurumimOOAjeW5tuaRhuWcqOWbvumdouS4iu+8mgrkuLvpk77m",
  "r4/kuIDmnaHnlLHliY3kuIDmnaHmjqjlh7rmnaXvvIzmiaPpopjmmK/oh6rmmI7nmoTvvJvml4HmlK/mmK/mqKrmj5Lov5vmnaXn",
  "moTvvIzpgqPmmK/or7vogIXnrKzkuIDkuKrkvJrpl67nmoTpl67popjjgIIKCiMjIyDlrp7mtYvvvIhJU1MtMTAx77yJCgpK4oKA",
  "44CM5LiN5piv6L2oIEEg6Zet546v5pel5pyf5LyY5YWI77yM6ICM5pivIFNlbnNvciDmlL7pl7jpl6jmp5vkvJjlhYjjgI3vvIgx",
  "MCDku73mnZDmlpkgwrcgMi4wIOS4h+WtlyDCtyDlt7LpgJror7vvvIkK4oaSIOaIkemAhuedgOmXruOAjOi/meecn+aYr+WPluiI",
  "jeWQl++8n+i/mOaYr+S9oOivu+mUmeS6hiDigJTigJQgTUMtMiDor7TnmoTmmK/or4TkvLDvvIzkuI3mmK/lv4XpobvlvZPlpKnm",
  "lL7pl7jjgI0K4oaSIOWPguiwi+WbnuOAjOaCqOivtOW+l+Wvue+8jOaIkeivu+mUmeS6huOAjeW5tue7meWHuuS/ruatowrihpIg",
  "6JCD5Y+W5Yik5a6aIEowIOKGkiBKMe+8jOWPmOWMluOAjFNlbnNvciDmlL7pl7jkvJjlhYjvvIzovaggQSDpobrlu7Yg4oaSIOiv",
  "hOS8sOS4jumXreeOr+S4jeWGsueqge+8jOi9qCBBIOeFp+W4uOOAjQoK56ys5LqM6L2u6L+96Zeu5rKh5pyJ5YaN5pS55Yik5pat",
  "77yM5Zu+5LiK5q2j56Gu5Zyw5rKh5pyJ5paw5aKe6IqC54K577yM5pel5b+X6K6w44CM5Yik5pat5rKh5pyJ5a6e6LSo5Y+Y5YyW",
  "44CN44CCCgpwcm9iZS1tYXAudHN4IOWIoOmZpO+8iOiiqyBqdWRnZW1lbnQtZ3JhcGgudHN4IOWPluS7o++8ieOAguaKpeWRiiDi",
  "hpIg5Zu+55qE6IqC54K56auY5Lqu5LiA5bm25Y675o6J77yaCueJiOacrOmTvuS4iuavj+S4gOadoemDveaYr+S7juWvueivnemV",
  "v+WHuuadpeeahO+8jOWSjOaKpeWRiumHjOeahOWPpeWtkOayoeacieS4gOS4gOWvueW6lO+8jOehrOaMh+S4gOS4quS8muaMh+mU",
  "meOAggoKQ28tQXV0aG9yZWQtQnk6IENsYXVkZSBPcHVzIDUgPG5vcmVwbHlAYW50aHJvcGljLmNvbT4KQ2xhdWRlLVNlc3Npb246",
  "IGh0dHBzOi8vY2xhdWRlLmFpL2NvZGUvc2Vzc2lvbl8wMVFYN1pEemNDbTU3WXZ4Q2Y5NVZKRHkK"
)

$tmp = Join-Path $env:TEMP "tkos-a5-msg.txt"
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
