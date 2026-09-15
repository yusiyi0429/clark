# TKOS -- push this round as a pull request.
#
#   cd C:\Users\10021\Desktop\clark\clark-main
#   powershell -ExecutionPolicy Bypass -File .\scripts\tkos-pr.ps1
#
# What it does, in order:
#   1. refuse if the tree is dirty or the 5 commits carry secrets
#   2. tsc / eslint / build
#   3. branch feat/tkos-demo at HEAD, push it
#   4. move local main back to origin/main  (the commits live on the branch --
#      nothing is lost; `git branch -f main HEAD_SHA` puts it back)
#   5. open the PR with gh if present, otherwise print the compare URL
#
# ASCII only + CRLF on purpose: Windows PowerShell 5.1 reads .ps1 as the system
# ANSI codepage (GBK on a Chinese Windows) unless there is a UTF-8 BOM, which
# mangles non-ASCII text and can swallow a closing quote. The Chinese title and
# body therefore travel as base64 and are written out as raw UTF-8 bytes.
#
# Not "Stop": PowerShell turns native-command stderr into a terminating error
# under Stop, and git writes its progress notes to stderr.
$ErrorActionPreference = "Continue"
function Say ($m) { Write-Host "`n$m" -ForegroundColor Cyan }
function Ok  ($m) { Write-Host "  [ OK ] $m" -ForegroundColor Green }
function Note($m) { Write-Host "  [ -- ] $m" -ForegroundColor DarkYellow }
function Bad ($m) { Write-Host "  [FAIL] $m" -ForegroundColor Red }
function Dim ($m) { Write-Host "         $m" -ForegroundColor DarkGray }

$BRANCH = "feat/tkos-demo"

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

Say "=== Working tree ==="
# This script and its PR body are its own artefacts -- they land untracked on
# the first run and would otherwise trip the dirty gate every time. Commit them
# as a chore, then require the rest of the tree to be clean: everything else in
# the PR has to be a real commit somebody wrote, not something swept in here.
$mine = @("scripts/tkos-pr.ps1", "docs/PR-tkos-demo.md")
$pending = @(git status --porcelain $mine)
if ($pending.Count -gt 0) {
  $pending | ForEach-Object { Dim $_ }
  git add -- $mine
  $b64chore = "Y2hvcmU6IFBSIOiEmuacrOS4juato+aWhw=="
  [IO.File]::WriteAllBytes(
    (Join-Path $root ".git\COMMIT_TKOS.txt"),
    [Convert]::FromBase64String($b64chore)
  )
  git commit -F ".git\COMMIT_TKOS.txt" -- $mine
  Remove-Item ".git\COMMIT_TKOS.txt" -Force -ErrorAction SilentlyContinue
  if ($LASTEXITCODE -ne 0) { Bad "chore commit failed"; exit 1 }
  Ok "committed this script and the PR body"
}

$entries = @(git status --porcelain)
if ($entries.Count -gt 0) {
  Bad "tree is dirty -- commit or stash first, this script only pushes what is already committed:"
  $entries | ForEach-Object { Write-Host "    $_" -ForegroundColor Red }
  exit 1
}
Ok "clean"

Say "=== Commits to ship ==="
git fetch origin --quiet
$commits = @(git log --oneline origin/main..HEAD)
if ($commits.Count -eq 0) { Ok "nothing ahead of origin/main"; exit 0 }
$commits | ForEach-Object { Dim $_ }
Dim ("{0} commit(s)" -f $commits.Count)
$HEADSHA = (git rev-parse HEAD).Trim()

# Hard refusal: a secret or a build artefact anywhere in the range is not
# something a PR review will catch -- it is already in history by then.
Say "=== Secrets / build output in the range ==="
$touched = @(git log --name-only --pretty=format: origin/main..HEAD | Where-Object { $_ -ne "" } | Sort-Object -Unique)
$danger = $touched | Where-Object {
  $_ -match "\.env\.local|\.env\.docker$|^\.data/|\.tgz$|node_modules|^\.next/|resolve-sample|render-sample|_to_delete"
}
if ($danger) {
  Bad "refusing -- these are in the commit range:"
  $danger | ForEach-Object { Write-Host "    $_" -ForegroundColor Red }
  Dim "they are already committed; rewrite history before pushing"
  exit 1
}
Ok ("{0} files touched, none of them secrets or build output" -f $touched.Count)

