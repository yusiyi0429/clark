# Clark ↔ memory_service 本体对接 · 详细改造设计

> 版本 v1.0 · 2026-08-31
> 范围：把 clark 的本体链接（TKOS GraphKnowledge M7，即 tkos-lab）替换为 workspsce 的 memory_service。
> 本文是设计稿，未获批前不含任何代码改动。

---

## 0. 范围与不做什么

**做**：
- 读路径：clark 的 `graphknowledge/` 客户端背后换成 memory_service；
- 写路径（后期）：议题链数据从 clark 本地 store 迁为 memory_service 权威库；
- 为此在 memory_service 侧新增的最小能力（HTTP 皮、P0 渲染器、短码）。

**不做（明账）**：
- 不改 memory_service 的治理不变量（propose→human confirm、零直写、fail-closed 来源校验）；
- 不动 clark 的 a1a–a10 流水线、talk/ 引擎、recipes 装配逻辑；
- 不做 Context Graph 的运行时写提案入口（默认裁决：clark 写回只落 WM，不碰 CG，见 §D5）；
- 不做 ReopenTrigger 的对象化（映射到 Judgment 版本内容，见 §D5.4）；
- 不迁移 tkos-lab 的历史数据（灰度期两边并存，见 §7）。

---

## 1. 现状精确盘点

### 1.1 clark 的消费面（读）

单门面 `src/lib/graphknowledge/index.ts`，消费者只有 5 处：

| 消费者 | 用什么 | 干什么 |
|---|---|---|
| `agent/harness.ts` | `openContext(channel, …)` | 每条 Agent 链路装公司上下文（S01/S02/S03 配方） |
| `agent/company-context.ts` | `openContext` + `lookupMembers` | 对话路径的公司上下文 + `ontology_lookup` 工具，总闸 6s |
| `agent/checks.ts` | bundle.`memberIds` | `citedOk` 白名单：模型引用的内部编号必须是本轮真装配过的 |
| `api/graphknowledge/check/route.ts` | `runGraphKnowledgeCheck` | 自检端点 |
| `api/health/route.ts` | `GraphKnowledgeClient.health()` | 存活探针（报数据模式） |

HTTP 契约（全部 GET，Basic Auth 可选，per-request 30s 超时）：

```
P0  /api/v1/context/static?viewer&as_of   → text/markdown（公司经营状态全文）
P1  /api/v1/entities/{code}?view=latest   → GkEntity
P2  /api/v1/entities/{code}?view=chain    → GkEntity（带 versions[]）
P3  /api/v1/context/dynamic?q&k&budget    → GkDynamic（q>100 字服务端 422）
    /healthz                               → JSON
```

类型（client.ts:69-93）：

```ts
GkVersion { index?, status?, at?, statement?, meetingLabel? }
GkEntity  { code?, label?, properties?, relations?: Record<string,string[]>, versions? }
GkSeed    { code?, type?, score? }
GkDynamic { query?, seeds?, text?, warning? }
```

关键语义（必须原样保留，clark 侧有结构保证）：
1. **三态不混淆**：anchored（命中）/ external_only（`AnchorNotFound` 被门内吃掉）/ unavailable（异常上抛，绝不折成 ②）；
2. **autopick 相对阈值**：`TIE_RATIO=0.95`，次名分数 ≥ 首名 95% 算"同档"，换打分器仍成立；
3. **P3 参数固定**：S01 k=5/budget=3000 等，不受思考深度影响（同议题不同深度上下文必须相同）；
4. **短码可引用**：`ISS-D6`/`JDG-01`/`DOC-05` 模型可照写、屏幕可点开；`[member:x]` 内部编号不可写进回复；
5. **memberIds 是今天唯一穿过边界的结构化数据**（citedOk 依赖）。

### 1.2 clark 的写路径现状（重要修正）

