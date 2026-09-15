# 交办给 Codex：把这一版推上火山引擎，并让雷达两条路都真的能跑

你的任务是**上线**，不是改产品。产出是一次可用的发版 + 一份可核对的回报。

---

## 0. 地形：两个仓库、两台进程

| | 前端（正式版） | 实验台 |
|---|---|---|
| 仓库 | `clark-main`（这个仓库，分支 `dri/web`） | 同级目录 `../tkos-lab`（Python + FastAPI） |
| 跑法 | docker 容器，`deploy/ecs/deploy-release.sh` 蓝绿发版 | 宿主上的 systemd 进程，`scripts/serve.py` |
| 端口 | 稳定内网口 `127.0.0.1:3120`，蓝绿 `3121`/`3122` | `0.0.0.0:8080` |
| 机器 | `tokenhub-prod-app-01` = `115.191.26.230`，用户 `tokenhub-deploy`，私钥 `C:\Users\10021\Desktop\clark\tokenhub-prod-ssh.pem` | 同一台 |

**`deploy-release.sh` 从头到尾只 `docker run` 一个 `clark-main` 容器，它不会替你把 `scripts/serve.py` 起起来。** 实验台是另一个进程、另一套 systemd，得你手装。

雷达有两条路，**依赖的东西完全不同**：

- **手动雷达**（一号位在屏幕上点「主动开始扫描」）：**整轮在容器自己里跑**（`src/lib/scan/run.ts`：按靶点策略拟检索式 → 博查/豆包 → 逐条研判 → 落库）。它要的只有已经配着的检索 key 和模型 key，**跟实验台无关**，实验台不在也照跑。2026-08-31 之前这一条是去实验台起 run 的，那套 `TKOS_LAB_*` 变量连同 §4 整节一起删了。
- **自动雷达**（常态供给）：`tkos-catch.timer` → `tkos-catch.service` → `/opt/tkos-catch/.venv/bin/python scripts/catch.py --from-run $TKOS_CATCH_FROM_RUN` → `POST <前端>/api/signals/inbox`，靠 `x-operator-token` 认。**这一条没变**，仍然要实验台和它的库。

**两条路现在按两份靶点策略跑**：手动那条读 `src/lib/scan/strategy-body.ts`，自动那条读 `TKOS_CATCH_FROM_RUN` 指的那次实验。改一边不带动另一边——这是这一版留下的欠账，记在 DECISIONS.md 的 O 节。

---

## 1. 边界（先读完再动手）

1. **不改产品代码。** 上线的就是工作树现在这个样子。发现 bug、发现文案不对、发现哪一行看着别扭：记下来写进回报，不要顺手修——这一版是要给词元云集 CEO 用的，改一行就得重跑一遍验证。
2. **密钥只搬不看。** `.env.local`、`/etc/tokenhub/clark-main.env`、`/opt/tkos-lab/.env`、`/etc/tokenhub/tkos-catch.env` 里的**值**一律不许出现在终端回显、日志、commit、和你的回报里。变量名可以写，值不行。要确认某一位配上了，用「存在性」判断，别 `cat`：
   ```bash
   sudo grep -cE '^OPERATOR_TOKEN=.+' /etc/tokenhub/clark-main.env      # 期望 1
   ```
3. 这三位在线上**必须**是这个值，动了就是事故：`TKOS_MODE=live`、`TKOS_SEED_FROZEN=1`、`TKOS_MODEL_MOCK` 留空。`TKOS_SEED_FROZEN=0` 的意思是「下一次容器重启把真实回传换回示例数据，日志里只有一行 warn」。
4. **不许把 8080 开到公网。** 实验台只从 docker0 网关进。公网这一侧靠火山安全组不开 8080 挡住，不靠绑定地址。
5. 不许 `resetDemo`、不许删 `/srv/tokenhub/data/clark-main`（那是一号位真实回传的落盘处）、副本数保持 1（快照是单进程单写者）。
6. **不动 DNS、不动安全组、不签证书。** 有需要先在回报里提出来，等 Sean 定。
7. 拿不准的**部署细节**自己综合判断做掉，然后在回报里说明你为什么这么选。拿不准的**产品行为**不要自己决定，写进回报。

