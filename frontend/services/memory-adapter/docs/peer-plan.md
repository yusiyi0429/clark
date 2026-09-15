# clark-memory-adapter · Peer 分工计划

> v1.0 · 2026-08-31 · 配套设计文档：`docs/design.md`（即《Clark ↔ memory_service 本体对接 · 详细改造设计》）
> 协作章程沿用 workspsce `AGENTS.md` 的多协作者模型，适配到 adapter 新仓库。

---

## 0. 角色与总纪律（每个 peer 的任务书都引用本节）

**主会话（本文作者）专属，任何 peer 不得触碰**：
- `git` 全部操作（commit/push/branch）
- 数据库迁移（`aw migrate`）、public scope（`local`/`local-org`）的一切写入
- 冻结文件（见 §2 文件所有权矩阵）
- workspsce 与 clark 两个仓库的任何修改（阶段一/二 workspsce 零改动是设计裁定）

**peer 纪律**：
- 只改自己名下的文件；发现需要动别人的文件/冻结文件，停下上报主会话
- 测试只用 conftest 生成的隔离 scope（随机 tenant/org），禁止读写真实 scope 数据
- 不采信任何"应该没问题"；交付物必须含诚实自检（跑了什么、覆盖什么、已知问题）
- 不确定就问，不默默选择一种理解

**技术前提**（主会话在 Wave 0 备好，peer 直接用）：
- 仓库位置 `~/clark-memory-adapter`
- `adapter/bootstrap.py` 把 `../workspsce/src` 挂进 `sys.path`（env `MEMORY_SERVICE_SRC` 可覆盖），peer 一律 `from memory_service import working` 方式引用，**禁止对 memory 表写裸 SQL**（读也不行——边界破口）
- 本地 PostgreSQL（workspsce 迁移已就绪）+ `tests/conftest.py` 提供：隔离 scope、human confirmer、WM 种子链夹具（signal→issue→judgment→confirm 一条龙）
- 运行测试统一：`uv run pytest tests/<自己的文件> -x`；交付前跑全量 `uv run pytest`

---

## 1. 波次与依赖

```
Wave 0  主会话 · 仓库骨架 + 冻结文件 + 共享夹具 + 任务书下发
   │
Wave 1  ┌─ Peer A · 基建（settings/errors/三态/healthz）   ← 无依赖
        ├─ Peer B · 短码（codes.py 纯函数）               ← 无依赖
        └─ Peer C · P0 渲染（render_static 纯模块）        ← 无依赖
   │     （三路完全并行：文件零交集）
   │
Wave 2  ┌─ Peer D · P1/P2 实体端点                        ← 依赖 A(装配)+B(短码)
        └─ Peer E · P3 投影+dynamic端点                   ← 依赖 A+B
   │
Wave 3  主会话 · 逐个 CR + 集成 + 灰度接线（clark env）+ 端到端对照验收 + commit
   │
（阶段三，治理裁定后另发任务书：WP-6 写端点 / WP-7 clark store 改造）
```

进度节奏：每 peer 完成即 `message_peer` 主会话汇报；主会话独立复核（读磁盘代码 + 重跑测试）后回 ACCEPT / NO-GO。NO-GO 修订后重报。

---

## 2. 文件所有权矩阵

| 文件 | 归属 | 说明 |
|---|---|---|
| `pyproject.toml` `README.md` `docs/design.md` `.gitignore` | **主会话（冻结）** | |
| `adapter/__init__.py` `adapter/bootstrap.py` `adapter/contracts.py` `adapter/main.py` | **主会话（冻结）** | contracts=GkEntity/GkVersion/GkDynamic/GkSeed pydantic 形状；main=APIRouter 装配（Wave 0 一次写全，此后不改） |
| `tests/conftest.py` | **主会话（冻结）** | 隔离 scope + human + WM 种子链 |
| `adapter/settings.py` `adapter/deps.py` `adapter/errors.py` `adapter/routes_health.py` | **Peer A** | |
| `tests/test_health.py` `tests/test_three_states.py` | **Peer A** | |
| `adapter/codes.py` | **Peer B** | |
| `tests/test_codes_slug.py` `tests/test_codes_stable.py` | **Peer B** | |
| `adapter/render_static.py` `tests/test_render_static.py` `tests/fixtures_p0.py` | **Peer C** | |
| `adapter/routes_entities.py` `adapter/wm_views.py` | **Peer D** | |
| `tests/test_read_shape_entity.py` | **Peer D** | |
| `adapter/pack_projection.py` `adapter/routes_dynamic.py` | **Peer E** | |
| `tests/test_pack_projection.py` `tests/test_dynamic_endpoint.py` | **Peer E** | |