`GraphKnowledgeClient` **纯只读**。a10 `runWriteBack` 产出的是** Closure 草案（提案）**，一号位 `confirmClosure` 之后写的是 **clark 本地 store**（翻版判断、`clearShakenBy`、布控 Trigger），tkos 本体从未被 clark 写过。

⇒ 结论：**读路径替换与写路径治理化是两个独立工程**。读路径换掉后 clark 立即可用；写路径是"要不要让 memory_service 成为议题链权威库"的产品决策。

### 1.3 memory_service 供给面（workspsce，全部已核实）

| 能力 | 入口 | 备注 |
|---|---|---|
| 图查询 | `context_graph.query.plan_query / execute_query / retrieve` | strategic_path_v1：向量命中→primary_alignment 上溯 CompanyVision→横向补充→预算裁剪；REPEATABLE READ 只读事务；返回 typed Context Pack（hit/path/lateral/确认状态/source_refs/预算） |
| WM 治理写 | `working.create_chain_with_first_signal / create_signal / append_version / form_issue / advance_issue_to_strategic / create_judgment / confirm_judgment / create_agreement / confirm_agreement / create_mission / create_close / confirm_close / attach_source_ref / list_source_refs / list_chain_current_versions_by_type` | 全部 caller-owned conn；确认动作强制 human actor（`users.kind='human'` 同 scope） |
| WM 读取 | `context_profile.build_context_profile_pack / render_model_context`；`working_repository.get_version_chain / get_current_version / get_latest_confirmed_version / resolve_chain_by_title / list_chains` | 六对象分级召回契约冻结在 `working_contracts.py` |
| 校验 | `verification.verify_memory` | 只读不变量校验，偏重（healthz 不用它） |
| CG 提案 | `ingest.file_shadow_plan`（manifest+冻结 fragment） | **唯一**图写入口，无运行时交互提案 API |

**边界约束**：memory_service 不导入 `aw.*`（AST 测试保护）、不自开连接、不自行读宿主设置——宿主必须显式注入 connect_factory/gateway/embedding 维度/actor。

---

## 2. 总体方案：三阶段

```
阶段一  M7 兼容皮（读路径替换）
  新建 clark-memory-adapter（HTTP 服务）→ 对 clark 暴露与 M7 逐字节同形的 P1/P2/P3/healthz
  clark 只改 TKOS_GRAPHKNOWLEDGE_BASE_URL → 立即可用、可灰度、可回滚
        │
阶段二  P0 + 短码 + 结构化装配
  memory_service 侧新增 static_context 渲染器（CompanyVision 遍历 + WM 在版判断）
  短码体系落库（ISS-/JDG- 稳定解析）；Context Pack 结构化字段穿出边界
        │
阶段三  写路径治理化（memory_service 成为议题链权威库）
  clark store 的 Signal/Issue/Judgment/Closure → WM 六对象
  confirmClosure → create_close + confirm_close（human）
```

阶段一/二零治理风险（纯读）；阶段三动产品语义，单独验收。

---

## 3. 关键设计决策

### D1 服务形态：独立 adapter 服务（裁定：方案 a）

| 选项 | 评估 |
|---|---|
| a. 新建 `clark-memory-adapter`（FastAPI；以 psycopg/httpx 显式注入宿主能力，**不 import `aw.*`**） | ✅ 不污染两个仓库的边界；部署形态与 tkos-api 对等；灰度期可并存 |
| b. 扩展 workspsce 的 `aw` CLI 加 serve 子命令 | ❌ aw 是运维入口，混入长驻服务职责 |
| c. clark 直连 PostgreSQL | ❌ 跨语言重写全部治理校验，违反 memory_service 单一权威实现 |

adapter 部署：本机 docker（与 tkos-api 同级）， Basic Auth 沿用 clark 现有 env 形态；上 TLS 域名后去掉 `VERIFY_TLS=0`。

### D2 编址：稳定短码，落在 adapter 层（裁定：方案 1）