---

## 2. 前端发版

### 2.1 发版前（开发机上）

```bash
npx tsc --noEmit
npx vitest run
```

两条都得干净（当前基线：55 个文件 / 394 个测试全过）。这台机器上跑不了 `next build`/`next dev` 的沙箱限制不适用于你——如果你能跑 `pnpm build`，跑一次更好。

`git status` 现在是一堆未提交改动（判断板那批活）。`deploy-clark.ps1` **打包的是工作树、包含未提交改动**，所以不提交也能发上去；但这一版要给 CEO 用，请先在 `dri/web` 上提交一次，让「线上跑的是哪份代码」查得到。提交信息按仓库既有风格写（看 `git log`）。

### 2.2 发版

在 **PowerShell** 里跑（不是 Git Bash）：

```powershell
cd C:\Users\10021\Desktop\clark\clark-main\deploy\ecs
.\deploy-clark.ps1
```

**默认不要加 `-RefreshSecrets`。** 只有 `.env.local` 里的运行期值真的变了才加。

本地和线上现在**没有必须分开的运行期值**了——原来有两位（实验台地址要换成 docker0 网关、实验台 run id 要换成线上库里那条），随手动雷达搬回本仓库一起没了。

时间预期（2026-08-13 实测）：全命中缓存 32 秒；只改源码约 45–90 秒；动了 lockfile 4–8 分钟（国内 npm 镜像是主要成本）。

### 2.3 发版后

```bash
curl -s http://127.0.0.1:3120/api/health | jq '{commit, mode, modelMock, seed, upstream}'
```

`seed.frozen` 必须是 `true`，`mode` 是 `live`，`modelMock` 不为真。

对外那一侧（`demo.tokenkingos.com` → `127.0.0.1:3120`）：

```bash
# 这个脚本发版时不会被自动送上去（deploy-clark.ps1 只 scp release 包、deploy-release.sh
# 和 nginx-clark-internal.conf），自己 scp 一份：
scp -i "$KEY" deploy/ecs/verify-demo-access.sh tokenhub-deploy@115.191.26.230:/tmp/
sudo bash /tmp/verify-demo-access.sh '<访问口令>'     # 口令由 Sean 给你，不要写进任何文件
```

它断言：`/` 307 到 `/access?next=%2F`、`/api/health` 200、`/api/data` 401、错口令 401、口令大写也能进（口令不区分大小写是有意的）、进来之后页面上有品牌字标。

**还要从机器外面打一次**，脚本只走 `127.0.0.1` + Host 头，验不到 DNS 和安全组：

```bash
curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' http://demo.tokenkingos.com/
```

⚠️ 这个 vhost 现在**只有 80、没有 TLS**（`deploy/ecs/nginx-clark-public.conf`），也就是说 CEO 输的那句访问口令在公网上是明文。这件事写进回报，等 Sean 定要不要上证书——**你不要自己去签**。

---

## 3. 实验台常驻起来（本次重点：`scripts/serve.py` 要真的在跑）

一律照 `../tkos-lab/deploy/README.md` 和那三个 unit 文件走，**unit 文件从仓库 `install` 过去，别照文档里的片段重打一遍**。

### 3.1 系统位

```bash
sudo useradd -r -s /usr/sbin/nologin tkos 2>/dev/null || true
sudo install -d -o tkos -g tkos -m 750 /var/lib/tkos-lab
python3 -V            # 要 3.10+
```

### 3.2 代码 + venv

