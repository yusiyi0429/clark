# 本地验证主私聊记忆与 LangSmith

本分支包含 CompanyMemory MCP 退役、World Company 阅读投影、Personal 自然蒸馏、Anchor/Reference 当轮上下文和 LangSmith SDK 轨迹。先在独立开发库验证，通过后再合并和部署。云工作区的 localhost 不会自动映射到你的电脑；以下服务全部在自己的电脑启动。

## 1. 拉取分支并安装

需要 Node.js 22.13+、pnpm 11、Docker Desktop（或已有的本地 PostgreSQL 17）。Windows 推荐在 WSL2 中执行以下 shell 命令。

```bash
git clone --branch codex/main-chat-memory-langsmith https://github.com/TokenkingOS/Tianshu-MVP.git
cd Tianshu-MVP
pnpm install --frozen-lockfile
pnpm --filter @warmap/contracts build
```

已有仓库时，只需 `git fetch origin` 后切换到 `codex/main-chat-memory-langsmith` 分支。不要覆盖自己尚未提交的改动。

## 2. 准备独立开发库和环境变量

```bash
docker run -d --name tianshu-local-pg \
  -e POSTGRES_PASSWORD=local-only-change-me \
  -e POSTGRES_DB=tianshu_local \
  -p 127.0.0.1:55432:5432 \
  -v tianshu-local-pgdata:/var/lib/postgresql/data \
  postgres:17-alpine
cp .env.example apps/api/.env
```

容器已存在时用 `docker start tianshu-local-pg`；不删除或重建已有开发库。示例密码仅供本地开发，不能复用于生产。编辑 `apps/api/.env`，至少设置以下值；文件被 Git 忽略，不提交真实凭据：

```dotenv
DATABASE_URL=postgres://postgres:local-only-change-me@127.0.0.1:55432/tianshu_local
PORT=4000
PUBLIC_ORIGIN=http://localhost:3100
EXTRA_ALLOWED_ORIGINS=http://127.0.0.1:3100
SESSION_SECRET=<独立随机长字符串>
DRI_SERVICE_TOKEN=<另一独立随机长字符串>
COMPANY_PEOPLE_SEED=../../seed/company-people.example.json
MEMORY_STORAGE_DIR=../../.data/memory
MEETING_MATERIAL_STORAGE_DIR=../../.data/materials
CONVERSATION_ATTACHMENT_STORAGE_DIR=../../.data/attachments
MEETING_RECORDING_STORAGE_DIR=../../.data/recordings
PI_BASE_URL=<实际 OpenAI-compatible Responses 地址>
PI_API_KEY=<实际模型凭据>
LIGHT_MODEL=<实际模型 ID>
HEAVY_MODEL=<实际模型 ID>
COMPACTION_MODEL=<实际模型 ID>
LANGSMITH_API_KEY=<你的 LangSmith 凭据>
LANGSMITH_PROJECT=clark_oct
LANGSMITH_TRACING=true
```

三种模型槽位可以指向同一可用模型，但都需要显式填写。环境变量中的占位符必须替换。随机字符串可用 `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"` 生成。

若要验证真实公司读取，使用项目授权人提供的人员目录替换示例名单，并设置 `TKOS_WORLD_API_URL`、`TKOS_WORLD_AGENT_TOKEN`、`COMPANY_WORLD_ACCESS_FILE` 和 `COMPANY_SYSTEM_PERSON_ID`。授权文件形如 `{"person-id":["authorized-domain-id"]}`，其中 personId 必须与当前登录人及后台服务人员对应。服务 Token 本身不增加人员可见范围。未配置时，Company 明确返回不可用；不能用本地 Card 或旧 Markdown 冒充 World 事实。

出网需能访问实际模型地址、World 地址和 `https://api.smith.langchain.com`；应用保持 TLS 验证开启。云工作区未能验证 World 和 LangSmith 实际入库，因此这两项需在本地实测。

## 3. 启动 API、发放本地账号、启动 Web

终端 A，在仓库根目录：

```bash
cd apps/api
node --env-file=.env --import tsx src/server.ts
```

看到 API listening 后，在终端 B 发放示例账号：

```bash
cd apps/api
node --env-file=.env --import tsx scripts/issue-access.ts \
  person-example-001:localceo person-example-002:localmember
```

保存终端输出的初始口令，首次登录会要求修改。上述命令仅用于示例人员；使用真实授权目录时，应传对应的 personId 和登录 ID。再次执行显式指定人员的命令会重置该人的凭据。

终端 C，在仓库根目录：

```bash
pnpm --filter @warmap/web dev --hostname 127.0.0.1 --port 3100
```

打开 <http://localhost:3100/access>，用刚发放的账号和口令登录。API 启动时自动应用迁移 060–063；没有自动 down migration，因此不要拿生产库做本地验证。Web 开发服务将 `/api` 代理至本机 4000 端口，无需额外转发。

## 4. 验收

1. 主私聊连续发送两轮；在 LangSmith 项目 `clark_oct` 的 Threads / Traces 视图切换。同一 Durable conversation 的所有节点应有相同 UUID7 `thread_id`；不同轮次有不同 `logical_turn_id`。
2. 展开真实 Agent、model、tool 和 retrieve Span，核对小写名称及 metadata 白名单。`caller:web` / `caller:worker` 使用 tags；用户以 `anon_user_id` 区分。
3. 在浏览器开发者工具记录一次请求的 `logicalTurnId`。验证失败后的原样重试沿用它并生成 `#a2` 新 root；不要为了重试更改消息、引用或附件。不同输入应使用新 ID。成功请求的重复投递应返回保存的回答，不新建执行 Trace，也不重复保存用户消息。
4. 自然表达稳定个人偏好，等待后台蒸馏后打开个人记忆检查；再明确纠正或遗忘，检查后续回答与记忆变化。个人记忆与公司事实分开；另一登录人不能读取本人的 Personal。
5. 在授权 World 中已有公司事实的条件下提问，检查 Company 内容可读、没有来源哈希，Agent 不写回 World。选中可见 Card 后提问“解释这个”，确认 Anchor 与该 Card 对应，跨轮不会复用旧页面正文。
6. 检查模型返回用量与真实首 token 事件；没有返回或事件时保留缺口。Trace 按验收口径完整观测记忆正文与蒸馏内容，仅凭据（API key、token、password 等字段）不进入 Trace。关闭 `LANGSMITH_TRACING` 并重启 API，聊天仍应可用。

轨迹契约见 [ADR-0028](../../adr/0028-langsmith-thread-turn-spans.md)，记忆边界见 [ADR-0027](../../adr/0027-company-world-and-personal-memory.md)。
