# 天枢三层测试做法

三层从快到真：本地开发改完就跑，本地准生产在合入前跑，火山预发在发布前跑。上一层不过不进下一层。

## 1. 本地开发

| 项 | 内容 |
|---|---|
| 测什么 | 单个模块的行为：API 路由与状态迁移、Card 投影、契约 schema、Web 组件与展示态 |
| 怎么测 | `pnpm -r test`（API、Web 的 vitest）；契约变化后 `pnpm --filter @warmap/web gen:client`，确认生成文件无手改；`pnpm --filter @warmap/api dev` + `pnpm --filter @warmap/web dev` 在 http://localhost:3100 手点改动的页面；模型调用用 stub 或测试 key |
| 通过标准 | 相关测试全绿；新行为至少有一条能在修复前复现、修复后通过的检查；改动页面在浏览器里走通一遍，控制台无报错 |
| 不覆盖 | HTTPS、Secure Cookie、反代缓冲与超时、生产构建产物、迁移在空库/旧库上的执行 |

## 2. 本地准生产（`infra/local/`）

| 项 | 内容 |
|---|---|
| 测什么 | 和线上同一套构建与入口：生产镜像（Next standalone、API 非 root）、Nginx 终止 TLS → Caddy edge → web/api、Secure + SameSite=Strict Cookie、SSE 不缓冲、600 秒读超时、120m 上传上限、启动内联迁移、单个 API 容器里的定时任务；可选用线上备份恢复的真实数据 |
| 怎么测 | `bash infra/local/up.sh` 起环境；空库用 `access:issue` 发码，或按 README 第 4 步恢复线上备份；跑 `infra/staging/smoke.sh`（`PUBLIC_ORIGIN=https://tk.local.test`）和 `infra/caddy/verify.sh`；浏览器登录 https://tk.local.test 走下面的 Playwright 关键流程（先手工，脚本落地后自动）；对 SSE 对话看逐字出现，传一个 >1MB 的会前材料；恢复备份时核对 `schema_migrations` 最大编号等于仓库 `apps/api/migrations` |
| 通过标准 | `up.sh` 打印就绪且 `/api/healthz` 的 buildSha 等于当前提交；smoke 全部 PASS；verify.sh 全部通过；浏览器里 Cookie 带 Secure、刷新后仍登录；SSE 首字 1 秒内出现、长回答不被 60 秒默认超时切断；新迁移在恢复的线上数据上执行成功，API 正常 listen；关键流程全部走通 |
| 外呼约束 | 模型网关用测试 key 或不可达地址；本体只接测试 scope；博查、LangSmith 默认留空；不开公众号 sidecar |
| 不覆盖 | 真实公网 DNS 与 Let's Encrypt 证书、火山主机出网（模型网关/飞书/本体在大陆网络下的连通）、主机内存上限下的并发、`release.sh` 的备份与回退 |

## 3. 火山主机预发（staging）

| 项 | 内容 |
|---|---|
| 测什么 | 发布流程本身和主机环境：`release.sh prepare/switch` 的构建、备份、切换、核对与自动回退；主机出网；与现网共存时的端口、内存和 Nginx 配置 |
| 怎么测 | 在同一主机另起一套 compose：独立项目名与目录（如 `/srv/tokenhub/apps/tianshu-staging`）、edge 绑另一个回环端口（如 `127.0.0.1:3131`）、独立数据卷与 `infra/.env`；宿主机 Nginx 增加 `staging-tk.tokenkingos.com` 站点（复制 `tk.tokenkingos.com.conf`，改 server_name、证书与端口）；env 用飞书测试应用、本体测试 scope、测试模型 key；用 `TIANSHU_APP=<staging 目录> BACKUP_ROOT=<staging 备份目录> release.sh prepare` / `switch` 演练一次正常发布，再故意让核对失败演练一次自动回退；用现网最新备份按 `runbook.md` §6 恢复到 staging 空库后再切换含迁移的版本（`ALLOW_MIGRATION=1`） |
| 通过标准 | `switch` 最后一行 `release=deployed`，外网 `https://staging-tk.tokenkingos.com/api/healthz` buildSha 正确；故意失败时自动回退成功、旧版本 smoke 通过；smoke.sh 与 runbook §0.6 出网检查全部通过；含迁移的版本在现网数据副本上迁移成功；整个过程现网 `tk.tokenkingos.com` 的 healthz 与 buildSha 不变 |
| 约束 | staging 不得使用现网飞书应用、现网本体 scope 或现网数据库；演练结束停掉 staging 容器，避免与现网争内存 |

## Playwright 端到端关键流程（清单，未实现）

在本地准生产（https://tk.local.test）跑，预发复用同一套脚本只换 `baseURL`。每条流程用专门的测试账号和测试对象，跑前恢复固定数据快照。

1. **上手流程**
   - 新账号用初始码登录 → 被要求改 4 位口令 → 改完自动进入引导。
   - 走完引导各步，刷新后停在正确步骤；完成后进入首页，再次登录不再出现引导。
   - 口令连续输错到上限后提示锁定。
2. **⑨ 起草、预览、发送、提问、回答**
   - 发起起草 → SSE 逐字生成草稿，中途刷新后能恢复。
   - 预览与草稿内容一致，编辑后预览同步。
   - 发送后对方账号能看到；对方提问 → 起草人收到并回答 → 双方看到同一条问答记录。
   - 网络中断或模型失败时如实显示失败，可手动重试，不重复发送。
3. **会议分层确认**
   - 上传会前材料（含接近上限的大文件）→ 会后导入 Transcript → 生成分层结果。
   - 按层逐项确认、修改、驳回；确认状态刷新后保持，未确认项不进入下游。
   - 不同角色只能确认自己那一层。
4. **记忆小标记修改**
   - 在对象页打开记忆小标记 → 修改内容 → 保存后标记与详情一致。
   - 刷新与换设备登录后修改仍在；取消修改不落库。
5. **复盘生成和修改**
   - 触发复盘生成（月末倒数第 3 天的定时生成用固定时钟或手动入口）→ 生成完成后展示。
   - 修改复盘段落并保存；再次生成不覆盖已人工修改的内容（或按产品规则明确提示）。
   - 倒计时、提交与本人确认的状态流转正确。