Wave 0 由主会话创建全部模块占位文件（空 router/空函数），保证 main.py 装配始终可导入。**新增文件**（peer 觉得需要拆）须先报主会话批准。

---

## 3. 各 Peer 任务书（可直接作为 message_peer 正文）

### 任务书 · Peer A「基建与三态」

**目标**：adapter 的骨架层——配置注入、错误映射、healthz。让后续端点 peer 只需注册 router。

**背景**（你看不到主会话对话，这里给全）：
- clark（`~/clark`）现有本体客户端只读 TKOS M7 API：P0-P3+healthz，GET，Basic Auth，per-request 30s。我们用 FastAPI 造一个同形服务，背后是 workspsce 的 memory_service。
- **三态语义是本项目最重要的不变量**：`404`→clark 判"锚点不存在"走 external_only；`503`→clark 判"服务不可用"必须上抛。绝不能把不可达折成 404。读 `~/clark/src/lib/graphknowledge/client.ts` + `errors.ts` 对照实现。

**交付**：
1. `adapter/settings.py`：env 读取（`MEMORY_TENANT/MEMORY_ORG/ADAPTER_AUTH/VIEWER_USER_ID` 等），pydantic-settings，extra=forbid
2. `adapter/deps.py`：每请求借用连接的依赖注入（connect factory 来自 workspsce `aw.db.connect` 的用法——但**不得 import aw**，用 `psycopg.connect(DATABASE_URL)` 直连，URL 从 env）；viewer→human actor 解析（启动时按 user_id 校验 `users.kind='human'`，缓存 display name）
3. `adapter/errors.py`：异常→HTTP 映射表：DB 不可达/embedding 网关失败→503；ChainNotFound/记录不存在→404；契约校验失败→422；source hash fail-closed→409；非 human actor→403。**附映射表注释，逐条对应 memory_service 异常类名**
4. `adapter/routes_health.py`：`GET /healthz` → `{ok, mode:"memory_service", db:bool, embedding:bool, chains:n, warnings:[]}`；DB 探活轻量（SELECT 1），embedding 可只报配置态
5. 测试：`test_health.py`（正常/停库）、`test_three_states.py`（**结构性**：用一个会抛各异常的 fake 端点验证映射，断言 503 永不折成 404）

**验收**：`uv run pytest tests/test_health.py tests/test_three_states.py`；curl healthz。
**不做**：任何 P1/P2/P3 业务端点；不动冻结文件。

### 任务书 · Peer B「短码」

**目标**：`ISS-{SLUG}`/`JDG-{NN}`/`SGN-{NN}` 稳定编址，纯函数，无状态。

**背景**：clark 全链路用业务短码引用实体（模型可照写、屏幕可点开、`citedOk` 白名单依赖）。memory_service 用 UUID+title。短码必须**同实体永远同码**（重启不变），SLUG 必须**纯函数于 title**（无分配状态，见设计 §D2/R4）。读 `~/clark/src/lib/graphknowledge/lookup.ts` 感知消费方式。

**交付**：
1. `adapter/codes.py`：
   - `slug_of(title) -> str`：中文 title → 拼音首字母/稳定转写（自实现或引 pypinyin，**在 pyproject 提依赖需报批**——先自实现简化版：取 title 中 ASCII 段+汉字映射表首字母，v1 够用）；重名冲突由调用侧追加 `-2`（本模块提供 `dedupe(slug, taken)`)
   - `issue_code(chain_title, taken) / judgment_code(ordinal) / signal_code(ordinal)`
   - `parse(code) -> (kind, key)`；非法前缀报 `UnknownCodeError`
   - 全部纯函数 + `frozen dataclass CodeInfo`
2. 测试：`test_codes_slug.py`（中文/混合/空/超长 title 的确定性——同输入万次同输出；不同 title 撞 SLUG 的 dedupe）、`test_codes_stable.py`（重启语义=纯函数无状态的结构性断言：模块不持有可变全局；序号全等映射）