把 `tkos-lab` 弄到 `/opt/tkos-lab`（能直连 GitHub 就 `git clone https://github.com/VanillaCoca/tkos-lab.git`，不行就从开发机 scp 一份工作树，排除 `.git`/`.venv`/`var`）：

```bash
cd /opt/tkos-lab
sudo python3 -m venv .venv
sudo .venv/bin/pip install -e '.[all]'     # 慢就加 -i https://mirrors.aliyun.com/pypi/simple/
sudo .venv/bin/python -m pytest -q         # 自测，可选但建议
```

### 3.3 `.env`

从开发机把 `tkos-lab/.env` 搬上去（**scp，不要 cat、不要贴进 shell 历史**），落成 `/opt/tkos-lab/.env`，`root:root 600`——systemd 是以 root 读 `EnvironmentFile` 之后才降到 `User=tkos` 的，所以不用给 tkos 读权限。

里面**不要**写 `TKOS_INBOX_URL` / `TKOS_INBOX_TOKEN`：实验台自己从不投递，给一个从不投递的进程发凭据只是白多一份泄露面（那两位在 §5 的 `tkos-catch.env` 里）。

`TKOS_LAB_PASSWORD` 只给实验台自己的 HTTP 口用（人去它界面上调参）。**前端不再持有它**——手动雷达搬回本仓库之后，clark 这一侧一个 `TKOS_LAB_*` 都不读了。两侧要对上的凭据只剩一把：`tkos-catch.env` 里的 `TKOS_INBOX_TOKEN` 和 `/etc/tokenhub/clark-main.env` 里的 `OPERATOR_TOKEN`，核对不许打印值，用哈希比：

```bash
# 两边分别跑，比对输出的前 12 位。注意 grep 出来的是 KEY=VALUE，切掉 KEY= 再算。
sudo sed -n 's/^TKOS_INBOX_TOKEN=//p' /opt/tkos-catch/.env | sha256sum | cut -c1-12
sudo sed -n 's/^OPERATOR_TOKEN=//p' /etc/tokenhub/clark-main.env | sha256sum | cut -c1-12
```

`.env` 里那两个路径默认是相对路径（`var/lab.db`），**不用管**——unit 文件里用 `Environment=` 覆盖成绝对路径了，而且必须是本地磁盘：网络挂载上 SQLite 拿不到文件锁。

### 3.4 把库搬上去（**自动雷达卡在这一格**）

`TKOS_CATCH_FROM_RUN` 指的那条 run 必须在**线上这个库里**存在，线上库是空的 → 自动作业报「没有这条 run」+ 退出码 2。（手动雷达不再受这一格影响：它不读实验台的库。）

本次选定 **`r-0c83cca630`**（`channel=catching`、`status=done`、2026-08-20 14:47、第③段正文 3454 字、spec 是 `time_window_hours=720` / `threshold=3.5` / `search_provider=bocha` / `discovery.max_new_sources=3`）。`.env.local` 里现在写的 `r-bbf2f19afb` spec 与正文和它一字不差，但那条 run 卡在 `running`，所以换用跑完的这条。

在开发机上导一份干净的单文件（`VACUUM INTO` 会把 WAL 里的内容一起结算进去，比拷 `lab.db` + `-wal` + `-shm` 三个文件稳）：

```bash
cd ../tkos-lab
python -c "import sqlite3; sqlite3.connect('var/lab.db').execute(\"VACUUM INTO 'var/lab-upload.db'\")"
```

传上去、就位、给权限（**实验台此时还没起，或者先 `systemctl stop tkos-lab`**）：

```bash
sudo install -o tkos -g tkos -m 640 /tmp/lab-upload.db /var/lib/tkos-lab/lab.db
sudo -u tkos /opt/tkos-lab/.venv/bin/python - <<'EOF'
import sqlite3
c = sqlite3.connect("/var/lib/tkos-lab/lab.db")
print(c.execute("select id, channel, status from runs where id='r-0c83cca630'").fetchone())
EOF
```