| 选项 | 评估 |
|---|---|
| 1. adapter 生成并解析短码：`ISS-{chain 短名}` ↔ `wm_issue_chains.title`；`JDG-{n}` ↔ 同链 Judgment 序号；`CARD-{n}` ↔ Signal | ✅ clark 零改动；不动 schema；短码确定性可测 |
| 2. WM 表加 code 列 | ❌ 动 schema + 契约测试，为 UI 便利付库层代价 |
| 3. clark 改用 title 定位 | ❌ 破坏 autopick trace 台账与 citedOk 白名单语义 |

短码规则（v1，冻结）：
- adapter **不维护持久化或进程内 code 映射**。每次请求用 `memory_service.working` 的公开读函数在当前 scope 构建同一份确定性索引，重启不改变结果；
- `ISS-{SLUG}`：取全部 chain，按 `(created_at, chain_id)` 排序，依次 `slug_of(title)` + `dedupe(slug, taken)`。同名/同 slug 的后者追加 `-2`、`-3`；title 改名会产生新码，这是 v1 已知边界；
- `JDG-{NN}` / `SGN-{NN}`：分别对**全 scope** 的 Judgment/Signal 对象按 `(wm_objects.created_at, object_id)` 排序取 1-based ordinal。不得按链内编号，否则多个 chain 的 `JDG-01` 会碰撞，无法作 clark 全局 anchor；对象创建时间通过 `working.get_object` 获取，禁止直接读表；
- `DOC-{NN}`：暂不提供（memory_service 无文档实体；阶段二 P0 若引入 ResearchDoc 溯源再定）；
- **同一实体必须每次同码**（citedOk 的白名单前提）。

### D3 P3 召回语义映射（裁定：Context Pack 投影 + 模式标注）

`retrieve` 不是纯向量召回。投影规则：
- `seeds[]` = Context Pack 的 hit candidates（主路径命中）+ lateral nodes（横向补充），先 hit rank、再 lateral rank，按 entity_id 去重，`score` 取检索相似度；
- **P3 seed 编码裁定**：Context Graph entity 与 WM 的 ISS/JDG/SGN 没有真实映射，禁止伪装成 D2 短码。使用稳定只读引用 `CG-{entity_uuid}`，`type` 取 `type_key`。它可进入 clark 本轮 `memberIds/citedOk` 白名单，但本期不能经 P1/P2 解引用（`GET /entities/CG-*` 仍 404）；这是 MVP 明账，不是遗漏；
- 数量：`k` → `RetrievalBudgets(hit_limit=k, max_paths=min(k, 5), lateral_budget=2)`，投影后保证 ≤k 个实体进 seeds；
- `budget` **不能**映射到 `RetrievalBudgets`（该契约只有 hit/path/lateral/depth，没字符字段）。adapter 先拿完整 `Context Pack`，再对 `render_narrative(pack)` 的最终 `text` 做确定性字符截断：`len(text) <= budget`；截断时以 `…（按语义召回预算截断）` 结尾并把 `warning` 置为 `narrative_truncated_to_budget`。结构化 seeds 不因 text 截断而丢失；
- **语义差异要在 text 里自描述**：`GkDynamic.text` 首行标注"（strategic_path_v1 路径召回：已含愿景→命中节点主路径叙事）"，让 A1a/A3 的 prompt 消费方知道这批 seeds 带路径上下文；
- 降级/错误语义：scope 无 current generation → 200、空 seeds、warning=`no_current_context_graph_generation`；有图但零命中 → 200、空 seeds、warning=`no_semantic_matches`（优先于 text 截断 warning，因为 clark 在 seeds 为空时不消费 text）；有 seeds 且 text 截断 → warning=`narrative_truncated_to_budget`；embedding 配置缺失或网关调用失败 → 503，绝不伪装成 200/404；
- q>100 字：adapter 照样 422（clark 的 `clip()` 前置不变）。

**验收锚点**：autopick 的 TIE_RATIO 在新分数体系下的"同档"判断是否仍然合理，用 ≥10 条真实 issue.statement 对照跑（见 §8-A3）。

