# clark-memory-adapter 契约复核（2026-09-01，clark 侧）

接着 `validation-2026-08-31.md` 那一轮。**这一轮是在 clark 这边的 Windows 机器上做的，
没有 workspsce 检出、没有 PostgreSQL、没有 embedding key** —— 所以它验不了数据，只验
**线上契约**：路径、参数、状态码、字段名与可空性、以及两边对同一个失败的理解是否一致。

## 怎么跑的

`memory_service` 换成一个只提供 adapter 真正 import 到的那些名字的替身（`working` 的
九个读函数 + 那批异常类、`actors.require_human`、`context_graph` 的三个模块），
`get_conn` 用 FastAPI 的 `dependency_overrides` 换成假连接，其余**全是仓库里的真代码**：
真的 `adapter.main:app`、真的路由、真的 `contracts.py`、真的错误映射。

clark 那一侧用的是它自己的四层自检（`src/lib/graphknowledge/check.ts`），不是手写的
curl 断言 —— 要验的正是「clark 拿它自己的客户端打过来会怎么样」。

替身与启动脚本不进仓库。

## 对上了的

| 项 | 结果 |
| --- | --- |
| 四条路径 | `/healthz`、`/api/v1/context/static`、`/api/v1/entities/{code}`、`/api/v1/context/dynamic` 与 clark 客户端逐字一致 |
| 查询参数 | `viewer` / `as_of`；`view=latest\|chain`；`q` / `k` / `budget` 全部对上 |
| `q` 上限 | adapter `max_length=100` = clark `P3_MAX_QUERY_CHARS`，超了 422 |
| 返回形状 | `GkEntity` / `GkVersion` / `GkSeed` / `GkDynamic` 五个模型与 clark 的 TS 定义**字段名、可空性一一对应** |
| `relations` 袋子 | `{关系名: [短码]}`，对上 clark 的 `Record<string, string[]>` |
| 三态 | 短码不存在 → **404**（clark 走 external_only）；`view` 非法 → **422**；库不可达 → **503**（clark 判为停机）。三条都实测过 |
| P0 | 真的渲出 Markdown，`viewer` / `as_of` 生效 |
| P1 / P2 | `latest` 出当前版，`chain` 出 `versions[]`（`index` / `status` / `at` / `statement` 齐全） |

clark 四层自检打到「锚点」层停下，停的原因是**没配 embedding key**（P3 返回 503，
原话是「MEMORY_EMBEDDING_API_KEY/BASE_URL/MODEL 配置不完整」）—— 那是这台机器的配置
事实，不是契约问题。网络、P0 两层 `ok=true`。

## 修掉的两处

### 一、`psycopg.connect` 没有期限 —— 库连不上时整个 adapter 会被挂死

**这是实测出来的，不是读代码读出来的。** 拿一个没人监听的地址当 `DATABASE_URL`：

- 第一次 `/healthz` 很快回了 503（连接被拒，走 `psycopg.Error` 那一支）；
- 之后再打就**再也没有回应**，进程活着、端口在听、日志一行不出。20 秒、30 秒、60 秒都不回。

原因是 libpq 默认没有连接期限。「被拒绝」和「连不上」不是同一件事：前者立刻抛
`OperationalError`，后者（地址写错、防火墙静默丢包、库过载）会一直等下去，异常永远不来。
每一次这样的请求占住一个线程池线程不还 —— 而 `/healthz` 恰恰是**按固定频率来**的，
几十次之后就没有线程可用了，对外的样子是整个 adapter 没了，而它自己一行错都没记。

`/healthz` 的注释写着「a database outage is a 503, never a 404 / 正文保持 HealthzReport
形状，好让探针说清是数据库还是配置问题」—— 意图完全正确，但在「连不上」这一档它永远
到不了那一行。

改动：`Settings` 加 `db_connect_timeout`（秒，默认 5，可用 `DB_CONNECT_TIMEOUT` 覆盖），
两处 `psycopg.connect` 都带上。`ConnectionTimeout` 是 `OperationalError` 的子类，所以
`deps.get_conn` 的 503 和 `_health_report` 的 `psycopg.Error` 原样接得住，**503 的语义
一个字没改**。

修完实测：连着打六次 `/healthz`，每次 5.1 秒返回 503，进程稳着，正文是完整的
`HealthzReport`，`warnings` 里写着「数据库不可达：connection timeout expired」。

### 二、clark 把 503 的正文扔了（clark 侧，已改）

adapter 特意在 503 里保留完整的 `HealthzReport`，而 clark 的四层自检只记了一句
`GraphKnowledge 返回 503` —— 那份写着「为什么」的正文一路丢到了地上，读的人只能去登
服务器。客户端其实早就把它接住了（`GraphKnowledgeError.detail`），丢掉它的是自检那一层。
现在每一层的失败都会连着 `serverSaid` 一起记。

## 两条留给你的（我没动，因为动了就是在编我核不动的语义）

### A. clark 读六个关系名，adapter 发得出三个

| clark 的配方读 | adapter 发 |
| --- | --- |
| `hasJudgement` | ✅ |
| `shakes` | ✅ |
| `spawns` | ✅ |
| `shakenBy` | ✅ **本次补上** |
| `researchForOf` | ❌ |
| `resolvedBy` | ❌ |

`shakenBy` 已经补上了：它是 `shakes` 的反向，而这条边索引里本来就有（建 JDG 条目时
`issue_id` 就抄下来了），缺的只是判断那一侧没往外发。不需要任何新数据、不碰语义。
实测闭环：`ISS-… → shakes → [JDG-01, JDG-02]`，反过来 `JDG-01 → shakenBy → [ISS-…]`。

剩下两个在 clark 那边是 `?? []` —— **不报错，那一段直接空掉**：`researchForOf` 空掉是整个研究块没有，
`resolvedBy` 空掉是 S03 的共识段没有。装配出来的上下文薄了一截，而屏幕上和正常跑完长得一模一样。

**补充一条实测（2026-09-01 上午）**：拿同一把尺子打了**旧版 M7**，它的 `ISS-D8` 上发的是
`{"belongsTo":["TK"],"shakes":["01-J13"],"hasJudgement":["BJ-D8"],"resolvedBy":["AGR-D8"]}`
—— 也就是说 **`resolvedBy` 在旧版上是有真数据的**（指向 `AGR-D8`）。所以它不只是「本期未
映射」，切过来是实打实的倒退。`researchForOf` 旧版也没有。

要么 memory_service 现在就没有这两种关系（那就该在 README 的「MVP 明账」里写明，clark
这边好据此决定要不要把那几段的缺席显式说出来），要么是投影漏了。这件事我判断不了。

### B. P3 的种子进不了 clark 的锚点

你上一轮记着：P3 返回 `CG-{UUID}`，而 clark 的 `autopick` 按前缀筛（A3/A4 认 `ISS-`，
A1a 认 `CARD-`，见 `lookup.ts` 的 `PREFIX`），所以锚点层稳定落在
`AnchorNotFound（正常分支：转纯外部）`。

把它单独写一条，是因为**从 clark 的产品面看，这句话的意思是「每一轮深研都走纯外部」**：
P1/P2 和三条配方（连同上面那两个关系）在真实链路上**一次都没有被走到过**。你那一轮的
台账没有覆盖到它们，不是漏测，是那条路还没通到那里。

「四层全绿」和「本体真的喂进了深研」是两件事，中间隔的就是这一步。
