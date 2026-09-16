# Ticket 16 · 真实外部验收记录（脱敏）

- 日期：2026-09-16；worktree `16-compose-staging-real-integrations`；基线提交 `6619c39`。
- 环境：`PUBLIC_DOMAIN=localhost`；真实凭据来自 worktree `infra/.env`（mode600、gitignored，未输出、未提交）。
- 本文件只保留 provider/model 名称、状态、耗时、usage 与公开 URL；不含 key、cookie、完整 prompt/response/transcript/CompanyMemory。
- 成本上限（ticket15 `acceptance-gates.md`）：Bocha ≤3 query；模型单次 ≤32k tokens、无自动重试、不换档。实际 Bocha 调用 **2 次**。

## 运行命令

```bash
set -a; . infra/.env; set +a
cd apps/api && npx tsx scripts/real-acceptance.ts            # 1→2→3→4，失败即停
# 脚本 bug 修复后单步复跑：npx tsx scripts/real-acceptance.ts --only=transcript-outcome
```

## 结果

| 步骤 | 内容 | 状态 | 实测 |
|---|---|---|---|
| 1 | Bocha 真实 query（1 次） | ok | provider=bocha，results=19，ms=296；样例 title/URL/publishedAt 齐全，样例公开 URL `https://news.163.com/keywords/5/0/5f006e9059276a21578b/1.html` |
| 2 | light 槽位最小调用 | ok | model=`gpt-5.6-terra`，stopReason=stop，ms=1732，tokens in=12 out=5 total=17 |
| 2 | heavy 槽位最小调用 | ok | model=`gpt-5.6-sol`，stopReason=stop，ms=2144，tokens in=12 out=5 total=17 |
| 2 | compaction 槽位最小调用 | ok | model=`gpt-5.6-luna`，stopReason=stop，ms=2447，tokens in=12 out=22 total=34 |
| 3 | Pi 自主 `web_search` Tool loop（1 轮） | ok | tool started+completed（isError=false），搜索 1 次（Bocha 累计 2/3），ms=5870，tokens out=105 total=10631，assistantChars=201 |
| 4 | 合法 Transcript + Outcome 抽取（1 次 heavy） | ok | `warmap-transcript.v1` 整份校验 ok（turns=2），candidate 合 `PostMeetingCandidate`，items=2，model=`gpt-5.6-sol`，ms=7971，tokens in=720 out=454 total=1174 |

**Transcript provenance（避免误读）**：第 4 步的 transcript 是脚本内自造的 schema 合法样例（`person-example-001/002`，来自 example seed），仅过 `Value.Check` + `validateTranscript` 后直调 `createPostMeetingAgent` seam 写入临时库；**未走 multipart 导入端点，也不是项目方真实会议稿**。真实会议稿导入仍按「仍未完成」处理。

- 全部单次远低于 32k token；无自动重试、无换档。
- 第 4 步第一次执行在**发出模型请求前**因脚本未对临时库执行 migration 而失败（`relation "agent_runs" does not exist`，0 次模型调用）；修复脚本后只复跑一次成功，未对 provider 重试。

## 公众号 sidecar（停在等待扫码，AC5 未完成）

```bash
docker compose -f infra/docker-compose.yml -f infra/staging/wechat-login.override.yml up -d wechat
```

- 容器 `warmap-wechat-1`，镜像 `tmwgsicp/wechat-download-api:1.7.0@sha256:4723fcbb...`，仅绑定 `127.0.0.1:15000->5000`（临时扫码用，未公网、不经 Caddy）。
- `/api/health` → HTTP 200，status=healthy，framework=FastAPI。
- `POST /mcp` 无 Bearer → **401**；带正确 Token `initialize` → **200**（Token 与 `MCP_RESOURCE_URL` 白名单生效）。
- 数据卷 `warmap_wechat_data` 仅有新生成的 `rss.db`，无任何登录凭证 → **未扫码登录**。
- 未调用任何账号级工具（未 `list_subscriptions`/`subscribe_account`/`get_recent_articles`），未模拟订阅、未用关键词替代。
- **管理员扫码 URL（本机）：http://127.0.0.1:15000/login.html**；扫码完成后执行
  `docker compose -f infra/docker-compose.yml up -d wechat` 回到无公网端口的内网形态，再把订阅账号的 fakeid 配入 `radar_config.sources`（runbook §5）。

## 仍未完成（不勾选）

- AC5 公众号账号级文章拉取：sidecar 已登录且已订阅 `量子位/QbitAI`，但直连与 SOCKS5 代理各一次仍被微信 `ret=200013 freq control` 阻挡，`articles=0`；等频控解除后重验。
- AC8 异机加密备份与保留：缺 `BACKUP_SSH_HOST`/`BACKUP_SSH_USER`/`BACKUP_SSH_PATH`/`BACKUP_SSH_KEY_PATH` 与真实异机目标；age 加密 + checksum + 本机独立恢复演练（AC9）已完成，见下文。

## AC5 真实尝试（2026-09-16，未完成，按“失败一次即停”执行）

