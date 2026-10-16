# 工程规范

本文件维护代码风格、观测规则与构建约定。授权、测试流程和提交规则见 [AGENTS.md](../AGENTS.md)。产品术语见 [context.md](context.md)。

## 项目结构

| 路径 | 职责 |
| --- | --- |
| `apps/web` | Next.js 页面、组件、样式、展示态与 API 客户端 |
| `apps/api` | Fastify API、业务对象、鉴权、Pi Runtime、调度、持久化与外部集成 |
| `apps/m2` | 独立目标拆解试用；Node.js 服务、React/Vite 页面与文件存储 |
| `packages/contracts` | TypeBox schema 与 OpenAPI 生成入口 |
| `infra` | Compose、代理、备份与部署检查脚本 |
| `seed` | 示例数据结构与受限部署文件入口；真实资料不提交 |
| `docs` | 需求、架构、契约、指南和 ADR |
| `.scratch` | 本地事项与历史证据，不作为正式运行配置 |

根目录使用 pnpm workspace，依赖锁文件为 `pnpm-lock.yaml`。运行要求为 Node.js 22.13+、pnpm 11。API 使用 PostgreSQL 17。版本细节以各包 `package.json` 和锁文件为准。

主 Web 不保存业务事实，不访问数据库，不调用模型。API 返回 Card 投影与允许动作。contracts 不依赖 React、Fastify 运行实例、Pi 或数据库实现。M2 是明确保留的独立试用边界，不把它的文件存储模式复制到主应用。

## TypeScript 规范

