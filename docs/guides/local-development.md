# 本地开发

需要 Node.js 22.13+、pnpm 11、PostgreSQL 17。以下命令默认在仓库根目录执行；Windows 用 Git Bash 或 WSL2。

## 安装

```bash
pnpm install --frozen-lockfile
pnpm --filter @warmap/contracts build
```

## 准备开发库

```bash
docker run -d --name tianshu-local-pg \
  -e POSTGRES_PASSWORD=local-only-change-me \
  -e POSTGRES_DB=tianshu_local \
  -p 127.0.0.1:55432:5432 \
  -v tianshu-local-pgdata:/var/lib/postgresql/data \
  postgres:17-alpine
```

容器已存在时执行 `docker start tianshu-local-pg`，不要为重启删除已有卷。示例密码只用于本地。

## 准备 env

```bash
test -e apps/api/.env || cp .env.example apps/api/.env
```

至少填写下列变量，含义见[环境配置](environment.md)：

```dotenv
DATABASE_URL=postgres://postgres:local-only-change-me@127.0.0.1:55432/tianshu_local
PUBLIC_ORIGIN=http://localhost:3100
EXTRA_ALLOWED_ORIGINS=http://127.0.0.1:3100
SESSION_SECRET=<随机值>
DRI_SERVICE_TOKEN=<另一个随机值>
COMPANY_MEMORY_MCP_TOKEN=<再一个随机值>
COMPANY_MEMORY_SEED_DIR=../../seed/memory
COMPANY_PEOPLE_SEED=../../seed/company-people.example.json
PI_BASE_URL=<OpenAI-compatible Responses 地址>
PI_API_KEY=<模型凭据>
LIGHT_MODEL=<模型 id>
HEAVY_MODEL=<模型 id>
COMPACTION_MODEL=<模型 id>
```

三个模型槽位可以指向同一个模型，但都要填写。不想外呼时把 `PI_BASE_URL` 写成 `http://127.0.0.1:9/v1`。本体、飞书、博查、录音、LangSmith 不需要就留空，对应能力会如实显示未配置。

## 启动 API

终端 A：

```bash
cd apps/api
pnpm exec tsx watch --env-file=.env src/server.ts
```

API 启动时先应用 `apps/api/migrations` 里尚未执行的迁移（目前编号到 099，只向前，没有自动回滚），再启动调度与后台任务。不要指向生产数据库。

```bash
curl --fail http://127.0.0.1:4000/api/healthz
```

健康检查通过不代表模型、本体、飞书等外部服务可用。

## 发放账号

终端 B，在 `apps/api` 目录：

```bash
pnpm exec tsx --env-file=.env scripts/issue-access.ts \
  person-example-001:localceo person-example-002:localmember
```

不带参数时给人员目录里还没有凭据的人发码；带参数会重置这些人（旧会话立即失效）。初始码只显示这一次，首次登录要求改成自己的 4 位口令。

## 启动 Web

终端 C：

```bash
pnpm --filter @warmap/web dev --hostname 127.0.0.1 --port 3100
```

打开 <http://localhost:3100/access>。开发服务把 `/api`、`/mcp`、`/.well-known` 代理到 API，把 `/m2` 代理到 M2（见 [M2 试用](m2-trial.md)）。

## 本地准生产环境

需要按生产 Dockerfile、Caddy 和 HTTPS 域名验证时，用 [`infra/local`](../../infra/local/README.md)：`bash infra/local/up.sh` 起一套 `tk.local.test`，可恢复线上备份做回归，测试分层见 `infra/local/test-plan.md`。

## 测试与构建

API 集成测试会创建并删除随机名字的 `warmap_test_*` 库，管理连接取 `TEST_PG_URL`，缺省 `postgres://postgres:postgres@localhost:54329/postgres`。需要一个可建库、且不是生产的 PostgreSQL：

```bash
docker run -d --name tianshu-test-pg -e POSTGRES_PASSWORD=postgres \
  -p 127.0.0.1:54329:5432 postgres:17-alpine
```

```bash
pnpm --filter @warmap/api test
pnpm --filter @warmap/web test
pnpm --filter @warmap/contracts test
pnpm --filter @warmap/m2 test
pnpm typecheck
pnpm build
```

内存紧时 API 测试可加 `-- --maxWorkers 1`。修改契约后重新生成客户端并检查差异：

```bash
pnpm --filter @warmap/web gen:client
git diff -- apps/web/src/lib/api
```

CI（`.github/workflows/ci.yml`）依次跑 `pnpm test`、`pnpm typecheck`、`pnpm build`，再生成客户端并要求无差异。自动测试使用替身，不能代替真实模型或生产验收；真实链路见[本地验收](local-memory-langsmith.md)。