### D4 P0 static_context 渲染器（memory_service 侧新增）

结构（对齐 M7 的信息承诺：本期 Outcome 剩几天、各域在版判断、viewer 是谁）：

```
【公司经营状态】（asOf={iso} viewer={human display}）
## 本期与 Outcome
  （context_graph：CompanyVision → primary_alignment 路径上的 Outcome/OperatingStatus
   节点叙事投影，含 deadline 与当前状态；复用 context_pack 的叙事渲染器）
## 在版判断（confirmed）
  （WM：全 scope confirmed Judgment 的 latest_confirmed_version，逐条
   {JDG 短码} {statement} {confirmed_at}；未确认的不出现——与 M7 语义一致）
```

实现位置：adapter 内的渲染模块（调 `retrieve` + `list_chains`/WM 查询），**不改 memory_service 包本体**——它只是宿主侧的一次消费组合。若后续 workspsce 自己要驾驶舱投影，再讨论下沉。

确定性：P0 参数固定（无 q），输出仅随库内 confirmed 状态变化——满足"同议题不同深度上下文相同"。

### D5 写路径治理化映射（阶段三）

clark 动作 → memory_service 调用（全部经 adapter 的写端点，adapter 负责注入 conn 与 actor）：

| clark 现动作 | memory_service 调用 | 确认语义 |
|---|---|---|
| 扫描/a1a 收信号入库 | `create_chain_with_first_signal` / `create_signal` | Signal 永不确认（契约 CONFIRMATION_NEVER）✅ 一致 |
| a1a 立案（signal→issue） | `form_issue`（state=potential） | 版本落库即 potential；推进 strategic 需 human |
| 议题升级 strategic | `advance_issue_to_strategic`（human=CEO） | ✅ clark 本来就是 CEO 拍板 |
| Judgment 翻版（写回草案） | `create_judgment` + `append_version`（unconfirmed） | Agent 只产 unconfirmed，与 a10"产物不是决定"的 prompt 约束同构 |
| CEO 确认 Closure | `create_close` + `confirm_close`（human，同事务关 Issue） | ✅ 原子性由 working.py 保证 |
| 溯源徽章/报告引用 | `attach_source_ref`（excerpt+SHA-256+locator 冻结） | 比 clark 现在的 ReportSource 更强 |
| ReopenTrigger 布控 | 写入 Judgment 新版本 content（结构化字段），**不建新对象** | 扫描侧按 content 读靶点；对象化留待契约 v2 |

**ReopenTrigger 明账**：WM 六对象没有 Trigger。v1 映射为 Judgment 版本内容字段（`reopen_triggers: [{target, condition, armed_at}]`），clark 的扫描/布控 UI 从版本内容读。若未来对象化，需走 `working_contracts.py` 契约变更 + 契约测试 + 迁移，是独立工作项。

**Agreement/Mission**：clark 当前无多参与方共识场景，不映射。DRI 交接（dri/handoff）暂留 clark 本地，不强行塞进 WM。

**CG 写**：默认不开。理由：memory_service 的 CG 写唯一入口是 manifest 驱动的 `file_shadow_plan`（蒸馏语义），clark 的运行时写回不是蒸馏。若未来要把"判断沉淀为图实体"，那是 distill 管线的扩展，不是 adapter 的职责。**此条为治理边界，如需推翻须 workspsce 主会话裁定。**

### D6 身份与 scope

- viewer（默认 `PSN-01`）→ adapter 映射为 scope 内 human 用户（workspsce 的 `bootstrap_local_user` 机制或显式 seed CEO 用户）；
- scope 常量：adapter env `MEMORY_TENANT/ORG`（单公司单 scope）；workspsce 侧生产 scope 保护清单（`graph-switch` 的 `--allow-production` 等）与 clark 无关，不触发；
- 每次 confirm 类调用，adapter 必须显式传 human actor——**adapter 永远不缓存 actor 跨请求复用**。

