# Company / Personal 存储、治理与更新设计

Status: ready-for-agent（Company 的实时接口适配依赖联调）
依赖：[上下文开发规格](context-contract.md)。本文描述后续实现，不是已部署状态。

## 1. 模块接口

```ts
interface CompanyMemory {
  index(viewer: Viewer, signal: AbortSignal): Promise<MemoryIndex>;
  search(viewer: Viewer, query: string, signal: AbortSignal): Promise<ReadableSection[]>;
  read(viewer: Viewer, sectionHandle: string, signal: AbortSignal): Promise<ReadableSection>;
  refresh(viewerScope: AuthorizedWorldScope, signal: AbortSignal): Promise<void>;
}
interface PersonalMemory {
  readOwn(personId: string): Promise<PersonalDocument>;
  searchOwn(personId: string, query: string): Promise<ReadableSection[]>;
  distill(job: PersonalDistillationJob): Promise<void>;
  replaceOwn(personId: string, expectedRevision: number, markdown: string): Promise<void>;
  forgetOwn(personId: string, expectedRevision: number, sectionIds: string[]): Promise<void>;
}
```

主模型只拿有界只读接口；后台治理代码持有更新方法。外部用户不可传另一个 personId、World domain 或文件路径来选择记忆。viewer 与授权范围取自服务端登录及现有对象权限。

## 2. Company.md 的含义

Company 是模块，可以按访问范围保存阅读投影。每个有效的授权范围只有一代 current 内容，不允许用户维护自己的公司事实版本。

```text
MEMORY_STORAGE_DIR/
  company/<world-instance-key>/<access-scope-key>/
    generations/<generation-id>/Company.md
    generations/<generation-id>/state.json
    current.json
  personal/<server-assigned-directory-id>/
    Personal.md
```

这是部署示意；内部 key、generation、版本和对象对应关系不发送给模型。单实例 API 使用独立持久卷，进程以非 root 运行，目录 0700、文件 0600。Personal 的目录 ID 由服务端登记，不把用户输入的路径片段直接拼接到磁盘。

同样访问范围共用 Company 投影。若成员只能读取公司事实子集，不能从 CEO 全量 Company 做摘要后直接发给成员。撤权或可见集合变化先失效对应投影/缓存，再重新生成授权范围内的内容。首版不建立跨用户授权推断系统；无法确定允许范围时不提供该范围的 Company。

Company.md 只含可读内容，例如：

```markdown
# Company

## 公司方向
……World 中有依据的方向与业务关系……

## 业务结构与组织责任
……谁负责什么，哪些领域协作……

## 本期重点与约束
……保留周期与状态，不把目标改述为已发生结果……
```

这些是章节样式，不是待写入的虚构事实。旧 CompanyMemory.md 仅供章节组织参考，不复制其真实内容来填补 World 空缺。

## 3. World 读取适配

新增 `worldReader.ts`（或在现有模块中提供受限只读 facade），只开放 list/get；主 Runtime 不持有 `WorldClient.write`。既有产品流程的 WorldClient 写入继续独立存在。

返回类型补齐经验证的 `business.blocks/relations`、`identity`、`records`，先做响应校验。`getHead` 仅适合版本/关联检查，不作为 Company 正文读取。

正文适配按字段白名单完成：

- 业务标题、正文块、组件内容、业务日期、状态与结果。
- 从 identity 中解析负责人显示名；关系引用在权限内解析为人能理解的对象名与关系。
- World 的 value.text/components 与便捷 text/components 可能重复，优先使用一种表示并去重，不丢掉只有便捷字段提供的正文。
- protocol、component_ledger、修订哈希、幂等记录、外部引用元数据等留在后端。
- draft 是“存在这样一份草稿”的事实，不能表述为已确认或已完成；withdrawn/superseded 等状态同样有业务意义，不做无条件过滤或状态抹除。
- 不按任意 URL 抓取 artifacts，也不把外链标题当作已读正文；用户询问资料时仍可返回有意义的业务链接。
- 关系对象不可读时不泄露其标题；未知关系不猜测负责人、依赖或归属。

当前代码仅有公司/E&O 实例映射和三个特定 Mission 外部关联，无法据此假设全公司对象都已对应。联调需确认实际可读类型、全公司覆盖、授权语义、分页、关系与状态形状。没有证据时不添加假想的 World search/change-feed/webhook。

## 4. 治理与新鲜度

流程：授权范围头列表 → 正文/关系读取 → 规范化事实片段 → 章节整理 → 业务语义核对 → 发布新阅读投影。

