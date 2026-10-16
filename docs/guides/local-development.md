# 本地开发

需要 Node.js 22.13+、pnpm 11，以及 PostgreSQL 17。以下命令从仓库根目录执行。Windows 使用 WSL2 执行 Shell 和 Docker 步骤。

## 安装

```bash
pnpm install --frozen-lockfile
pnpm --filter @warmap/contracts build
```

## 准备独立数据库

```bash
docker run -d --name tianshu-local-pg \
  -e POSTGRES_PASSWORD=local-only-change-me \
  -e POSTGRES_DB=tianshu_local \
  -p 127.0.0.1:55432:5432 \
  -v tianshu-local-pgdata:/var/lib/postgresql/data \
  postgres:17-alpine
```

容器已存在时，执行 `docker start tianshu-local-pg`。不得为重复启动删除现有卷。示例密码只供本地开发。

按[环境指南](environment.md)创建根目录 `.env`。至少填写基础鉴权、人员目录和三个模型槽位。示例中的数据库地址与上述容器匹配。

API 启动会应用全部未执行迁移，并启动调度。不得指向生产数据库。模型、搜索和 World 使用真实配置时会产生外部请求。

## 启动 API

终端 A：

```bash
pnpm --filter @warmap/api dev
```

若 Shell 中有全局 LangSmith 配置，使用环境指南中的 `env -u` 命令。检查基础就绪状态：

```bash
curl --fail http://127.0.0.1:4000/api/healthz
```

健康检查通过不代表全部外部服务可用。

## 发放账号

终端 B，仅对示例人员执行：

```bash
pnpm --filter @warmap/api access:issue \
  person-example-001:localceo person-example-002:localmember
```

保存终端显示的初始码。首次登录会要求修改口令。使用真实名单时，传入对应稳定 `personId` 与登录 ID。

不得无意重复执行发码命令。显式发放已有人员会重置凭据，并使旧会话失效。

## 启动 Web

终端 C：

```bash
pnpm --filter @warmap/web dev --hostname 127.0.0.1 --port 3100
```

打开 <http://localhost:3100/access>。Web 将 `/api`、`/mcp` 与授权发现路径代理到 API。M2 代理使用独立端口。

可选 M2 需要私有试用数据和账号映射。准备方法见 [M2 指南](m2-trial.md)，不得用演示名单替代正式绑定。

## 测试与构建

单元测试使用替身。API 集成测试创建并删除随机 `warmap_test_` 数据库。测试用管理账号必须有建库权限，且不得指向生产实例。

```bash
TEST_PG_URL=postgres://postgres:local-only-change-me@127.0.0.1:55432/postgres \
  pnpm --filter @warmap/api test
pnpm --filter @warmap/web test
pnpm --filter @warmap/contracts test
pnpm --filter @warmap/m2 test
pnpm typecheck
pnpm build
```

修改契约后，重新生成客户端：

```bash
pnpm --filter @warmap/web gen:client
git diff -- apps/web/src/lib/api
```

默认测试管理库为 `localhost:54329/postgres`。使用其他端口时显式设置 `TEST_PG_URL`。常规测试不加载根目录 `.env`。

真实记忆和追踪检查见[本地记忆验收](local-memory-langsmith.md)。不得把本页的自动测试结果当作真实模型或生产验收。