### D7 快照与 asOf

- clark 的 `snapshot.ts`（freezeContext/loadContext，"12 项 Context"徽章）在 clark 侧，不动；
- asOf：memory_service 是活库当前态。P0/P1/P2 的 `as_of` 参数**接收但仅用于台账**（trace/审计），不提供历史时间点重建。复盘历史 = clark 已冻结的 contextSnapshot。这是相对 M7 的能力边界，写入交付说明。

---

## 4. 接口契约（adapter v1）

新增配置（clark 侧只换 env 值）：

```
TKOS_GRAPHKNOWLEDGE_BASE_URL=http://127.0.0.1:8010   # adapter
TKOS_GRAPHKNOWLEDGE_AUTH=user:pass
TKOS_GRAPHKNOWLEDGE_VIEWER=PSN-01
```

### 4.1 读端点（与 M7 逐字段同形）

```
GET /api/v1/context/static?viewer&as_of    → 200 text/markdown
    错误：503（DB 不可达 → clark 判 Unavailable）
GET /api/v1/entities/{code}?view=latest
    → 200 GkEntity{code,label,properties,relations}
    → 404（→ clark 判 AnchorNotFound/external_only）
    映射：properties = {state: issue_state 或 confirmation_status, why, monitoringNote←content 字段}
          relations   = {spawns: [该 Signal 形成的 Issue 短码…], shakes: [该 Issue 动摇的 JDG 短码…]}
                       （WM 侧由 wm_issue_signals / Judgment→Issue 表结构反查，adapter 拼）
GET /api/v1/entities/{code}?view=chain
    → versions[] = get_version_chain 映射 {index: version, status: confirmation_status,
       at: confirmed_at/created_at, statement: content.statement, meetingLabel: 来源会议}
GET /api/v1/context/dynamic?q&k&budget
    → GkDynamic{query, seeds:[{code,score,type}], text, warning}   （q>100 → 422）
GET /healthz → {ok, mode:"memory_service", db, embedding, chains:n, warnings:[短码冲突…]}
```

### 4.2 写端点（阶段三新增，全部 405 直到阶段三上线）

```
POST /api/v1/wm/chains                 {title, first_signal{content,created_by}}
POST /api/v1/wm/signals                {chain_code, content, created_by}
POST /api/v1/wm/issues                 {chain_code, content, formed_from:[signal_codes]}
POST /api/v1/wm/issues/{code}/strategic {confirmed_by}
POST /api/v1/wm/judgments              {issue_code, content, created_by}   → unconfirmed
POST /api/v1/wm/judgments/{code}/confirm {confirmed_by}
POST /api/v1/wm/closes                 {agreement…/issue_code, content(七要素), created_by}
POST /api/v1/wm/closes/{code}/confirm   {confirmed_by}
POST /api/v1/wm/source-refs            {record_code, document_id, excerpt, locator}
```

写端点共性：失败语义与 memory_service 异常一一映射（NotHumanApproverError→403、ChainNotFound→404、契约校验→422、source hash fail-closed→409），**adapter 不吞错不改写**。

---

## 5. 模块级改动清单

### 5.1 新仓库 `clark-memory-adapter/`（全部新建）

```
adapter/
  main.py              # FastAPI 入口；注入 aw.db.connect / 模型 gateway / scope
  codes.py             # D2 短码：title↔SLUG、JDG/SGN 序号、稳定性测试
  read_api.py          # P1/P2/P3/static/healthz（§4.1）
  write_api.py         # 阶段三（§4.2）
  render_static.py     # D4 P0 渲染（图叙事 + WM 在版判断）
  pack_projection.py   # D3 Context Pack → seeds/text 投影
  errors.py            # 三态映射：503/404/422，绝不把不可达折成 404
tests/
  test_read_shape.py   # 与 clark 的 GkEntity/GkVersion/GkDynamic 逐字段契约测试
  test_codes_stable.py # 同实体同码、重名冲突、title 变更策略
  test_three_states.py # 停库→503、无链→404（三态不混淆的结构性测试）
  test_writes.py       # 阶段三：human actor 强制、异常映射
```

