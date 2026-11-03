# 工程规范

本文补充代码风格、观测、配置与验证入口。工作方式、授权范围和交付要求以根目录 [CLAUDE.md](../CLAUDE.md) 为准；产品术语见 [CONTEXT.md](../CONTEXT.md)。

## 项目结构

| 路径 | 职责 |
| --- | --- |
| `apps/web` | Next.js 页面、组件、样式、展示态与 API 客户端；不保存业务数据，不访问数据库，不调用模型 |
| `apps/api` | Fastify API：业务对象、Card 投影、Action、Pi Runtime、CompanyMemory MCP 与个人 MCP、飞书与本体集成、鉴权、调度、持久化 |
| `apps/m2` | 独立目标拆解试用：Node.js 服务、React/Vite 页面、文件存储 |
| `packages/contracts` | TypeBox schema 与 OpenAPI 生成入口；不依赖 React、Fastify 运行实例、Pi 或数据库实现 |
| `infra` | Compose、代理、备份恢复、发布脚本与本地准生产环境 |
| `seed` | 示例与受控导入文件；真实名单不提交 |
| `docs` | 指南、架构、契约、ADR 与历史方案 |
| `.scratch` | 本地事项与历史证据，不作为运行配置 |

根目录是 pnpm workspace，锁文件为 `pnpm-lock.yaml`。运行要求 Node.js 22.13+、pnpm 11、PostgreSQL 17；版本细节以各包 `package.json` 与锁文件为准。M2 是保留的独立试用边界，不把它的文件存储方式带进主应用。

## TypeScript

风格参考 [Google TypeScript Style Guide](https://google.github.io/styleguide/tsguide.html)，项目已有写法优先。只约束新增或实质修改的代码，不批量格式化旧文件。

| 项 | 规则 |
| --- | --- |
| 命名 | 类型、类、React 组件用 PascalCase，接口不加 `I` 前缀；变量与函数用 camelCase（`personId`、`loadHttpUrl`）；模块级不可变常量用 CONSTANT_CASE。外部协议字段和数据库列名保持原样 |
| 文件名 | 沿用相邻模块与框架约定，如 `personalMemory.ts`、`page.tsx`、`*.test.ts` |
| 模块 | ES `import` / `export`，业务模块优先命名导出；Next.js 页面、布局与配置可以默认导出。只作类型用的符号用 `import type` |
| 解析 | API 与 contracts 为 NodeNext / ESM，源码相对导入带 `.js` 后缀；Web 用 Bundler 解析和已有路径别名 |
| 类型 | 保持 `strict`，不为绕过错误关闭选项。外部数据先当 `unknown`，经 schema 或类型守卫校验后使用；不用 `@ts-ignore` 或双重断言绕过契约 |
| 契约 | 每份契约只有一个类型来源。契约变化先改 TypeBox schema，再 `pnpm --filter @warmap/web gen:client`；生成文件不手改 |
| 错误 | 只抛 `Error` 或其子类，转换异常时保留 `cause`。可预期的业务结果沿用状态联合或错误码协议，失败不能变成默认成功值 |
| 异步 | Promise 必须被 `await`、返回或交给已有后台机制；后台任务要有错误处理和关闭路径；模型、工具和流式读取传递已有的 `AbortSignal`，取消不能报告为成功 |
| Pi | 模型、工具和事件类型复用已安装的 Pi SDK，只调用已核实版本的 API |

## Python

`apps/m2/skill/scripts/validate_schedule.py` 是仓库里仅有的 Python。参考 [PEP 8](https://peps.python.org/pep-0008/)：函数、变量、模块用 snake_case，类型与异常用 PascalCase，四空格缩进，引号沿用所在文件。只用标准库，测试用 `python -m unittest`，不另建 pytest 或打包入口。

## LangSmith 观测

主 API 用 `langsmith` SDK，实现集中在 `apps/api/src/tracing.ts`，层级与约束写在该文件开头。M2 的本地运行记录不等于接入 LangSmith。

| 节点 | 命名与类型 |
| --- | --- |
| 根 | `turn:{logical_turn_id}#a{attempt}`，`chain` |
| Agent | `agent:{agent_role}`，`chain`，`ls_agent_type` 区分 root / subagent |
| 模型 | `model:{provider}/{model_id}`，`llm` |
| 工具 | `tool:{tool_name}`，`tool` |
| 检索 | `retrieve:{source}`，`retriever` |

- 新 Agent 角色只在 `AGENT_ROLES` 里加，新检索来源只在 `RETRIEVE_SOURCES` 里加；metadata 只用 `METADATA_KEYS` 里的键，接入方用 `client:*` tag，用户只以 `anon_user_id` 出现。
- 只有真实执行才建节点；根节点和 Agent 节点在第一个真实子步骤出现时才发送。
- token 用量和首 token 只来自模型真实返回和真实 delta 事件，缺失就保留缺口。
- 业务与记忆正文照常记录；凭据经 `redactSecrets` / `redactSecretText` 过滤。
- 只有 `LANGSMITH_TRACING=true` 且有 key 才发送；追踪失败只记 warning，不影响请求。

## 配置与凭据

- 变量示例只维护根目录 `.env.example`，说明见[环境配置](guides/environment.md)。API 新增变量时，同时改 `.env.example`、`infra/docker-compose.yml` 的 `api.environment` 和环境文档。
- 真实配置只放受限的 env 文件或运行环境；`.gitignore` 不能保护已经跟踪的凭据。Web 容器不注入服务端变量。

## 文档

- 指南放 `docs/guides/`，当前架构放 `docs/architecture/`，契约放 `docs/contracts/`，架构决策按编号放 `docs/adr/`；入口是 [docs/README.md](README.md)。
- 文档写当前事实，区分已验证、推断和待确认；“已完成”指工作范围，“已验证”指实际执行过的检查。读源码、测试替身和历史报告不能写成真实环境验收。
- 中文用短句、明确主语和统一术语；代码标识符与界面文案保持原样。

## 验证入口

| 检查 | 命令 |
| --- | --- |
| 安装 | `pnpm install --frozen-lockfile` |
| 契约构建 | `pnpm --filter @warmap/contracts build` |
| 测试 | `pnpm test`，或 `pnpm --filter @warmap/<api\|web\|contracts\|m2> test` |
| 类型检查 | `pnpm typecheck` |
| 构建 | `pnpm build` |
| 客户端生成 | `pnpm --filter @warmap/web gen:client`，随后 `git diff --exit-code -- apps/web/src/lib/api` |

API 集成测试经 `TEST_PG_URL` 建隔离测试库，不加载真实 env、不连生产库，步骤见[本地开发](guides/local-development.md#测试与构建)。`tsx` 能运行不代表类型检查通过；以命令的真实退出码为准。仓库没有独立的 lint 脚本。