最后一行必须打出 `('r-0c83cca630', 'catching', 'done')`。打出 `None` 就别往下走。

### 3.5 常驻

```bash
sudo install -m 644 /opt/tkos-lab/deploy/tkos-lab.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now tkos-lab
systemctl is-enabled tkos-lab            # 期望 enabled
systemctl is-active tkos-lab             # 期望 active
curl -sS 127.0.0.1:8080/health | head -c 400
journalctl -u tkos-lab -n 30 --no-pager  # 看有没有「journal 模式降级」这类告知
```

三件事别自作聪明改动 unit：

- `Restart=always` 管**进程崩了**自动拉起，`enable` 管**机器重启**自动起——两件事，少哪件都会变成「昨天还好好的，今天连不上实验台」。**两件都要，最后 `systemctl is-enabled` 必须是 `enabled`。**
- `Environment=HOST=0.0.0.0` 是有意的，不要改成 `127.0.0.1`：容器眼里的 `127.0.0.1` 是容器自己，同机也打不到宿主的 loopback。
- `ProtectSystem=full`（不是 `strict`）：`strict` 会把 `/opt` 变成只读，venv 与 `src` 下的 `__pycache__` 就写不进去。

---

## 4. 手动雷达（这一节没有活儿了）

原来这一节是「把容器接到实验台」：改 `TKOS_LAB_BASE_URL` 指向 docker0 网关、核对
`TKOS_LAB_PASSWORD`、在容器里 `fetch` 一次 `/health` 和 `/api/login`。

2026-08-31 之后这一整套都不需要了 —— 手动雷达在容器自己里跑完（见 §0）。它要的东西
`.env.local` 里本来就有：`TKOS_SEARCH_PROVIDER` 加对应的检索 key、以及模型那几位。
**要验的话就验这两样在容器里读得到**：

```bash
container="$(. /srv/tokenhub/apps/clark-main/current.env; echo "$CURRENT_CONTAINER")"
sudo docker exec "$container" node -e   "console.log('provider', process.env.TKOS_SEARCH_PROVIDER || '(未配)')"
```

期望打出 `bocha,doubao` 这类值而不是 `(未配)`。屏幕上那一下（登录 → 「主动开始扫描」→
五步走完）由 Sean 点，你不用也不要去输访问口令。

---

## 5. 自动雷达（抓取作业 + 定时）

### 5.1 另一份 checkout

**作业和实验台是两份 checkout**，作业按 tag 部署、不跟主干走——否则实验台改坏 `sources/` 会直接打到一号位的每日供给上。

⚠️ `tkos-lab` 仓库**现在一个 tag 都没有**。先在开发机上给当前 `main`（`9e25356`）打一个，例如：

```bash
cd ../tkos-lab && git tag lab-2026-08-20 && git push origin lab-2026-08-20
```

然后 `sudo git clone -b lab-2026-08-20 <repo> /opt/tkos-catch`。不方便打 tag 就 clone 后 `git checkout 9e25356`（detached 也行，它是一次显式动作），并把用的是哪个 commit 写进回报。

```bash
cd /opt/tkos-catch && sudo python3 -m venv .venv && sudo .venv/bin/pip install -e '.[all]'
```

### 5.2 只有作业才有的三位

```bash
sudo install -d -m 755 /etc/tokenhub
sudo install -m 600 /dev/null /etc/tokenhub/tkos-catch.env
# 用 sudo tee + heredoc 写入，别 echo 到有回显的地方
```

三位的值：

| 变量 | 值 | 为什么 |
|---|---|---|
| `TKOS_INBOX_URL` | `http://127.0.0.1:3120/api/signals/inbox` | 作业和前端在同一台机器上，走内网口就不用把 operator token 送上明文公网、也不依赖域名和证书。这是对 `tkos-lab/deploy/README.md` 里 `https://<域名>` 那个例子的有意偏离，理由就是这一条 |
| `TKOS_INBOX_TOKEN` | 等于前端 `/etc/tokenhub/clark-main.env` 里的 `OPERATOR_TOKEN` | 对不上就是 401。用 §3.3 那个 sha256 前 12 位的办法核对，别打印值 |
| `TKOS_CATCH_FROM_RUN` | `r-0c83cca630` | 见 §3.4 |

