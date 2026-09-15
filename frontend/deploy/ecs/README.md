# Clark ECS deployment

Clark runs as a dynamic Next.js container on `tokenhub-prod-app-01`.

- Stable internal endpoint: `127.0.0.1:3120`
- Blue/green container ports: `127.0.0.1:3121` and `127.0.0.1:3122`
- Releases: `/srv/tokenhub/apps/clark-main/releases`
- Persistent state: `/srv/tokenhub/data/clark-main`
- Runtime secrets: `/etc/tokenhub/clark-main.env` (`root:root`, mode `600`)
- Docker data root: `/srv/tokenhub/docker`

The deployment script builds a new image, starts it on the inactive port,
waits for `/api/health`, switches Nginx, and removes the previous container.
If `node:24-slim` is not cached, it is pulled through DaoCloud's Docker
Official Image proxy before the build.
The public firewall is unchanged; preview through an SSH tunnel:

```powershell
ssh -i "C:\Users\10021\Desktop\clark\tokenhub-prod-ssh.pem" `
  -N -L 3120:127.0.0.1:3120 tokenhub-deploy@115.191.26.230
```

Then open `http://127.0.0.1:3120`.

For routine releases, run `deploy-clark.ps1` from this directory. It packages
the current working tree (including uncommitted source changes), excludes
secrets and local state, verifies SHA-256 on the server, and calls the
blue/green release script. Pass `-RefreshSecrets` only when `.env.local`
runtime values changed.

## Measured deployment times (2026-08-13)

- First base image pull: 235 seconds (one-time cache warm-up).
- First application image build: 307 seconds, including 216 seconds for the
  initial dependency download.
- Fully cached blue/green release: 32.3 seconds end to end; Docker build 1
  second.
- A normal source-only change also reruns the Next.js production build, which
  measured about 7 seconds on this ECS. Allow roughly 45-90 seconds end to end.
- A lockfile/dependency change can take 4-8 minutes because the domestic npm
  mirror is the dominant cost.

## 实验台这条链路（只剩自动供给那一半）

**实验台不在这套部署里。** 它是另一个仓库（同级的 `tkos-lab`，Python + FastAPI）、
另一个进程，`deploy-release.sh` 从头到尾只 `docker run` 一个 `clark-main` 容器，不会
帮你把 `scripts/serve.py` 起起来。要它常态化在，装那侧的 systemd：
`tkos-lab/deploy/` 下的 `tkos-lab.service`（HTTP 口）+ `tkos-catch.{service,timer}`
（每天推一轮信号进 `/api/signals/inbox` —— 屏幕上写的是「每天自动检测」，
那个 timer 的节奏就是这句话的唯一出处，改它要连着改产品里的三处文案）。

**方向只剩一个：实验台推过来。** clark 这一侧不再拨号找实验台 —— 那六个
`TKOS_LAB_*` 变量、`src/lib/scan/lab.ts` 和「容器里的 127.0.0.1 是容器自己」
那一整套 docker0 网关配置，2026-08-31 随「主动开始扫描」搬回本仓库一起删了
（见 DECISIONS.md 的 O 节）。所以这一侧现在只需要一样东西：`OPERATOR_TOKEN`
和实验台 `.env` 里那个是同一个值 —— 收件口认的是它。

**代价记在这里：两条路现在按两份靶点策略跑。** 手点那一轮读的是
`src/lib/scan/strategy-body.ts`；实验台那个 timer 读的是它自己那份
（`TKOS_CATCH_FROM_RUN` 指的那次实验）。改了一边不会带动另一边 —— 要么两边同步改，
要么把自动那一轮也搬过来（还没做）。

## 上线检查

四条，每条都要能一眼核：

1. `curl -s https://<域名>/api/health | jq .seed` → `{"frozen": true, "drift": …}`。**`frozen` 是 false 就先别灌纲领。**
2. `docker compose config | grep replicas` → 1。
3. crontab 里那一行在，且 `/srv/tkos/backups` 下今天有一份。
4. 六条 DRI 链接已发出（`TKOS_ACCESS_SECRET=<线上> TKOS_BASE_URL=https://<域名> node scripts/dri-link.mjs`），每个人都确认过「进来看见自己的名字」。
5. 实验台那条自动供给（要常态化供给才需要）：`systemctl is-enabled tkos-lab tkos-catch.timer` 两个都是 `enabled`，且它 `.env` 里的 `OPERATOR_TOKEN` 和 `/etc/tokenhub/clark-main.env` 里那个是同一个值（比哈希，别打印值）。

## 灌纲领

一条真的 curl：

```bash
curl -sS -X POST https://<域名>/api/om/intake \
  -H 'content-type: application/json' \
  -H "x-operator-token: $OPERATOR_TOKEN" \
  -d @om-2026-09.json | jq .
```

`om-2026-09.json` 的形状：

```json
{
  "period": {
    "id": "PRD-2026-09",
    "label": "2026 年 9 月",
    "starts_on": "2026-09-01",
    "ends_on": "2026-09-30"
  },
  "company_outcome": {
    "statement": "<公司这一个月要拿下的那一件事>",
    "due_on": "2026-09-30"
  },
  "domains": [
    {
      "domain_id": "D-04",
      "north_star": "<这个域这一个月的北极星>",
      "items": [
        { "proposed": "<公司提给这个域的一条>", "tier": "acceptance" },
        { "proposed": "<再一条>", "tier": "required" }
      ]
    }
  ]
}
```

要点：
- 顶层只有 `period` / `company_outcome` / `domains` 三个键。**没有 `projectId`**（`commitmentsIntake` 自己补 `tk.projects[0].id`）。
- 缺了就整批 400 的：`period.id`、`period.starts_on`、`period.ends_on`、每个域的 `domain_id` 与 `north_star`、每个域至少一条 `items`、每条 `items[].proposed`。
- `period.label` 与 `company_outcome.statement` / `due_on` 缺了不拒，按空串收。
- `starts_on > ends_on` 直接拒（它会一路错到「还剩几天」）。
- `tier` 不给或给空串**默认 `acceptance`**；给了别的值就拒。

**9 月周期从空白建，不复用 `seed-agent-domain.ts` 里那五张示例 Mission**（它们是手写的 04 域示例，会跟真实 OM 撞 id）。
