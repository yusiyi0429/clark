# 天枢

天枢是单公司的决策与协作工作台。CEO 处理雷达信号、议题、会议和月度目标。成员准备任务卡、推进执行事项，并使用本人 Agent。

## 仓库结构

| 路径 | 内容 |
| --- | --- |
| `apps/web` | Next.js Web，只负责展示与交互 |
| `apps/api` | Fastify API、PostgreSQL 业务数据与 Pi Runtime |
| `apps/m2` | 独立目标拆解与协作试用 |
| `packages/contracts` | TypeBox schema 与 OpenAPI 生成 |
| `infra` | Compose、代理、备份与部署检查 |
| `docs` | 需求、架构、工程规范、指南和 ADR |

## 本地启动

需要 Node.js 22.13+、pnpm 11、PostgreSQL 17。首次开发按[本地开发指南](docs/guides/local-development.md)准备独立数据库和登录账号。

```bash
pnpm install --frozen-lockfile
pnpm --filter @warmap/contracts build
test -e .env || cp .env.example .env
chmod 600 .env
```

填写根目录 `.env` 中的数据库、鉴权、人员目录与模型配置。不得覆盖已有配置。分别在两个终端启动：

```bash
pnpm --filter @warmap/api dev
pnpm --filter @warmap/web dev --hostname 127.0.0.1 --port 3100
```

打开 <http://localhost:3100/access>。API 健康端点为 <http://127.0.0.1:4000/api/healthz>。

API 启动会应用数据库迁移并启动调度。不得连接生产数据库做本地验证。环境优先级、路径语义和 M2 配置见[环境指南](docs/guides/environment.md)。

## 开发检查

```bash
pnpm test
pnpm typecheck
pnpm build
```

API 集成测试需要隔离 PostgreSQL。管理连接使用 `TEST_PG_URL`，具体命令见[测试步骤](docs/guides/local-development.md#测试与构建)。测试不加载真实 `.env`。

修改共享契约后，运行 `pnpm --filter @warmap/web gen:client`。不得手改生成文件。

## 文档入口

- [完整文档导航](docs/README.md)
- [需求、术语与已知限制](docs/context.md)
- [当前架构](docs/architecture/README.md)
- [工程规范](docs/standards.md)
- [部署、备份与回滚](docs/guides/deployment.md)
- [主私聊、记忆与 LangSmith 验收](docs/guides/local-memory-langsmith.md)
- [M2 试用](docs/guides/m2-trial.md)

## 数据与安全

真实凭据只放受限 `.env` 或运行环境，不进入 Git、镜像或 Web 客户端。公司资料、个人记忆和追踪正文按敏感数据管理。

LangSmith 可接收完整业务与记忆正文，但不得接收凭据。个人蒸馏仍有已知证据校验失败问题。现有备份脚本不覆盖全部独立卷；部署前必须核对恢复范围。详细限制见[领域上下文](docs/context.md#已知限制与待验证项)。