Say "=== Typecheck + lint + build ==="
pnpm exec tsc --noEmit
if ($LASTEXITCODE -ne 0) { Bad "tsc failed"; exit 1 }
Ok "tsc"
pnpm exec eslint src --max-warnings=0
if ($LASTEXITCODE -ne 0) { Bad "eslint failed"; exit 1 }
Ok "eslint"
pnpm build
if ($LASTEXITCODE -ne 0) { Bad "build failed"; exit 1 }
Ok "build"

Say "=== Branch ==="
$exists = (git rev-parse --verify --quiet ("refs/heads/" + $BRANCH))
if ($exists) {
  Note "$BRANCH already exists locally -- moving it to HEAD"
  git checkout $BRANCH
  if ($LASTEXITCODE -ne 0) { Bad "checkout failed"; exit 1 }
  git reset --hard $HEADSHA
} else {
  git checkout -b $BRANCH
  if ($LASTEXITCODE -ne 0) { Bad "branch failed"; exit 1 }
}
Ok "on $BRANCH at $HEADSHA"

Say "=== Push ==="
git push -u origin $BRANCH
if ($LASTEXITCODE -ne 0) { Bad "push failed -- branch exists locally, rerun when the network is back"; exit 1 }
Ok "pushed"

# Local main goes back to origin/main so that merging the PR does not leave the
# two diverged. Nothing is lost: every commit is on the branch, and
#   git branch -f main HEADSHA
# puts main back exactly where it was.
Say "=== Realign local main ==="
git branch -f main origin/main
if ($LASTEXITCODE -ne 0) { Note "could not move main -- harmless, fix it after the merge" }
else { Ok ("main -> origin/main   (undo: git branch -f main {0})" -f $HEADSHA) }

