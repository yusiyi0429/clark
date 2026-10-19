# 天枢

天枢是单公司的决策与协作工作台。CEO 处理雷达信号、议题、会议、月末复盘和月度目标。成员制定本人的任务卡、推进执行事项、写周复盘，并通过个人 MCP 让自己的 Agent 读写这些事项。

## 仓库结构

| 路径 | 内容 |
| --- | --- |
| `apps/web` | Next.js Web，只负责页面、组件、样式、展示态和 API 客户端 |
| `apps/api` | Fastify API：业务对象、Card 投影、Action、Pi Runtime、MCP、飞书与本体集成、调度和 PostgreSQL 持久化 |
| `apps/m2` | 独立的目标拆解与协作试用服务（同站点 `/m2/`） |
| `packages/contracts` | TypeBox schema 与 OpenAPI 生成入口 |
| `infra` | Compose、Caddy、宿主机 Nginx 模板、备份恢复、发布脚本（`infra/staging`）和本地准生产环境（`infra/local`） |
| `tools/collector` | 成员本机采集器（Python），向 API 上报本机清单与心跳 |
| `seed` | 人员目录示例、CompanyMemory 资料、导入文件与占位草稿；真实名单不进 Git |
| `docs` | 文档导航、指南、架构、契约、ADR 与历史方案 |

项目规则见根目录 [CLAUDE.md](CLAUDE.md)，领域术语见 [CONTEXT.md](CONTEXT.md)。

## 本地启动

需要 Node.js 22.13+、pnpm 11、PostgreSQL 17。完整步骤见[本地开发指南](docs/guides/local-development.md)。

```bash
pnpm install --frozen-lockfile
pnpm --filter @warmap/contracts build
cp .env.example apps/api/.env   # 已有 apps/api/.env 时不要覆盖
```

填好 `apps/api/.env` 的数据库、鉴权、CompanyMemory、人员目录与模型配置后，分别在两个终端启动：

```bash
cd apps/api && pnpm exec tsx watch --env-file=.env src/server.ts
pnpm --filter @warmap/web dev --hostname 127.0.0.1 --port 3100
```

打开 <http://localhost:3100/access>。API 健康端点为 <http://127.0.0.1:4000/api/healthz>。API 启动会先应用数据库迁移并启动调度，不要连接生产数据库做本地验证。

想按生产 Dockerfile 在本机跑一整套（HTTPS 域名 `tk.local.test`），用 [`infra/local`](infra/local/README.md)。

## 开发检查

```bash
pnpm test
pnpm typecheck
pnpm build
```

API 集成测试需要可建库的 PostgreSQL，通过 `TEST_PG_URL` 指定管理连接，缺省 `postgres://postgres:postgres@localhost:54329/postgres`。修改共享契约后运行 `pnpm --filter @warmap/web gen:client`，生成文件不得手改；CI 会重新生成并检查差异。

## 文档入口

- [文档导航](docs/README.md)
- [环境变量](docs/guides/environment.md)
- [当前架构](docs/architecture/README.md)
- [工程规范](docs/standards.md)
- [部署、备份与回滚](docs/guides/deployment.md)
- [本地验收：对话、记忆与 LangSmith](docs/guides/local-memory-langsmith.md)
- [个人 MCP 授权](docs/guides/mcp-oauth.md)
- [M2 试用](docs/guides/m2-trial.md)

## 数据与安全

真实凭据只放受限的 env 文件（本地 `apps/api/.env`，Compose 部署 `infra/.env`）或运行环境，不进入 Git、镜像或 Web 客户端。公司资料、个人记忆、会议录音与追踪正文按敏感数据管理。LangSmith 开启后会收到完整业务与记忆正文，凭据字段会被过滤。