**验收**：`uv run pytest tests/test_codes_slug.py tests/test_codes_stable.py`。无 DB 依赖。
**不做**：与真实 DB 的联调（Wave 2 由 D/E 接）。

### 任务书 · Peer C「P0 公司经营状态」

**目标**：`render_static(viewer, as_of) -> markdown`，确定性渲染。

**背景**：M7 的 P0 一次返回"公司经营状态"全文：本期 Outcome、各域在版判断、viewer 是谁。memory_service 没有现成端点，本模块组合：WM 全 scope confirmed Judgment 汇总 + viewer 身份。**CG 叙事段本期不做**（主会话明账：等图侧读取 API 裁定后另发任务，别自己开洞——禁止对 semantic_* 表写裸 SQL）。

**交付**：
1. `adapter/render_static.py`：借用 conn（参数传入，不自开）；用 `memory_service.working.list_chains` + `get_latest_confirmed_version` 汇总 confirmed Judgment；viewer 行取 display（human 校验过的 user）；输出 markdown（结构见设计 §D4，【公司经营状态】头 + 在版判断逐条 `{JDG} {statement} {confirmed_at}`）
2. `tests/fixtures_p0.py` + `test_render_static.py`：
   - 用 conftest 的 WM 种子链夹具起 2 条链（一条 confirmed 判断、一条只有 unconfirmed）
   - 断言：unconfirmed 判断**不出现**；同库两次渲染逐字节相同；viewer 名字出现；空库（无链）输出合法骨架而非异常

**验收**：`uv run pytest tests/test_render_static.py`。
**不做**：CG/CompanyVision 段；HTTP 端点（主会话 Wave 3 接线）。

### 任务书 · Peer D「P1/P2 实体端点」

**前提**：Wave 1 已 ACCEPT（A 的 deps/errors、B 的 codes）。

**目标**：`GET /api/v1/entities/{code}?view=latest|chain`，返回与 M7 同形的 `GkEntity`。

**交付**：
1. `adapter/wm_views.py`：先用 B 的 codes + `memory_service.working` 公开读函数构建**当前 scope 的确定性无状态 code index**，再做 code→(chain/object) 解析；不得用进程内映射或直接读 WM 表：
   - ISS：全 chains 按 `(created_at, chain_id)` 排序，依次 `slug_of(title)` + `dedupe(slug, taken)`；不得用 title 反查替代该索引（会丢失 collision 后缀）；
   - JDG/SGN：分别对 scope 的所有 Judgment/Signal 对象按 `(working.get_object(object_id)["created_at"], object_id)` 排序，取全 scope 1-based ordinal。**绝不按链内编号**，否则 `JDG-01` 在不同 chain 重复；
   - WM 行→`GkEntity` 投影：`properties`：`{state, why, monitoringNote, …}` ← content 字段白名单映射（对照 `~/clark/src/lib/graphknowledge/client.ts` 的消费：recipes.ts 只读这几个 key）；`relations`：Signal 的 `spawns` ← canonical `working.list_issue_signals()` 反查；Issue 的 Judgment 短码同时填 `shakes`（S01 兼容）和 `hasJudgement`（S02/S03 实际消费），两者值相同；
   - `view=chain`：`versions[]` ← `get_version_chain`，`{index:version 序号, status:confirmation_status, at, statement:content.statement}`
2. `adapter/routes_entities.py`：router + 错误经 A 的映射
3. `tests/test_read_shape_entity.py`：**逐字段**契约测试（对 conftest 种子链：断言 JSON 结构与 `~/clark/src/lib/graphknowledge/client.ts` 的 GkEntity/GkVersion 字段名一致——用 clark 的 TS 定义当规格抄成断言）；404（无此链）；view=latest 与 chain 的差异

**验收**：`uv run pytest tests/test_read_shape_entity.py`；手工 curl 一条种子链。
**不做**：P3/dynamic；P0。

### 任务书 · Peer E「P3 投影与 dynamic 端点」

**前提**：Wave 1 已 ACCEPT。

**目标**：`GET /api/v1/context/dynamic?q&k&budget`，把 `memory_service.context_graph.query.retrieve` 的 Context Pack 投影成 M7 的 `GkDynamic`。