### 5.2 clark 侧（阶段一几乎为零）

| 文件 | 改动 | 阶段 |
|---|---|---|
| `.env`/部署配置 | `TKOS_GRAPHKNOWLEDGE_BASE_URL` 指向 adapter | 一 |
| `graphknowledge/client.ts` | **不改**（同形契约）；去掉 `VERIFY_TLS=0` 待 TLS 后 | 一 |
| `graphknowledge/index.ts` 等全部 | 不改 | 一 |
| `recipes.ts` | 可选：`segSeeds` 段落标注路径召回语义（D3 自描述已覆盖，可不改） | 二 |
| （结构化装配） | 按《本体接入》计划 A1 项推进，与本设计在 adapter 契约层合并 | 二 |
| `store.ts` 写路径 | `confirmClosure` 等改调 adapter 写端点；本地 store 降级为投影/缓存 | 三 |
| `a10/run.ts` | 不改（产物仍是提案，语义已对齐） | 三 |
| `api/health/route.ts` | 不改（healthz 形状不变） | 一 |

### 5.3 workspsce / memory_service 侧

**阶段一/二：零改动**（adapter 以宿主身份消费现有公开 API）。
阶段三可能的微小项（各自独立评审）：无——`working.py` 现有函数已覆盖 §D5 全部映射。
唯一例外候选：若 P0 需要"全 scope confirmed Judgment 汇总"高效查询，确认 `list_chain_current_versions_by_type` 的全 scope 变体是否存在；不存在则 adapter 内循环 `list_chains`（数据量小可接受）。

---

## 6. 数据映射总表

| clark 概念 | memory_service 落点 | 短码 |
|---|---|---|
| Signal（信号） | `wm_objects(type=Signal)` + versions；链由 `create_chain_with_first_signal` 起 | `SGN-{NN}` |
| 潜在/战略议题（Issue, state） | `wm_objects(type=Issue)`；`issue_state` potential/strategic/closed | `ISS-{SLUG}` |
| 在版判断 Judgment + 翻版 | `wm_objects(type=Judgment)` + `supersedes` 版本链；`confirmation_status` | `JDG-{NN}` |
| 被动摇（shakes） | Judgment←Issue 的表结构（judgment 针对 issue） | relations.shakes |
| 催生（spawns） | `wm_issue_signals`（Issue 由哪些 Signal 形成） | relations.spawns |
| Closure 七要素 | `wm_objects(type=Close)` content（choose/notChoose/why/keyHypothesis/riskAccepted/commitment/reopenTrigger） | — |
| 公司经营状态（P0） | context_graph 叙事 + WM confirmed 判断汇总 | — |
| 语义召回（P3） | `retrieve` Context Pack 投影 | seeds[].code |
| 溯源徽章 ReportSource | `wm_version_source_refs`（冻结 excerpt+hash+locator） | — |
| 文档 DOC | ❌ 无对应（明账：阶段二再议） | — |

---

## 7. 灰度与切换策略

1. **并存期**：tkos-api(8001) 与 adapter(8010) 同时在线；clark 按 env 切。每条议题的上下文来源单一（不混用），`ContextBundle.sourceBaseUrl` 天然记录用了哪个后端（已有字段）；
2. **对照验收**：挑 ≥10 条真实议题，两边各跑一轮 S01/S02/S03 装配 + `runGraphKnowledgeCheck`，diff renderedMarkdown 与 memberIds，差异逐条归因（预期差异：P3 语义、P0 渲染风格——其余应一致）；
3. **读路径切换**：验收通过后 clark 默认 env 切 adapter；tkos 保留作回滚通道（一个 env 的事）；
4. **写路径切换（阶段三）**：先双写观察（clark store 主、WM 影子写），再反转权威方向，最后停本地写。 Judgment 版本连续性用 workspsce 的 `aw memory-check` 校验。

