# 环境配置

每个运行环境只维护仓库根目录 `.env`。变量示例见 [`.env.example`](../../.env.example)。真实配置不得提交或进入镜像。

## 创建配置

在仓库根目录执行。已有 `.env` 时不得覆盖。

```bash
test -e .env || cp .env.example .env
chmod 600 .env
```

编辑 `.env`，填写所需配置。`SESSION_SECRET` 与 `DRI_SERVICE_TOKEN` 使用不同随机值。

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

## 加载规则

| 入口 | 加载方式 |
| --- | --- |
| API 的 `dev`、`start` 和管理脚本 | Node `--env-file-if-exists=../../.env`，工作目录为 `apps/api` |
| M2 的 `start` | 同上，工作目录为 `apps/m2` |
| Web 开发代理 | `next.config.ts` 只取 `API_SERVER_URL`、`M2_SERVER_URL`，不写入整份 `process.env` |
| Compose | 根目录执行 `docker compose --env-file .env -f infra/docker-compose.yml …` |
| 宿主机备份与 smoke | 启动 Shell 前显式导出需要的变量；备份的 Compose env 路径默认指向根目录 `.env` |
| 测试与类型检查 | 不自动加载真实 `.env` |

进程环境优先于 `.env`。Node 会去掉包围值的引号。Node 不展开 `$VARIABLE` 引用。为保持 Node、Compose 与 Shell 一致，配置值使用字面量；含空格、`#` 或 `$` 的值使用单引号。

不得使用 Shell 执行不可信的 env 文件。需要导出本机受控 `.env` 时，可以在子 Shell 中执行：

```bash
(
  set -a
  . ./.env
  set +a
  bash infra/backup/backup.sh --dry-run
)
```

这只影响子 Shell。Compose 的 `--env-file` 负责变量插值，不会把 `BACKUP_*` 自动导出给备份脚本。

若全局 Shell 设置了 LangSmith 变量，先清除冲突再启动 API：

```bash
env -u LANGSMITH_TRACING -u LANGSMITH_PROJECT pnpm --filter @warmap/api dev
```

## 路径与端口

配置文件位置不改变进程工作目录。API 与 M2 的相对文件路径从各自包目录解析。因此，本地根目录 `.env` 中的 `../../seed/...` 与 `../../.data/...` 指向仓库目录。

Compose 使用容器内路径。API 人员目录固定为 `/repo/seed/company-people.json`。World 授权文件必须位于实际只读挂载内，例如 `/repo/seed/company-world-access.json`。本地的 `../../.data/...` 不能原样交给容器。

| 服务 | 本地默认值 | 配置方式 |
| --- | --- | --- |
| API | 4000 | `PORT` |
| Web | 本指南使用 3100 | `next dev --port 3100` |
| M2 | 4333 | `M2_PORT`；未设置时沿用 `PORT`，最后默认 4333 |
| edge | 宿主机回环 3130 | Compose ports |

同时运行 API 与 M2 时，必须设置 `M2_PORT=4333`，避免使用 API 的 `PORT`。

## 配置分组

| 分组 | 必要值与缺失行为 |
| --- | --- |
| API 基础 | `DATABASE_URL`、`PUBLIC_ORIGIN`、`SESSION_SECRET`、`DRI_SERVICE_TOKEN`、`COMPANY_PEOPLE_SEED` |
| API 模型 | `PI_BASE_URL`、`PI_API_KEY`、`LIGHT_MODEL`、`HEAVY_MODEL`、`COMPACTION_MODEL`；三个槽位显式配置 |
| 公司事实 | `TKOS_WORLD_API_URL`、`TKOS_WORLD_AGENT_TOKEN`、`COMPANY_WORLD_ACCESS_FILE`；后台读取还需 `COMPANY_SYSTEM_PERSON_ID` |
| 存储 | `MEMORY_STORAGE_DIR`、材料、附件和录音目录；容器使用持久卷 |
| 雷达 | `BOCHA_API_KEY` 与 `WECHAT_MCP_*`；缺失时对应来源不可用 |
| 录音 | TOS 五项、火山 ASR 凭据；声纹另需腾讯云凭据和 `ffmpeg` |
| 追踪 | `LANGSMITH_API_KEY`、`LANGSMITH_PROJECT`、`LANGSMITH_TRACING`；无 key 或 false 时不上传 |
| Compose | `POSTGRES_PASSWORD`、`PUBLIC_DOMAIN` 与 API 必需值；服务按声明逐项接收 |
| 备份 | `BACKUP_*`；`BACKUP_TARGET=local` 只保留本机副本，不是异机备份 |
| M2 | 私有 seed、账号映射、内部令牌与模型配置；见 [M2 指南](m2-trial.md) |

公司时区固定为 `Asia/Shanghai`。`COMPANY_TIMEZONE` 不是运行时配置，不再列入示例。

`healthz.dependencies.companyConfigured` 只检查配置是否具备，不访问 World 验证授权。`/mcp/company-memory` 已停用。个人 `/mcp/me` 使用独立授权。

## M2 配置差异

本地 M2 直接使用 `DECODING_API_BASE`、`DECODING_API_KEY`、`DECODING_MODEL`、`TKOS_WORLD_PRODUCT_TOKEN`。

现有 Compose override 保留部署接口：`M2_MODEL_BASE`、`M2_MODEL_KEY`、`M2_MODEL`、`M2_WORLD_READ_TOKEN`。它把这些值映射为容器运行变量。启用 M2 时只填写所用运行方式的模型配置，不把主 API 的 key 自动复制过去。

`M2_SEED_DIR` 在 Compose 中必须使用宿主机绝对路径。账号映射和来源清单由私有目录提供。可选状态目录、技能目录与并发配置列在 `.env.example`。

开发专用开关 `DECODING_USE_CODEX_BRIDGE`、`DECODING_CODEX_BIN`、`DECODING_PYTHON`、`DECODING_LAN_HOST` 不属于生产默认配置。旧模型密钥入口 `TOKENHUB_API_KEY`、`ARK_API_KEY` 和禁用开关仍由源码支持，正式部署优先使用显式 `DECODING_API_KEY`。

## 从旧路径迁移

1. 核对根目录与旧目录是否同时存在配置。
2. 比较键名并处理冲突，不输出密钥。
3. 保留原有值及相对路径语义。
4. 将配置移到根目录并设为 `600`。
5. 检查启动、脚本和 Compose 配置。
6. 验证通过后删除旧副本。

旧入口包括 `apps/api/.env`、`infra/.env`、`apps/web/.env.local` 和单独备份 env。每台主机独立迁移。本地整理不会自动修改服务器配置或 cron。

容器构建继续忽略所有真实 env。不得使用 `env_file: ../.env` 将整份配置注入 Web，也不得通过 `NEXT_PUBLIC_*` 发布服务端凭据。