初次从完整授权范围生成；后续先核对范围内对象头与依赖版本，复用未变化内容，重读变更对象。若列表未完整读完或任一必需详情读取失败，不能把“没读到”当作删除，不能发布缺项的新 Company。

不假设远端提供事务快照：发布前复查本次依赖头；有变化则放弃该候选并有界重读一次，仍变化则该轮不发布。此检查只能说明读取窗口内已核对依赖，不能声称全局强一致或永远最新。

公司事实相关 Query 在消费前核对所需事实的当前可用性和依赖版本；纯个人问题与纯加工现有文本无需每轮全公司扫描。World 不能提供可靠更新检测时，首版重读所需对象；不得用任意 TTL 冒充一致性保证。可控短缓存是后续优化，必须清楚说明其有界过期语义。

整理模型使用独立后台运行、场景 Prompt 与结构化结果，只读规范化 World 内容，无工具写权。可用内部短句柄将输出映射回支持片段；不发送协议哈希，不在最终 Company 或主 Agent 视图保留这些支持标记。

模型允许合并同义内容、整理时间与解释有依据的关系；不得引入新数字、期限、负责人或经营结论。输出格式/支持片段引用可确定性校验，但“支持引用存在”不能证明每句语义正确，仍需代表性人工样本与语义评测。核对不过不发布，也不以旧内容冒充当前事实。

发布采用不可变 generation 目录：先写完整 Company.md 与 state.json，最后原子替换 current 指针。单独替换两份文件不能保证正文与状态一致。单实例进程内串行生成；部署多实例前另行设计跨进程协调，不在本轮提前引入。

正文只保存稳定认知与本期必要摘要，详细实时状态从 World 按需读。不存在主 Agent 改写 Company 后再同步 World 的反向链路。

## 5. Personal.md 内容与更新

```markdown
# Personal

## 沟通与表达
- 通常希望先看到结论，再看依据。

## 工作方式
- ……多轮明确表达的习惯……

## 持续关注与个人约束
- ……本人提供、对后续协作持续有用的情况……

## 暂时性的理解
- ……谨慎归纳，用“通常／可能”，避免固定人格标签……
```

样例不自动写入任何用户文件。个人正在负责哪个公司目标归 Company/World；本人在该工作中的偏好、困扰和约束可以归 Personal。用户的假设、转述、角色扮演及助手建议不能当作本人事实。

蒸馏输入是本人本轮原话和必要的本人前文、现有 Personal 条目；助手回答只帮助理解对话，不作为个人事实证据。Anchor、Company 和工具结果不能冒充本人表达。普通主私聊跨 scope 可以蒸馏；群消息、批注、M2 和他人私聊均不进入该任务。

用户无需说“记住”。后台返回 `add/update/remove/noop`，每项包含目标属性、文本、本人消息依据与是否为谨慎推断。依据只供后台校验，不进入 Personal 正文或主 Prompt。单次临时要求通常只作用本轮；反复情况结合语境归纳，不用机械“出现两次就记住”。

更新先加载最新 revision，在同一 person 的串行处理里合并，不能让较早任务晚完成后覆盖较新纠正。没有新的长期内容用 noop。主回答失败时不新增自动推断；明确纠正/遗忘仍要处理，不能等成功回答才生效。

条目的稳定 attribute_key 保存在 Markdown comment 中，读取给模型前移除 comment。它不是来源或指纹，用来定位同一偏好、纠正与删除。本人完整编辑后由后端保留能确定对应的 key，为新增内容分配新 key；不能把段落行号当稳定标识，也不能因编辑改变 key 就绕过遗忘排除。无法确定是否重新授权的旧属性，不自动恢复。

## 6. 最小持久化与故障恢复

建议复用 PostgreSQL 记录控制态，Markdown 是唯一持久的正文，不再把同一全文写入第二张 DB 表。

| 新增/修改 | 必需字段与用途 |
| --- | --- |
| `memory_documents` | module、scope_key、directory_id、revision、pending_revision、updated_at；唯一 module×scope_key。只记录控制态，不存第二份 Markdown 正文 |
| `personal_memory_jobs` | id、person_id、conversation_id、through_sequence、kind、status、attempts、error_code；同人/会话/截止序号/类型去重，输入从原文读，不复制私聊全文 |
| `personal_memory_exclusions` | person_id、attribute_key、through_job_id、conversation_cutoffs、created_at；以全局 job ID 加各 conversation 的序号截止点处理跨 scope 旧历史；新明确授权可覆盖对应排除，不做关键词全局封禁 |
| `conversations` | context_schema_version、memory_epoch；仅失效可替换运行态，保留原始消息 |