管理员扫码完成后，对唯一精确候选“量子位 / QbitAI”执行受限验收；每一步只调用一次，失败后停止、未重试、未换号、未用关键词。

| 步骤 | 调用 | 结果 |
|---|---|---|
| 1 | MCP `search_accounts({query:"量子位"})` ×1 | 5 个候选；唯一精确项 nickname=`量子位` alias=`QbitAI`，masked fakeid `MzIz...Mw==` |
| 2 | MCP `subscribe_account({fakeid})` ×1 | `success=true`（未订阅近似项） |
| 2 | MCP `list_subscriptions()` ×1 | 订阅数=1，目标存在；sidecar 尚未回填 nickname/alias |
| 3 | MCP `get_recent_articles({since:0,limit:1,source_id})` ×1 | **articles=0** |
| 3 | MCP `read_article` | 未调用（无文章可读，0 次） |
| 4 | Radar→Candidate→Signal 管线 | 未执行（无来源可采集） |

The sidecar DB: `subscriptions=1`、`articles=0`。

触发侧车文档化的首次订阅立即拉取（`POST /api/rss/poll` ×1，非 MCP、非关键词搜索、仅拉取已订阅账号）返回 `success=true`，
但侧车日志显示 WeChat 账号文章列表接口返回业务错：`ret=200013 err_msg='freq control'`（微信频率控制），因此未写入任何文章。

- 未做任何自动重试；未对 `get_recent_articles` 反复轮询；未改用其它账号或关键词/site 搜索。
- AC5 记为 **BLOCKED（外部微信频率控制）**，不勾选。
- 下一步：等微信频控解除后（或按 sidecar 文档配置 `PROXY_URLS` SOCKS5 代理池降低风控）再触发一次轮询，然后从第 3 步（MCP `get_recent_articles`）重新验收并进入 Radar 管线；完整 `fakeid` 不写入任何证据。
- 本步未做代码/生产语义修改；临时验收脚本已删除。

### 代理重试一次（方案 B，仍失败，未再重试）

- 本机 SOCKS5 代理接入：worktree `infra/.env` 设 `WECHAT_PROXY_URLS`（不输出值）；`.env.example` 新增可选 `WECHAT_PROXY_URLS`；compose 给 `wechat` 传 `PROXY_URLS=${WECHAT_PROXY_URLS:-}` 并加 `host.docker.internal:host-gateway`（Linux 可移植）；runbook §5 同步。
- 重建后容器内验证：`PROXY_URLS` configured；经代理访问 HTTPS 一次 → ok；`wechat_data` 卷与登录态保留。
- 临时回环 override 开放后只触发 `POST /api/rss/poll` **一次**，之后只调 `get_recent_articles(limit=1)` **一次**：`isError=false、articles=0`。
- 侧车日志仍为 `ret=200013 err_msg='freq control'`（登录态维度的频控，换出口 IP 未绕过）。按规则记录并停止，未再重试、未换号、未关键词搜索；`read_article` 0 次，Radar 管线未执行，未产生任何模型调用。
- AC5 仍 **BLOCKED**，不勾选。下一步：等微信账号频控自然解除（通常需更长时间）后再拉取；代理保持接入不影响其它功能。

## AC7 真实人员 seed 验收（2026-09-16，通过）

真实 seed 由 Master 写入 `seed/company-people.json`（ignored、mode600）；本次不使用 example。证据只保留 count/hash/角色统计/tool 事件/耗时/usage，不含姓名或完整 personId。

- 临时独立 MCP 服务：与 API 同一 `createCompanyMemoryMcpSession`/`loadCompanyMemory` repository，用真实 seed 启动，经 Streamable HTTP 由一个独立 `Client` 调用。
- 实际只读工具集：`get_passages,list_sections,search_people,search_sections`；不存在 `list_people` 工具，“读取完整人员目录”的官方方式为 `search_people`（`query` 缺省返回全部），角色筛选在客户端侧完成（仓库只按 displayName 过滤）。

| 步骤 | 结果 |
|---|---|
| 独立 MCP 客户端 `search_people({})` | count=8；roles `{ceo:1, dri:7, participant:7}`；`dri_and_participant=7`；idSetSha256=`fe3d9805...` |
| 真实 Pi runtime（当前 light 槽位，1 次 turn） | tool 事件 `search_people` started+completed（isError=false）；模型响应 2 次（工具调用 + 收尾回答，无重试）；ms=6207；tokens in=3 out=55 total=1547 |
| Pi 工具结果回算 | 记录到的唯一 personId=8；idSetSha256=`fe3d9805...`（与独立客户端完全一致） |
| 一致性判定 | `count=8, hash_match=true, roles_ok=true, consistent=true` |