顺带确认收件口那侧是活的：`OPERATOR_TOKEN` 没配的话 `/api/signals/inbox` 直接 503（`src/app/api/signals/inbox/route.ts`）。

### 5.3 装 unit、先手动跑一轮

```bash
sudo install -m 644 /opt/tkos-catch/deploy/tkos-catch.service \
                    /opt/tkos-catch/deploy/tkos-catch.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl start tkos-catch                  # 一轮真模型可能很久，unit 里给了 2h
journalctl -u tkos-catch -f                      # 看漏斗和「已投递 N 条」
```

**光看退出码不够，401 也是退出码 1。** 必须看见信号真的落进前端：

```bash
sudo jq '.state.inboxSignals | length' /srv/tokenhub/data/clark-main/store.json
```

跑之前记一个数、跑完再记一个数，报回这两个数。（快照是防抖落盘的，等几秒再读；数字没长而 journal 里写着「已投递 N 条」就是收件口那侧拒了，回去核 token。）

**收下 0 条不一定是故障**：漏斗可能停在时窗或研判（全在 3.5 分以下）。这种情况把 journal 里的漏斗那几行原样贴进回报，不要自己去调 spec——参数是方法部门在实验台定的。

### 5.4 定时

```bash
timedatectl                                      # 火山 ECS 默认 UTC
sudo systemctl enable --now tkos-catch.timer
systemctl list-timers tkos-catch.timer
```

unit 里写的是 `OnCalendar=Mon,Wed,Fri 04:00`，**时间是主机本地时区**。机器是 UTC 的话这就是北京中午 12 点；要北京凌晨四点，把 `/etc/systemd/system/tkos-catch.timer` 里那一行改成 `20:00` 再 `daemon-reload`（`systemd < 252` 不认 `OnCalendar` 后面的时区名，所以靠改数字，别加时区）。

改完把 `systemctl list-timers` 的下一次触发时刻报回来，我们按北京时间核。

---

## 6. 交付前核对（每条都要能一眼核）

1. `curl -s http://127.0.0.1:3120/api/health | jq .seed` → `frozen: true`。**`frozen` 是 false 就先别灌纲领。**
2. 副本数 1（`docker ps` 里 `clark-main` 只有一个容器在跑）。
3. 备份：crontab 里那一行在，且 `/srv/tkos/backups` 下今天有一份。
4. `systemctl is-enabled tkos-lab tkos-catch.timer` → 两个都是 `enabled`。
5. §4.2 那条 `docker exec … fetch` 在**容器里**打得通（`200`）。
6. `sudo systemctl start tkos-catch` 那一轮跑过，且 `inboxSignals` 的条数变了（或者漏斗解释了为什么是 0）。

（六条 DRI 链接那一项本次不在你范围内，Sean 自己发。）

---

## 7. 回报格式

一件事一段，每段：**做了什么 → 真实命令 → 真实输出（脱敏）**。不要写「已成功配置」这种没有输出支撑的句子。另外单列三块：

- **待 Sean 定**：至少包括「公网只有 80、访问口令走明文，要不要上证书」。
- **我改了但文档没说的**：比如 `TKOS_INBOX_URL` 走 loopback、`r-0c83cca630` 换掉 `.env.local` 里那个、tag 是新打的。每条带一句为什么。
- **看见但没动的**：产品上觉得不对的地方、日志里的告知、任何 warn。

不许出现在回报里的：任何密钥、口令、token 的值；`/etc/tokenhub/*.env` 与 `.env` 的整段内容。
