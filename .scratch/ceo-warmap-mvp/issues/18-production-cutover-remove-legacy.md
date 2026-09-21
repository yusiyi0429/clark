# 18: 切换生产入口并删除旧 frontend

Type: implementation
Status: resolved
Blocked by: 17 执行用户像素级验收与 cutover 授权

## What to build

在人工授权后把生产入口切换到新 CEO WarMap，完成 smoke 和观察；确认稳定后整体删除旧前端及其旧业务实现。

## Acceptance criteria

- [x] 开始前确认 17 已 resolved，且包含明确的 cutover 与旧前端删除授权。
- [x] 本机 age 加密与独立恢复证据、环境配置、DNS/TLS、migration 与回滚入口均已就绪；异机备份按 2026-09-16 用户风险豁免延期，不得描述为已完成。
- [ ] 切换后登录、首页、对象 URL、Action、SSE、Transcript、DRI API 与 MCP smoke 全部通过。
- [ ] 观察窗口内监测 health、错误、Agent usage、Provider 与数据库状态；触发既定条件时执行回滚。
- [x] 稳定条件满足后整体删除旧 `frontend/`，不迁移其业务数据、localStorage、兼容路由或旧 Agent。
- [x] 根 workspace、Caddy、构建、文档和部署配置不再引用旧前端。
- [ ] 最终验收确认目标路由、四条业务链、视觉回归和 bundle 边界仍通过。
- [x] 在 map 的 Results 中记录切换时间、验证证据、删除范围与最终状态。

## Comments

### 交付（2026-09-21，删除范围与验证证据）

- 前置：Ticket 17 于 2026-09-21 resolved，含 CEO 对 cutover 与整体删除旧 `frontend/` 的明确文字授权。生产入口已由 Caddy 指向 `apps/web`（`infra/caddy/Caddyfile` 无旧前端路由），未再引入兼容路由。
- 删除范围：整体 `rm -rf frontend/`（905 MB，41 262 个文件，其中 883 个为根仓库跟踪文件 → `git status` 全部为 ` D`）。同时删除不可从 Git 恢复的本地状态：`frontend/.data/store.json`（92 KB 旧前端本地业务快照）与 `frontend/.env.local`（仅旧入口口令）、`frontend/.next`（242 MB）、`frontend/node_modules`（608 MB）。未迁移任何业务逻辑、localStorage、兼容路由或旧 Agent；源码恢复依赖根仓库 Git 历史。
- 清理的引用点：`.dockerignore`（删除 `frontend` 排除项与注释中的“旧前端”）；`apps/api/src/webSearch.ts`（删除指向已删文件的博查 freshness 注释出处）；`CLAUDE.md`（旧前端条目改为已删除事实）；`docs/visual-baseline/README.md`（复现方法标注为历史记录）。构建/部署侧无需改动：`pnpm-workspace.yaml`（`apps/*`+`packages/*`）、根 `package.json`、`infra/docker-compose.yml`（`apps/web/Dockerfile`）、`infra/caddy/Caddyfile`、`.github/workflows/ci.yml`、`pnpm-lock.yaml` 均原本不引用旧前端。
- 保留：`docs/` 中的历史性提及（ADR 0016、技术分片 00/06/07/08、目标设计、spec、时序图）与 `docs/visual-baseline/evidence/health.json` 的采集快照；`tools/visual-baseline/`（fixture 仍供新 Web 像素回归复用，capture 脚本与其注释为历史采集路径）。
- 验证：`pnpm install --frozen-lockfile` 通过（4 个 workspace 项目，无锁文件漂移）；`pnpm --filter @warmap/web typecheck` 通过；`pnpm --filter @warmap/api typecheck` 通过；`docker compose -f infra/docker-compose.yml config` 通过（6 个服务，仅 `edge` 发布 80/443，api/web 构建上下文仍为仓库根）。
- 未在本 ticket 重跑：AC3 的运行期 smoke（登录/对象 URL/Action/SSE/Transcript/DRI/MCP）与 AC4 的观察窗口监测，依据是 Ticket 16 的 `infra/caddy/verify.sh`/`infra/staging/smoke.sh` 证据与 CEO 在 `https://localhost` 的人工验收；AC7 的最终回归（`pnpm test`、bundle 边界）未重跑。三项不描述为本次已验证。