**交付**：
1. `adapter/pack_projection.py`：
   - hit candidates + lateral nodes → `seeds:[{code: "CG-{entity_uuid}", score: similarity, type: type_key}]`，总数 ≤ k；顺序 hit rank → lateral rank，entity_id 去重。CG-* 是用户裁定的真实只读图引用，可进本轮 citedOk 白名单，本期 P1/P2 不解引用，禁止伪装成 WM 短码
   - `text`：首行自描述"（strategic_path_v1 路径召回…）"+ 叙事正文
   - `warning`：无 current generation → `no_current_context_graph_generation`；零命中 → `no_semantic_matches`；embedding 缺配置/网关失败是 503，不得返回 200 warning
   - `k` → `RetrievalBudgets(hit_limit=k, max_paths=min(k, 5), lateral_budget=2)`；**budget 不得塞进 RetrievalBudgets**（它没有字符字段）。先取完整 Context Pack，再对 `render_narrative(pack)` 的最终 text 做确定性字符截断，保证 `len(text) <= budget`；截断时以 `…（按语义召回预算截断）` 结尾，warning=`narrative_truncated_to_budget`；seeds 不因 text 截断丢失（对照 `workspsce/src/memory_service/context_graph/query_contracts.py`）
2. `adapter/routes_dynamic.py`：`len(q)>100 → 422`（对齐 M7，clark 侧 clip 前置不变）；使用 A 已冻结的 `MEMORY_EMBEDDING_API_KEY/BASE_URL/MODEL/DIM` + httpx 调用 workspsce canonical Ark multimodal 契约（`${BASE_URL}/embeddings/multimodal`，payload=`{model,input:[{type:"text",text:q}]}`），**不得 import aw**。借用 A `get_conn` 的连接，调用 `query.plan_query(...embedder...)` → `query.execute_query(plan, conn=conn)`，再 `build_context_pack/render_narrative`；网关调用异常包装成 A 的 `EmbeddingUnavailableError`（503），`NoCurrentGenerationError` 仅在路由内捕获为正常 200 降级
3. 测试：`test_pack_projection.py`（投影纯函数：fake pack→seeds/text；k 截断；warning 透传）、`test_dynamic_endpoint.py`（422；503——停 embedding 时；种子图上的 200 形状——种子图复杂可只测错误路径+投影单测，成功路径留给 Wave 3 集成，**如实写进自检**）

**验收**：`uv run pytest tests/test_pack_projection.py tests/test_dynamic_endpoint.py`。
**不做**：autopick/TIE_RATIO 的行为调优（Wave 3 对照验收）。

---

## 4. 主会话 Wave 0 清单（peer 开工前完成）

1. `git init ~/clark-memory-adapter` + 冻结文件全部就位（pyproject/contracts/main/conftest/bootstrap/README/design.md）
2. `tests/conftest.py`：隔离 scope + human confirmer 种子 + `wm_seed_chain()` 夹具（`create_chain_with_first_signal`→`form_issue`→`create_judgment`→`confirm_judgment` 全走治理路径，绝不裸 SQL）+ 用例后清理
3. 全部模块占位文件（空 `APIRouter()`/`def _placeholder()`），`uv run pytest` 空跑通过
4. 验证 `from memory_service import working` 在 adapter 环境可导入（bootstrap 生效）
5. 把本文档 + design.md 放进 `docs/`，peer 任务书按 §3 逐个 `message_peer` 下发

## 5. 主会话 Wave 3 验收（对照设计 §8 条目 1-8）

- 逐 peer CR：读磁盘真实代码、重跑其测试 + 全量、`python -m compileall`
- 集成：healthz/P1/P2/P3/P0 端到端 curl；三态结构性复验
- 灰度：clark env 切 `http://127.0.0.1:8010`，跑 `runGraphKnowledgeCheck` + ≥10 条真实议题 S01/S02/S03 对照（差异逐条归因）
- commit（首个 tag `adapter-v0.1.0-readpath`）
- autopick TIE_RATIO 对照结论 → 决定是否需要 `mode=plain` 退化开关（设计 R1）

## 6. 阶段三预告（治理裁定后另发，不属本次）

- WP-6 写端点 peer：`write_api.py`（设计 §4.2 → `working.py` 映射；human actor 强制；异常映射）
- WP-7 clark store 改造 peer：`confirmClosure` 等改调 adapter 写端点（**clark 仓库属另一项目，开工前需用户明确授权 + 边界重划**；store.ts 9777 行，需先出切口清单）