参考 [Google TypeScript Style Guide](https://google.github.io/styleguide/tsguide.html)。适用范围为 API、Web 和 contracts 的 `.ts` / `.tsx`。本节不约束上游 Pi 源码。

项目适配规则优先于风格参考。框架用法以对应 API 契约为准。只约束新增或实质修改的代码，不批量格式化旧文件。

### 命名、模块与语法

参考 Google 的[命名规则](https://google.github.io/styleguide/tsguide.html#naming)、[模块规则](https://google.github.io/styleguide/tsguide.html#modules)和[语言特性规则](https://google.github.io/styleguide/tsguide.html#language-features)。

| 项 | 规则 |
| --- | --- |
| 类型与组件 | 类、接口、类型别名、枚举、React 组件使用 PascalCase。接口不加 `I` 前缀。schema 派生类型沿用所在包命名 |
| 变量与函数 | 使用 camelCase。缩写按单词处理，如 `personId`、`loadHttpUrl`。外部协议字段与数据库列名保持原契约 |
| 常量 | 模块级不可变常量使用 CONSTANT_CASE。局部 `const` 仍使用 camelCase |
| 声明与比较 | 默认 `const`，需要赋值时使用 `let`。使用 `===` / `!==`。明确区分缺失与 `0`、`false`、空字符串 |
| 模块与导出 | 使用 ES `import` / `export`。优先命名导出，只导出调用方需要的符号。不建立静态容器类或 TypeScript `namespace` |
| 类型导入 | 仅作类型使用的符号使用 `import type` 或内联 `type`。重导出类型使用 `export type` |
| 对象与集合 | 使用对象和数组字面量。简单数组写 `T[]`，复杂联合元素可以写 `Array<T>` |

### 类型与错误边界

参考 Google 的[类型系统](https://google.github.io/styleguide/tsguide.html#type-system)、[类型断言](https://google.github.io/styleguide/tsguide.html#type-and-non-nullability-assertions)和[异常处理](https://google.github.io/styleguide/tsguide.html#exceptions)。

- 保持现有 `strict` 检查。不得为绕过错误关闭编译器选项。
- 局部变量、字面量和回调优先使用推断。公开函数明确参数和返回类型。公开返回类型要求是项目约定。
- 外部未知数据使用 `unknown`，经 schema 或类型守卫校验后使用。
- `any` 只限已核实的第三方动态边界，不向业务代码传播。不得用 `@ts-ignore` 或双重断言绕过契约错误。
- 优先使用控制流收窄。`as T` 和 `!` 不执行运行时校验，只在局部不变量能证明安全时使用。
- 对象字面量使用类型标注或 `satisfies`。不得用断言伪造合规数据。
- Google 倾向使用 `interface` 描述对象，使用 `type` 描述联合。本项目保留模块已有写法，不为风格互换。
- 每份契约保留一个类型来源。不得新增空接口或重复 DTO。
- 保留 API 的 `null` / `undefined` 语义。可选属性使用 `?`，可空属性声明联合类型。
- 不应修改的集合或属性使用 `readonly`。它不等于运行时深冻结。
- 自有代码只抛出 `Error` 或其子类。捕获后先收窄类型。转换异常保留 `cause`。
- 可预期业务结果沿用状态联合或错误协议。失败不得转换为默认成功值。

### 项目适配与异步执行

- 文件名沿用相邻模块和框架约定，如 `personalMemory.ts`、`page.tsx`、`*.test.ts`。不套用 Google 的 snake_case 文件名要求。
- Next.js 页面、布局和框架配置允许默认导出。业务模块优先命名导出。
- 缩进、引号和换行沿用目标文件。语句保留分号。不因此新增格式化工具。
- 注释与 JSDoc 的新增限制见 `AGENTS.md`。
- API 与 contracts 使用 NodeNext / ESM。源码相对导入保留 `.js` 后缀。Web 使用 Bundler 解析与现有路径别名。
- Promise 必须由 `await`、返回值或既有后台机制接管。`void promise` 不等于处理失败。
- 后台任务必须有错误处理与关闭路径。不得在模块导入时发起业务请求。
- 流式读取、模型调用与工具调用传递既有 `AbortSignal`。取消不能报告为成功。
- 超时与重试遵守对应业务规则。连接、订阅和会话在 `finally` 或已有生命周期钩子释放。
- Pi 模型、工具和事件类型复用已安装 SDK。只调用已核实版本的 API。
- 契约变化先修改 TypeBox schema，再生成 Web 客户端。生成文件不得手工修改。

M2 的 `.mjs` 使用现有 ES 模块与 Node 测试方式。不得为了统一语言迁移整个试用应用。本仓库没有 Python 主服务、`pyproject.toml` 或 Python 包构建入口。

## Python 脚本

M2 技能中的 `scripts/validate_schedule.py` 是校验脚本，不是独立服务。修改 Python 时参考 [PEP 8](https://peps.python.org/pep-0008/) 与 [Google Python 风格指南](https://google.github.io/styleguide/pyguide.html)。

- 类型与异常使用 PascalCase，异常名以 `Error` 结尾。
- 函数、变量、模块使用 snake_case，模块常量使用 CONSTANT_CASE。
- 使用四空格缩进。引号沿用所在文件，不批量格式化。
- 导入按标准库、第三方、本项目分组。不修改 `sys.path` 绕过包结构。
- 实质修改的函数明确参数与返回类型。外部数据仍须运行时校验。
- 沿用现有数据结构。只有明确字段职责时使用 `dataclass` 或 `TypedDict`。
- 默认参数不使用可变对象。缺失值使用 `None` 或 `default_factory`。
- 函数保持单一职责。可选参数按接口需要使用 keyword-only。
- 捕获能处理的具体异常。转换异常使用 `raise ... from exc` 保留原因。
- 文件与子进程通过上下文管理器或 `finally` 释放。取消与超时不得报告为成功。
- 模块导入不启动业务请求。脚本入口、Python 版本与验证方式沿用调用方，不虚构 pytest 或打包命令。
- 注释和 docstring 的新增限制遵守 `AGENTS.md`。

## LangSmith 观测

主 API 已声明 `langsmith` SDK。实际接入见 `apps/api/src/langsmith.ts` 与 [ADR-0028](adr/0028-langsmith-thread-turn-spans.md)。M2 的本地模型运行记录不等于 LangSmith 接入。

### 层级与命名

| 对象 | 规则 |
| --- | --- |
| Thread | `thread_id` 为稳定 UUID7，由业务会话分配，所有子 Run 继承 |
| Turn | `logical_turn_id` 标识一轮逻辑输入 |
| 根 Run | `turn:{logical_turn_id}#a{attempt}`，类型为 `chain` |
| Agent | `agent:{agent_role}`，类型为 `chain`，以 `ls_agent_type` 区分 root/subagent |
| 模型 | `model:{provider}/{model_id}`，类型为 `llm` |
| 工具 | `tool:{tool_name}`，类型为 `tool` |
| 检索 | `retrieve:{source}`，类型为 `retriever` |

前缀与自定义角色名使用小写。外部模型 ID、工具注册名和业务 ID 保留原值。只有真实执行才创建节点，不虚构 graph 节点或跨轮根 Run。

手工 metadata 白名单统一在 ADR-0028 维护。接入方使用 `caller:web` / `caller:worker` tags。身份与 scope 来自认证上下文，不信任调用方自报。

原样重试失败轮次沿用 Turn ID，并增加 attempt。修改输入时使用新 Turn ID。成功请求的重复投递返回保存结果，不重新建立执行 Trace。

### 内容与指标

- 记录获准处理的完整业务输入与输出，包括 Company/Personal 正文和个人蒸馏内容。
- 过滤 API key、token、password 与传输凭据。不得把“完整业务观测”解释为允许上传凭据。
- token 用量使用 Provider 实际返回值。缺失时保留缺口，不估算或填零。
- 首 token 时延依据真实流式事件。最终消息和本地回放不能补作首 token。
- 起止时间来自实际调用边界。不伪造父节点聚合指标。
- 缺少 key 或关闭追踪时不上传。上传失败与业务结果分开处理。
- 追踪不是业务恢复源。不承诺崩溃后的离线补传。

## 配置、凭据与文档

真实配置只保存在根目录 `.env` 或运行环境。配置语义见[环境指南](guides/environment.md)。`.env.example` 只包含占位值。POSIX 上 `.env` 权限为 `600`。

不得将根目录 `.env` 打包到镜像，不得整份注入 Web。`.gitignore` 不能保护已跟踪凭据。业务资料、追踪与导出文件按其敏感性管理。

正式文档使用小写英文连字符命名。`README.md`、`AGENTS.md`、`SKILL.md` 保留工具约定名称。ADR 保留编号。历史图表保留原文件名，避免破坏历史证据定位。

中文写法参考 [ste-zh](https://github.com/dualface/ste-zh)。正文采用 `context.md` 的术语。一句表达一个动作或事实。使用具体动词、短句与明确主语。代码标识符和界面文案保持原样。

“已完成”描述工作范围，“已验证”描述实际检查。不得把读取源码、测试替身或历史报告写成真实环境验收。

## 验证入口

| 检查 | 命令 |
| --- | --- |
| 安装 | `pnpm install --frozen-lockfile` |
| 契约构建 | `pnpm --filter @warmap/contracts build` |
| 包测试 | `pnpm --filter @warmap/api test`、`pnpm --filter @warmap/web test`、`pnpm --filter @warmap/contracts test`、`pnpm --filter @warmap/m2 test` |
| 类型检查 | `pnpm typecheck`；可以按受影响包过滤 |
| 构建 | `pnpm build`；可以按受影响包过滤 |
| 客户端生成 | `pnpm --filter @warmap/web gen:client` |
| CI 同等入口 | `pnpm test`、`pnpm typecheck`、`pnpm build`，再生成客户端并核对差异 |

API 集成测试通过 `TEST_PG_URL` 连接管理库，创建隔离测试库。测试不得加载真实 `.env` 或连接生产库。具体步骤见[本地开发](guides/local-development.md)。

`tsx` 能运行不代表类型检查通过。核对命令真实退出码，不以 `head` / `tail` 的退出码代替检查结果。当前没有独立 lint 脚本。

原型放 `/tmp` 或经确认的独立目录。不得把原型数据或另一工作区的路径混入正式运行入口。