Personal 更新先取得带 memory 命名空间的本人 PostgreSQL session advisory lock，所有读写遵守同一锁；事务内锁定 `memory_documents` 行，登记并提交 pending_revision，然后将新 Markdown 写到临时文件并 rename，最后新事务提交 revision、清除 pending。文件首行以 Markdown comment 保存 revision（读取时不发给模型）。pending 必须在文件替换前持久化，不能和最后一步同事务，否则崩溃后会丢失恢复依据。启动发现 pending 时按文件 revision 完成登记或放弃未落盘候选；状态不符时暂停该文档更新并保留内容，不猜测覆盖。session 锁覆盖整个过程，并在 finally 释放连接。数据库和文件不是一个事务；该恢复只为用户记忆不丢失，不扩展为通用工作流引擎。

成功对话保存时，在同一数据库事务创建蒸馏任务，随后再返回 done；worker 串行领取本人任务，最多重试两次，失败留错误码、主对话仍可用。不要在 SSE 已返回后才仅 fire-and-forget 排内存任务，否则重启会丢记忆更新。

初次上线默认 Personal 为空，从上线后的主私聊自然形成；不批量导入所有历史。Company 不可用也不能把会话中的公司说法挪进 Personal 兜底。

## 7. 查看、纠正与遗忘

沿用 requirePerson，新增本人接口（正式 TypeBox/OpenAPI 定义在实施工单中完成）：

- `GET /api/me/memory/personal`：本人 Markdown 与 revision；Cache-Control: no-store。
- `PUT /api/me/memory/personal`：expectedRevision + 完整编辑正文，冲突返回 409，不允许改 owner。
- `POST /api/me/memory/personal/forget`：expectedRevision + sectionIds，删除指定条目或章节，同时生成排除记录、失效本人 Runtime/cache。

单独一条“忘掉 X”走主聊天已有接收链路：识别结果必须定位到本人已存属性，明确则执行忘记，不明确则先澄清；不能靠删除短语的关键词匹配扩大范围。forget 的成功回执只在删除与排除记录持久化后给出。

遗忘事务阻止待处理旧蒸馏任务重新写回该属性，并提升 memory_epoch。后续组装历史时，对被排除属性相关片段做排除/脱敏；旧助手回答也可能提到它，不能只删 Personal 文件却重新放回历史。无法可靠定位的片段保守不作为 Reference。原始聊天仍留原记录，用户若要删除聊天另走相应产品操作。

暂不新增完整记忆管理产品页面；本人接口和必要的主聊反馈先支持查看/纠正/遗忘，后续 UI 依现有账户入口设计。删除记忆不自动删除公司事实。

## 8. 消费与容量

Personal 常驻的是有界稳定协作偏好，其他内容按 Query 召回；谨慎归纳不得作为执行权限或公司事实。Personal.md 初始硬上限 16 KiB，超限先合并/移除重复与失效内容；不能静默截断末尾或把长期有效内容随意按时间删除。仍超限则停止本次新增、记录需要整理，现有记忆继续可读。

公司/个人章节索引和正文读取共享 Reference 预算，具体见上下文规格。查询不得自动全量注入两份文档。保留相关性、知识更新、时间推理与“不知道”的独立评测，不只量化文件变短或检索命中。

## 9. 原 MCP 与领域文档迁移

先将 PeopleDirectory 从 companyMemory.ts 拆出，保持鉴权和稳定 personId，业务负责人映射不能替代登录角色。雷达/预审等现有 MCP 调用方改为直接读取 Company 模块，运行时仍只读。CompanyMemory SDK 封装、HTTP 端点和专用 Token 删除后，`/mcp/me` 等其他 MCP 功能保留。

更新 `.env.example`、server/AppEnv、Compose 卷与存储初始化、healthz、测试 fixture。World 缺配置时整个主聊不应因旧 Markdown 缺失而启动失败；Company 依赖状态单独显示，身份目录缺失仍按既有规则失败。

新增 ADR 说明替代 ADR-0013 的 MCP 决定与 ADR-0004 的旧公司认知维护方式，更新 CONTEXT 的 Anchor、Reference、Company、Personal 定义；ADR-0010 的原始聊天/业务事实不归 Runtime 持有的原则保持。旧 ADR 标为历史被替代，不能无说明覆盖。本轮设计文件不提前宣称这些运行改造已经完成。