Say "=== Pull request ==="
$titleB64 = @"
5pyN5Yqh56uv5pWw5o2u5bGCICsg5Zub5LiqIEFnZW50ICsg6K6/6Zeu6ZeoICsgZGVtbyDlhoXl
rrnljIU=
"@
$bodyB64 = @"
IyDmnI3liqHnq6/mlbDmja7lsYIgKyDlm5vkuKogQWdlbnQgKyDorr/pl67pl6ggKyBkZW1vIOWG
heWuueWMhQoK6IeqIGBvcmlnaW4vbWFpbmAg6LW355qE5LqU5qyh5o+Q5Lqk44CC5Li757q/5Y+q
5pyJ5LiA5p2h77yaKirmioogVEtPUyDku47kuIDku73liY3nq6/mvJTnpLrvvIzlj5jmiJDkuIDk
uKrnnJ/nmoTkvJroh6rlt7HnoJTnqbbjgIHoh6rlt7Hnu5nliKTmlq3jgIHlubbkuJTmiorliKTm
lq3mjIHkuYXljJbnmoTns7vnu58qKu+8m+acgOWQjuS4gOasoeaPkOS6pOaKiueOi+aAu+mCo+Wc
uiBkZW1vIOeahOWGheWuueaMiSBXb3JkIOWMheWOn+aWh+ijheS6hui/m+WOu+OAggoKIyMg5Li6
5LuA5LmI6L+Z5Lqb5pS55Yqo6KaB5LiA6LW36L+bCgpgYTNkNmU4MGAg5oqK5pWw5o2u5bGC5pCs
5Yiw5pyN5Yqh56uv5LmL5ZCO77yMQWdlbnQg5omN5pyJ5Zyw5pa56LeR77ybQWdlbnQg6LeR5Ye6
5p2l55qE5Lic6KW/6KaB6JC95Yiw5Yik5pat5p2/5LiK77yM5omN6ZyA6KaBIGB0eXBlcy50c2Ag
6YeM6YKj57uE5paw5a+56LGh77yb5Yik5pat5p2/5pyJ5LqG5YaF5a6577yM6aaW6aG15Y+z5qCP
5omN5pyJ5Lic6KW/5Y+v5pi+56S644CC5Lit6Ze05Lu75L2V5LiA5q2l5Y2V54us5ZCI6L+b5Y67
6YO95piv5LiA5Liq5pei5LiN6IO95ryU56S644CB5Lmf5LiN6IO96Ieq5rWL55qE5Lit6Ze05oCB
44CCCgotLS0KCiMjIDHvvZzmlbDmja7lsYLmkKzliLDmnI3liqHnq6/vvIhgYTNkNmU4MGDvvIkK
CmBjbGllbnQudHNgIOS7jiAyOTAwIOihjOe8qeWIsCAxMzgg6KGM77ya5a6D546w5Zyo5Y+q5piv
5LiA5LiqIFJQQyDlrqLmiLfnq6/vvIw1NCDkuKrmlrnms5XkuIDlrZfmnKrmlLnlnLDmiZPliLAg
YFBPU1QgL2FwaS9kYXRhYOOAguWunueOsOWFqOmDqOaQrOi/myBgbGliL2RhdGEvc3RvcmUudHNg
77yIc2VydmVyLW9ubHnvvInjgIIKCi0gKirkuIDkuKogUlBDIOerr+eCue+8jOS4jeaYryA1NCDm
naEgUkVTVCDot6/nlLHjgIIqKiDov5nkuI3mmK/lhazlvIAgQVBJ77yM5Y+q6KKr5oiR5Lus6Ieq
5bex55qE5YmN56uv6LCD55So44CCMToxIOaYoOWwhOiuqSBgY2xpZW50LnRzYCDnmoTosIPnlKjn
grnnnJ/mraPlgZrliLDkuIDkuKrlrZfkuI3mlLnvvJvpk7ogNTQg5p2h6Lev55Sx5Y+q5piv5oqK
5ZCM5LiA5Lu25LqL5YaZIDU0IOmBjeOAggotIOWuieWFqOi+ueeVjO+8muaWueazleWQjeW/hemh
u+WRveS4reeZveWQjeWNle+8iOeZveWQjeWNleWwseaYryBgYXBpYCDoh6rlt7HnmoTplK7vvInv
vIzlj4LmlbDlv4XpobvmmK/mlbDnu4TvvIzkuI3mjqXlj5fku7vmhI/lsZ7mgKfot6/lvoTvvIzk
uI3lgZogZXZhbOOAggotIGBsaWIvZGF0YS9wZXJzaXN0LnRzYO+8muWvueixoeW6k+iQveebmOWI
sCBgLmRhdGEvc3RvcmUuanNvbmDvvIzpmLLmipblkIjlubbjgIIqKuenjeWtkOaMh+e6ueWPquWT
iOW4jOaVsOaNrumbhueahOi6q+S7vSoq77yI6K6u6aKYIGlkK+agh+mimOOAgeWIpOaWrSBpZCvp
mYjov7DjgIHkurrjgIHln5/vvInvvIzkuI3lk4jluIzmlbTkuKogc3RvcmUg4oCU4oCUIOWTiOW4
jOaVtOS4qiBzdG9yZSDnmoTpgqPkuIDniYjph4zvvIxgVE9EQVlgIOS4gOWPmOaMh+e6ueWwseWP
mO+8jOW/q+eFp+iiq+WIpOWumuS4uuOAjOenjeWtkOW3suWPmOOAjeS4ouW8g++8jOS4gOWPt+S9
jeWRqOS4gOeUqOWujOWRqOS6jOWbnuadpeWPkeeOsOWvueivneWSjOaKpeWRiuWFqOayoeS6hu+8
jOiAjOaXpeW/l+mHjOWPquacieS4gOWPpeOAjOenjeWtkOW3suWPmOOAjeOAggotIGBsaWIvYWdl
bnQvbW9kZWxzLnRzYO+8mueBq+WxseaWueiIn+WkmuaooeWei+anveS9je+8iFBSTyAvIEZMQVNI
IC8gQUxU77yJ44CCQUxUIOWIu+aEj+mAiSoq5LiN5ZCM5a625pePKirnmoTmqKHlnosg4oCU4oCU
IOWQjOS4gOWutuaXj+eahOesrOS6jOasoeiwg+eUqOS4jeaYr+eLrOeri+esrOS6jOa6kO+8jOaY
r+WQjOS4gOS4quWBj+ingeivtOS4pOmBjeOAggoKIyMgMu+9nEEzIOmihOeglCArIOacrOS9k+S4
iuS4i+aWh+WOi+e8qe+8iGA4ODRkYTZjYO+8iQoKLSBgbGliL2FnZW50L2EzLypg77ya6aKE56CU
IEFnZW5044CC5q+P5p2h6KKr5o2V5o2J6L+b5p2l55qE5r2c5Zyo6K6u6aKYKirkuIDov5vmnaXl
sLHoh6rliqjot5HkuIDku70qKu+8jOWbnuetlOS4gOS4qumXrumimO+8mui/meWAvOS4jeWAvOW+
l+aCqOiKseaXtumXtOOAggotIGBsaWIvb250b2xvZ3kvY29tcGlsZS50c2DvvJrmiormnKzkvZPl
r7nosaHljovmiJDmqKHlnovog73lkIPnmoTkuIrkuIvmlofvvIxgW21lbWJlcjp4eHhdYCDmjaLm
iJDlj6/ngrnnmoTnn63noIHjgIIKLSDnp43lrZDku47miL/mh4Lmh4LmjaLmiJDor43lhYPkupHp
m4bvvIhgc2VlZC10b2tlbmtpbmcudHNg77yM5LuO5pys5L2T5LuT5bqT55qEIGAudHJpZ2Ag55Sf
5oiQ77yJ44CCCgojIyAz772cQTQg5rex56CUIC8gQTIg5a6a6aKYIC8gQTEwIOWGmeWbniAvIEE2
IOingua1i++8iGA0NTdkOGEzYO+8iQoK5Zub5LiqIEFnZW50IOWKoOS4pOS4quWFseS6q+aooeWd
l+OAguWFseS6q+aooeWdl+WtmOWcqOeahOeQhueUseaYr+S4ieS4quWdkeavj+S4qiBBZ2VudCDp
g73kvJrouKnvvJoKCi0gYGxpYi9hZ2VudC9qc29uLnRzYCDigJTigJQgYHJlc3BvbnNlX2Zvcm1h
dDoganNvbl9vYmplY3RgIOaMoeS9j+ijuOW8leWPt++8m2BmaW5pc2hfcmVhc29uID09PSAibGVu
Z3RoImAg5b2T5oiQ5aSx6LSl6ICM5LiN5piv5b2T5oiQ57uT5p6c77yb5YmlIGBgYGpzb24g5Zu0
5qCP44CCKirnu5PmnoTkv53or4Hog5zov4fmsYLmqKHlnovliKvpgqPkuYjlubLjgIIqKgotIGBs
aWIvYWdlbnQvcnVsZXMudHNgIOKAlOKAlCDnoa7lrprmgKfnmoTotKjph4/op4TliJnlhpnmiJDk
u6PnoIHvvIhwMCDmi6bmiKogKyDkv67lpI3vvIxwMSDlj6rorrDlvZXvvInvvIzpnIDopoHliKTm
lq3lipvnmoTpgqPkupvmiY3kuqTnu5nmqKHlnovjgIIKCuWAvOW+l+WNleeLrOivtOeahOS4pOad
oeinhOWIme+8mgoKLSAqKkE0LTAzIOWPjeivgeS4uumbtiA9IHAw44CCKiog5LiA5Lu95rKh5pyJ
5Y+N6K+B55qE5rex56CU5oql5ZGK5LiN5piv44CM6L+Z5Lu25LqL5rKh5pyJ5Y+N6Z2i44CN77yM
5piv6L+Z5LiA6L2u5rKh5pyJ5Zyo5om+5Y+N6Z2i44CCCi0gKipBNC0xMyoqIOKAlOKAlOOAjOiL
pS/lpoLmnpwv5LiA5pem44CN5byA5aS044CB5LiU5ZSv5LiA5rqv5rqQ5pivIGBraW5kOiAiYWdl
bnQiYCDnmoTpgqPmnaHvvIzmmK/mqKHlnovoh6rlt7HnvJbnmoTmg4Xmma/mjqjmvJTvvIzkuI3m
mK/lj43or4Hkuovlrp7jgILov5nmnaHmmK/nnJ/ot5Hlh7rmnaXkuYvlkI7ooaXnmoTjgIIKCmBB
TFRgIOesrOS4gOasoeecn+eahOW5sua0u++8mmRvdWJhbyDmi7/lkIjlkIzmnaHmrL7mlLvkuLvl
iKTmlq3vvIhNQy01IOaIkOWKn+ivgeaNruKRouayoeacieixgeWFjeadoeasvu+8ie+8jOW5tuWF
peOAjOWPjeivgeS4jumjjumZqeOAje+8jOe9suWQjeOAjOeLrOeri+esrOS6jOa6kOOAjeOAggoK
IyMgNO+9nOWIpOaWreadvyArIEE2IOingua1iyArIOiuv+mXrumXqO+8iGA1MzIwYTFjYO+8iQoK
LSBgY29tcG9uZW50cy9hZHZpc29yL2p1ZGdlbWVudC1ib2FyZC50c3hgIOWPluS7oyBgcHJvYmUt
bWFwLnRzeGDjgILkuIrkuIvkuKTlsYLvvJoqKuS4iuWNiuWxguaYr+WPguiwi+e7meeahOOAgei/
mOayoee7j+i/h+S4gOWPt+S9jeeahO+8m+S4i+WNiuWxguaYr+S7luehruiupOi/h+eahOWFrOWP
uOWPo+W+hOOAgioqIOWxgueUsSBgY29uZmlybWVkYCDlnKjkuI3lnKjlhrPlrprvvIzmsqHmnInj
gIzln7rmnKznoa7orqTjgI3ov5nnp43kuK3pl7TmgIEg4oCU4oCUIOeVmeS6huS4remXtOaAgeea
hOWcsOaWueacgOWQjumDveS8muWghua7oeS4remXtOaAgeOAggotIOS4i+WNiuWxguavj+adoeW/
hemhu+W4piBgc3VwcG9ydGDvvJrlj6rorrDjgIwwNy0xNSDkvJrkuIrnoa7orqTjgI3vvIzljYrl
ubTlkI7lm57lpLTnnIvlj6rnn6XpgZMqKuehruiupOi/hyoq77yM5LiN55+l6YGTKirlh63ku4Dk
uYgqKu+8m+iAjOecn+imgemHjeaWsOaJk+W8gOS4gOadoeWIpOaWreaXtu+8jOimgeajgOafpeea
hOaBsOaBsOaYr+mCo+S4quOAjOWHreS7gOS5iOOAjei/mOaIkOS4jeaIkOeri+OAggotIGBsaWIv
YWNjZXNzLnRzYCAvIGBwcm94eS50c2AgLyBgL2FjY2Vzc2DvvJrmvJTnpLrnjq/looPnmoTlj6Pk
u6Tpl6jjgIJOZXh0IDE2IOaKiiBgbWlkZGxld2FyZWAg5pS55ZCNIGBwcm94eWDvvIzot5HlnKgg
Tm9kZSBydW50aW1lIOS4iu+8jOaJgOS7pSBgbm9kZTpjcnlwdG9gIOWPr+eUqOOAguS4ieaAgemU
meivr++8mjQwMSDmmK/lr4bnoIHplJnvvIw1MDMg5piv5pyN5Yqh56uv5rKh6YWN77yI6L+Z5p2h
6L+H5Y676KKr5riy5p+T5oiQ44CM5pqC5pe25peg5rOV6aqM6K+B77yM6K+356iN5ZCO5YaN6K+V
44CN4oCU4oCUIOaKiumFjee9rumXrumimOivtOaIkOS4tOaXtuaVhemanO+8jOetieS6juiuqeS6
uuS4gOebtOmHjeivleS4gOS7tuawuOi/nOS4jeS8muaIkOWKn+eahOS6i++8ieOAggoKIyMgNe+9
nGRlbW8g5YaF5a655YyF77yIYGFmOWYzODdg77yJCgpgc3JjL2xpYi9kYXRhL3NlZWQtZGVtby50
c2Ag4oCU4oCUICoq5q+P5LiA5Liq5a2X6YO95p2l6Ieq6YKj5YWr5Lu9IFdvcmQg5YyFKirjgILp
nIDopoHpgKDor43nmoTlj6rmnInmjqXnur/vvJppZOOAgeaXtumXtOaIs+OAgeS7peWPiuavj+ad
oeWNoeaMguWcqOacrOS9k+WTquadoeWIpOaWreS4iuOAggoKfCDlsY/luZUgfCDmnaXmupAgfAp8
LS0tfC0tLXwKfCDlm5vmnaHmvZzlnKjorq7popjvvIjkuovlrp4gLyDlvbHlk40gLyDorq7popgg
LyDln5/vvIzml6DlsI/moIfpopjvvIkgfCBQYWNrYWdlIDAxIHwKfCDlm5vku73pooTnoJQgKyBP
YXNpcyDlrozmlbTliKTmlq0gKyDlha3lj6XliafmnKzov73pl64gfCBQYWNrYWdlIDAxIHwKfCDo
v5vooYzkuK0gMiDku7YgLyDlt7Lpg6jnvbIgMyDku7YgfCBQYWNrYWdlIDAyIHwKfCBPYXNpcyDm
t7HnoJTlm5voioIgKyDlm5vmnaHlvoXnoa7orqTliKTmlq0gKyDlm5vova7lr7nosIggfCBQYWNr
YWdlIDA0YSAvIDA0YiB8Cnwg6K+N5YWD5LqR6ZuG5pW05L2T5oiY55Wl77yaNyDmnaHlt7Lnoa7o
rqTliKTmlq0gKyAxIOadoeW+heehruiupCArIDQg6L2u5a+56LCIIHwgUGFja2FnZSAwMyB8Cgoj
IyMg5LiA6YGT57yd77yM5LiN5piv5LiA5Liq5YiG5pSvCgpgVEtPU19NT0RFYCDmmK8gZGVtbyDn
iYjkuI4gTVZQIOeJiOS5i+mXtCoq5ZSv5LiAKirnmoTlvIDlhbPvvIjpu5jorqQgYGRlbW9g77yM
YGxpdmVgIOi1sOecn+aooeWei++8ieOAguWIhuaUr+aIluiAheesrOS6jOS4quS7k+W6k+eci+i1
t+adpeabtOW5suWHgO+8jOS7o+S7t+aYr+S4pOi+ueS8muWQhOiHqumVv+WHuuWvueaWueayoeac
ieeahOS/ruWkjSDigJTigJQg6ICM5ryU56S65YmN5LiA5aSp5Y+R546w55qE6YKj5LiqIGJ1Z++8
jOawuOi/nOaYr+WcqOWPpuS4gOi+ueS/rueahOOAggoK57yd5Y+q5Zyo5Lik5aSE5byg5byA77ya
5YaF5a655LuO5ZOq5Lu956eN5a2Q5p2l77yb5Lul5Y+KIGRlbW8g5LiLIGBlbnN1cmVEZWVwUmVz
ZWFyY2hgIOebtOaOpei/lOWbnuOAgeS4gOasoeaooeWei+mDveS4jeWPq+OAggoKIyMjIOW/q+aN
t+adoei1sOWJp+acrO+8jOi+k+WFpeahhui1sOecn+aooeWeiwoK54K55YyF6YeM6YKj5Yeg5Y+l
5Y6f6Zeu6aKYIOKGkiDpgJDlrZflkJDlh7rljIXph4znmoTljp/nrZTmoYjvvIhgQWR2aXNvclBy
ZXNldC5zY3JpcHRlZGDvvInvvJvoh6rlt7HmiZPlrZcg4oaSIOecn+eahCBkZWVwc2Vla+OAgui/
meS4pOS7tuS6i+W/hemhu+WQjOaXtuWcqO+8jOWQpuWImea8lOekuuimgeS5iOWDj+W9leWDj++8
jOimgeS5iOWcqOWFs+mUruS4gOmXruS4iue/u+i9puOAggoK6LWw5LiN6LWw5Ymn5pys55SxKirm
lbDmja4qKuWGs+WumuiAjOS4jeaYr+eOr+Wig+WPmOmHj++8mumCo+aYr+i/meS4gOe7hOmXruet
lOeahOaAp+i0qO+8jOS4jeaYr+aVtOS4qui/m+eoi+eahOaAp+i0qOOAggoKIyMjIE9hc2lzIOen
jeaIkOa9nOWcqOiurumimO+8jOS4jeaYr+W3suWNh+e6pwoKUGFja2FnZSAwMSDnmoTlr7nosIjn
u5PlsL7mmK/kuIDlj7fkvY3or7TjgIzmiorlroPkvZzkuLrkuIDkuKrmiJjnlaXorq7popjnu6fn
u63noJTnqbbjgI3vvIxQYWNrYWdlIDAyIOeahOmmlumhtea4heWNlemHjOWug+W3sue7j+aYr+W9
k+WJjeaImOeVpeiurumimCDigJTigJQg5ZCO6ICF5piv5YmN6ICF6YKj5qyh5Y2H57qnKirkuYvl
kI4qKueahOeKtuaAgeOAguaJgOS7peenjeaIkOa9nOWcqOiurumimO+8jOaKpeWRiuS4juWIpOaW
readv+mihOWFiOWkh+Wlve+8jOa8lOekuuaXtuW9k+WcuuaMieS4i+WOu+OAguenjeaIkOW3suWN
h+e6p+S8muecgeS6i++8jOS7o+S7t+aYr+aKiua8lOekuumHjOacgOmHjeimgeeahOmCo+S4gOS4
i+WPmOaIkOS4gOW8oOaIquWbvuOAggoKLS0tCgojIyDpobrmiYvmlLnmjonnmoTlm5vlpITlgYfo
r50KCjEuICoqYElzc3VlUmVzZWFyY2hTdGF0dXNgIOWKoOS6hiBgaWRsZWDjgIIqKiDljp/mnaXm
sqHmiqXlkYrlsLHkuIDlvovnrpfjgIzov5vooYzkuK3jgI3igJTigJQg5bGP5bmV5LiK5LiA5Liq
6L2s552A55qE5ZyI77yM5Luj6KGo55qE5Y205piv5LiA5Lu25rKh5pyJ5Lq65Zyo5YGa55qE5LqL
77yM6ICM5LiA5Y+35L2N5Lya5LiA55u0562J5a6D44CCCjIuICoq5om/5o6l5Lq65LiN5YaN6buY
6K6k5Zue6JC95Yiw5Z+fIERSSeOAgioqIOWbnuiQveeahOmCo+S4gOeJiOmHjO+8jOi/meS4quWf
n+S4i+avj+S4gOS7tuiurumimOmDvemVv+WHuuS4gOihjOOAjOetieWImOaYjuWNjuWbnuS8oOOA
je+8jOWMheaLrOS7juadpeayoeS6pOe7mei/h+S7u+S9leS6uueahCDigJTigJQg5LiA5Liq5Lq6
5ZCM5pe244CM5qyg44CN552A5Lmd5Lu25LqL77yM6ICM5LuW5YW25a6e5LiA5Lu26YO95rKh6KKr
6KaB5rGC6L+H44CCCjMuICoq5bey6YOo572y55qE6K6u6aKY5LiN5YaN5pi+56S656CU56m26L+b
5bqmKirvvIzmlLnmmL7npLrpg6jnvbLkuYvlkI7nmoTlvZPliY3nirbmgIHjgILlroPnmoTnoJTn
qbbml6nlsLHnu5PmnZ/kuobjgIIKNC4gKipgQ2FuZGlkYXRlYCDkuI3ov5vjgIzov5vooYzkuK3j
gI3jgIIqKiDlroPov5jmmK/mvZzlnKjorq7popjvvIzlvZLlt6bkuIrop5LpgqPmiYfnqpfjgILm
t7flnKjkuIDotbfkuYvlkI7vvIzjgIzmiJHmiYvkuIrliLDlupXmnInlh6Dku7bkuovjgI3ov5nk
uKrpl67popjlsLHlho3kuZ/msqHmnInnrZTmoYjkuoYg4oCU4oCUIOiAjOmCo+S4gOWIl+WtmOWc
qOeahOWFqOmDqOaEj+S5ieWwseaYr+WbnuetlOWug+OAggoKIyMg6aqM6K+BCgotIGB0c2MgLS1u
b0VtaXRgIC8gYGVzbGludCAtLW1heC13YXJuaW5ncz0wYCAvIGBwbnBtIGJ1aWxkYCDlhajov4fv
vIhXaW5kb3dzIOS4juWuueWZqOS4pOS+p+WQhOi3keS4gOasoe+8ieOAggotIOecn+aVsOaNruec
n+aooeWei+i3kemAmuWFqOmTvui3r++8mkEzIDM5cyAvIEE0IDYw4oCTOTBzIC8gQTIgMTdzIC8g
QTEwIDQyc++8m0E2IOa1geW8j+WbnuWkjeS4u+WKqOaMkeaImOS6huS4gOWPt+S9jeW3sue7j+ih
qOi/h+aAgeeahOWAvuWQke+8jOiAjOS4jeaYr+mZhOWSjOOAggotIOmXreeOr+mqjOivge+8mueh
ruiupOS4gOS7vSBDbG9zdXJlIOS5i+WQju+8jFJlLW9wZW4gVHJpZ2dlciDnlKggQTEwIOiHquW3
seeahOaOqui+nuW4g+aOp+Wbnuebkea1i+mdtueCueOAggotIGRlbW8g5YaF5a655YyF55SoIFBs
YXl3cmlnaHQg6LWw5LqG5LiA6YGN77ya6aaW6aG15LiJ5qGj44CB5Yik5pat5p2/5LiK5LiL5Lik
5bGC44CB5r2c5Zyo6K6u6aKY5Zub5q615Y2h44CBT2FzaXMg6K+m5oOF6aG15LiO56CU56m26aG1
77yM5pegIGNvbnNvbGUgZXJyb3LjgIIKCiMjIOS4jeWcqOi/meS4qiBQUiDph4wKCi0g5Lya5YmN
6aKE5a6h77yIUGFja2FnZSAwNe+8iS8g5Lya6K6u57qq6KaB77yIMDbvvIkvIOS8muWQjuWkjeeb
mO+8iDA377yJ4oCU4oCUIOWtl+auteaYoOWwhOW+heWuoemYheOAggotIEExYSBNYXRlcmlhbGl0
eSAvIEExYiBDRU8gSW50ZW5044CCCi0gYHNjZW5hcmlvcy9gIOWJp+acrOagoemqjO+8iGBzY2Vu
YXJpbzpjaGVja2AgLyBgc2NlbmFyaW86cmVoZWFyc2Vg77yJ44CCCg==
"@
$titlePath = Join-Path $env:TEMP "tkos-pr-title.txt"
$bodyPath  = Join-Path $env:TEMP "tkos-pr-body.md"
[IO.File]::WriteAllBytes($titlePath, [Convert]::FromBase64String(($titleB64 -replace "\s", "")))
[IO.File]::WriteAllBytes($bodyPath,  [Convert]::FromBase64String(($bodyB64  -replace "\s", "")))
Dim "body written to $bodyPath"

$gh = Get-Command gh -ErrorAction SilentlyContinue
if ($gh) {
  $title = [IO.File]::ReadAllText($titlePath, [Text.UTF8Encoding]::new($false))
  gh pr create --base main --head $BRANCH --title $title --body-file $bodyPath
  if ($LASTEXITCODE -eq 0) { Ok "PR opened"; gh pr view --web }
  else {
    Note "gh failed -- open it by hand:"
    Write-Host ("    https://github.com/VanillaCoca/clark/compare/main...{0}?expand=1" -f $BRANCH) -ForegroundColor Cyan
    Dim  "paste the body from $bodyPath"
  }
} else {
  Note "gh CLI not installed -- open this and paste the body from $bodyPath"
  Write-Host ("    https://github.com/VanillaCoca/clark/compare/main...{0}?expand=1" -f $BRANCH) -ForegroundColor Cyan
  Start-Process ("https://github.com/VanillaCoca/clark/compare/main...{0}?expand=1" -f $BRANCH)
}

try { [Console]::OutputEncoding = $__prevOut } catch { }
Say "done."