- 只读验证：MCP 只暴露 4 个 `readOnlyHint` 工具、无写工具；验收后真实 seed 文件哈希与验收前一致（`seed_unchanged=true`）；未启动业务 DB、未写任何业务事实。
- 口径说明：`runtime.run()` 只调用 1 次（无重试）；一次真实 tool loop 至少需要 2 次模型响应（先工具调用、后收尾），已如实记录；未使用 example seed，也未修改 CompanyMemory/seed。
- 成本口径对齐：AC7 本次只额外用 light 槽位 1 turn（非重试、非批量、非换档），与 ticket15 `acceptance-gates.md` 的「每槽位 1 次」不同轮次、按 AC7 独立授权计；连同 AC4/AC6 的调用，全部在 ticket15 单次 ≤32k token 与无自动重试范围内。

## AC9 本机独立恢复演练（2026-09-16，通过）

方案 C：暂缓异机传输，只完成本机独立恢复演练。全程不涉及公众号调用。临时 source/target 容器、卷、网络、文件均在本次新建并在结束时销毁；未触碰任何现有卷/库/数据。

| 步骤 | 实测 |
|---|---|
| 环境 | 专用临时 `postgres:17-alpine` source + 独立空 target（各自临时卷、仅 loopback 随机端口，端口不同）；target 初始业务表=**0**；target URL != 生产 `DATABASE_URL` |
| source migrations | `AC9_MIGRATE schema=12`（现有全部 migration） |
| source fixtures（六实体 + 附加） | Issue 经真实 DRI seam 创建；Signal/Meeting/MonthlyPlan/Conversation 最小 SQL fixture；合法 Transcript 过 `validateTranscript`；MeetingOutcome 非空。counts：`issues=1 signals=1 meetings=1 transcripts=1 outcomes=1 monthly_plans=1 conversations=1 messages=1 pi_entries=0` |
| dump→加密 | `docker exec -i <source> pg_dump --format=custom --no-owner --no-privileges`（compose 内网同形）；dump 非空 21139 B；`age -r <已配置 recipient>` 产物头 `age-encryption.org/v1`；生成 sha256 checksum；**立即删除明文** |
| restore 默认 dry-run | checksum + 生产 URL 保护 + 空库检查均通过，零写入 |
| 安全边界（不破坏数据） | 目标==`DATABASE_URL` → **拒绝恢复**；恢复到非空 target → **拒绝覆盖** |
| `--execute` 真实恢复 | 恢复后 counts `issues=1 signals=1 meetings=1 transcripts=1 outcomes=1 monthly_plans=1 conversations=1 messages=1 pi_entries=0`，与 source **完全一致** |
| 继续同一对象 Conversation（target，1 次 light turn） | `messages 1→3`、`pi_entries 0→5`；SSE 事件 `message,usage,done:completed`；`run_status=succeeded`；model `gpt-5.6-terra`；usage in=690 out=5 total=695；duration=3362ms；无自动重试 |
| 清理 | 临时容器/卷/网络/临时文件已删除；剩余 `warmap_*` 卷仍为演练前四个（`warmap_caddy_config/warmap_caddy_data/warmap_pgdata/warmap_wechat_data`），未删任何现有 volume |

- 证据只含 counts/状态/usage/duration/事件类型/anchor 元数据；不含消息正文、Transcript 全文、CompanyMemory passage、姓名、完整 personId/UUID、任何 secret。
- 失败策略：任何一步失败即记录并停止，不重试；本次全过。AC8（异机传输/age 至真实异机/≥7 天保留）仍未做，保持未勾。

## 收尾：扫码端口回退（第 7 步，已执行）

```bash
docker compose -f infra/docker-compose.yml --env-file infra/.env up -d --force-recreate wechat
```

- `warmap-wechat-1` healthy，`PORTS` 仅 `5000/tcp`（无宿主发布，login override 的 `127.0.0.1:15000` 已撤）；宿主 `http://127.0.0.1:15000` 不可达。
- 未删除 `wechat_data` 卷；`.credentials.json` 不变，容器重建后 `logged_in=true`（登录态留在命名卷，验证了凭据持久化）。

## 增量内部评审（Herdr · deepseek-flash 只读）

- 命令：对 `t16-reviewer` 发增量提示，只审 `6619c39` 以来的新增（验收脚本、override 端口、runbook、证据、票据勾选）。
- 结论：Axis A green；Axis B 首轮 **red**，唯一 blocking 为 F2.2——AC6 的 Transcript 半边未标注 provenance（脚本自造样例、未经导入端点）却已勾选。
- 已修复：
  - F2.2：本文件与 ticket 显式标注 Transcript provenance；runbook §7 同步为实际口径（直调 agent seam + example personId，真实导入见 API 测试）。
  - F1.1：`webSearch.ts` 错误体按已知 key 精确抹除；验收脚本先按已知 secret（`*KEY/TOKEN/SECRET/PASSWORD/HASH`）精确 redact，再用长度启发式兜底。
  - F1.2：日志剥离控制字符，防外部内容注入终端。
  - F3.2：runbook §7 指向 `apps/api/scripts/real-acceptance.ts` 与 `--only`。
  - F4.2：`.env.example` 补 `WECHAT_LOGIN_PORT`。
- 保留（non-blocking）：F1.3（Bocha 预算为单次进程，脚本无自动重试是重点）、F1.5（验收脚本经 tsx 运行，不在 `pnpm typecheck` 的 `src` 范围）。