---

## 8. 验收标准

**A. 阶段一（读）**
1. `test_read_shape.py` 逐字段对齐 GkEntity/GkVersion/GkDynamic；
2. 三态结构性测试：停 adapter→clark 走 unavailable（不误判 external_only）；查不存在的链→external_only；
3. S01/S02/S03 三配方在真实议题上装配成功，`MAX_CONTEXT_CHARS=16000` 预算不破；
4. `citedOk` 白名单在新短码下工作（模型引用 JDG-NN 能被识别为真/编造）；
5. `cgr` 不涉及；workspsce 全量测试不受影响（零改动证明）。

**B. 阶段二（P0+短码）**
6. P0 内容覆盖：CompanyVision 主路径叙事 + 全部 confirmed Judgment + viewer 身份；同库状态下两次调用输出逐字节相同；
7. 短码稳定性：重启 adapter 后全部短码不变；title 改名策略有测试；
8. A3 对照（D3 锚点）：≥10 条 issue.statement 的 autopick 首名/次名分布与 M7 对照，TIE_RATIO 误判率可解释。

**C. 阶段三（写）**
9. 一条端到端剧本：扫描收信号→立案→对谈→深研→判断翻版→CEO 确认 Closure，全程落在 WM，`aw memory-check` 通过；
10. 确认人非 human（伪造 actor）被拒（403）且审计干净；
11. 崩溃恢复：写端点中断后无半写状态（事务边界由 working.py 保证，adapter 不自己组事务）。

---

## 9. 风险与开放问题（需要裁定）

| # | 问题 | 建议 |
|---|---|---|
| R1 | P3 路径召回 vs 纯召回的语义差，可能改变 A1a 分诊行为 | 对照验收 A3-8；必要时 adapter 提供 `mode=plain` 退化（直接向量 top-k，绕过路径）作为 B 选项 |
| R2 | M7 的 `relations.spawns/shakes` 是图边，WM 是表结构——若 tkos 图里有 clark 未消费的其他关系（如 DOC 关联），替换即消失 | 并存期 diff 覆盖；确无消费则明账不补 |
| R3 | `CONTEXT_DEADLINE_MS=6000` 总闸：memory_service 装配（pgvector 查询+多跳）延迟是否达标 | 阶段一性能实测；不达标加 adapter 侧缓存（仅 confirmed 态，失效=库版本号） |
| R4 | 短码映射表放在 adapter 内存，adapter 重启丢 SLUG 分配进度 | codes.py 落 SQLite；或 SLUG 纯函数于 title（无状态，推荐后者） |
| R5 | workspsce 协作模型：adapter 是新仓库，动 memory_service 需走主会话评审 | 本设计即为评审材料；阶段一/二零改 workspsce，风险面最小 |
| R6 | asOf 历史重建能力缺失（M7 有 asOf 参数，虽现状可能也是当前态） | 明账降级；复盘依赖 clark 冻结快照 |
| R7 | clark store 9777 行与 WM 双权威期的数据漂移 | 阶段三双写期以 version 指纹对账；切换后 `aw memory-check` + 抽样回放 |

## 10. 工作量与顺序

| 阶段 | 内容 | 预估 |
|---|---|---|
| 一 | adapter 骨架 + codes.py + P1/P2/P3/healthz + 契约测试 + 灰度接线 | 3–5 天 |
| 二 | P0 渲染器 + 短码硬化 + autopick 对照 + 结构化装配合并设计 | 3–5 天 |
| 三 | 写端点 + clark store 改造 + 双写→切权 + 端到端剧本验收 | 5–8 天 |

依赖：一 → 二可并行部分（短码硬化）→ 三。阶段三开工前需对本设计 §D5 的治理裁定（尤其"CG 不开运行时写"）做正式确认。
