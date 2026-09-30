# 01 · 材料批注 → Co-Agent 修改、悬停历史、垃圾篓、共识提议（API）

Type: implementation
Status: ready-for-agent
范围：议题 / 执行事项 / 会议三类对象的左侧材料区（用户 2026-09-30 决定先做这三类）。

契约已写好：`packages/contracts/src/materials.ts`（`MaterialAnnotationRef`、`MaterialRevisionView.annotation`、`MaterialBlockHistoryEntry`、`MaterialBlock.history`、`MaterialAnnotationStatus/View`、`CreateMaterialAnnotationRequest/Response`、`MaterialRemovedView`、`RestoreMaterialRemovedRequest`、`MaterialEditProposalView`、`DecideMaterialEditProposalRequest`，以及 `MaterialDetailResponse` 新增的 `annotations / removed / proposals`）和 `openapi.ts` 三条新路径。不改契约字段；确需改先在汇报里说明。

现有实现：`apps/api/src/objectMaterials.ts`（读写、版本、`editObjectMaterial`）、`materialDiff.ts`（分块 diff）、`routes/materials.ts`、`piConversationRuntime.ts`（对话里的 `read_material / edit_material / create_material` 工具与提示词）。沿用它们的权限、版本、存储方式。

## 用户已确认的规则

1. 选中材料里任意文字写批注；Markdown / HTML 写完**立即**排队让 Co-Agent 按批注改（不做「攒一批再改」）；同一份材料的批注**按顺序一条条改**，互不覆盖。PDF / Word 只留批注（`kept`）。
2. 改过的地方悬停能看到批注和修改历史。
3. 被删掉的内容正文里默认不显示（连「⋯」标记也不要），统一进「垃圾篓」，可恢复。
4. 对话里达成共识时，Co-Agent **主动提议**、显示在材料上方，本人点「按这个改」才改；用户明确说「改」时照旧直接 `edit_material`。

## 要做什么

### A. 数据（新 migration，编号接现有最大号之后）

- `material_annotations`：`id, material_id, object_type, object_id, version, quote, prefix, suffix, body, author_id, client_id, status, applied_version, note, attempts, created_at, updated_at`；`UNIQUE(author_id, client_id)` 做幂等；status 用 CHECK 约束成契约取值。
- 材料修订表加 `annotation_id`（可空，外键到批注）。
- `material_edit_proposals`：`id, material_id, object_type, object_id, version, summary, edits jsonb（[{find, replace}]）, proposed_for, conversation_id(可空), status, created_at, decided_at`。

### B. 写批注 + 串行修改

- `POST /api/materials/:objectType/:objectId/:materialId/annotations`：权限同读材料；按 `(author, clientId)` 幂等；可改格式 → `queued` 并触发队列，只读格式 → `kept`。响应 `{ annotation }`。
- 队列：同一份材料严格串行（进程内按 material 串行 + 数据库行锁；多进程也不能并发改同一份）。取最早的 `queued` → `applying` → 跑 Agent → 用现有 `editObjectMaterial` 落版（`requestedBy` = 批注作者，`summary` = 「按批注：<意见前 40 字>」，写 `annotation_id`）→ `applied` + `applied_version`；Agent 判断不用改 → `no_change` + `note`；失败（含 find 不唯一）自动重试 1 次，仍失败 → `failed` + `note`。
- 批注 Agent（Pi 运行框架、heavy 档，TypeBox 严格输出 `{ edits: [{ find, replace }], summary, noChange: string | null }`）：输入是**最新版**源码（不是写批注时那一版——前面的批注可能已经改过）、`quote / prefix / suffix`（用来定位）、批注意见、对象标题。规则：只改批注指向的地方和为保持通顺必须连带的句子；`find` 必须在当前源码中唯一匹配；HTML 保持标签结构、不加外链脚本；看不懂或原文已不存在时 `noChange` 说明原因，不猜。
- 启动恢复：`applying` 超过 10 分钟的回到 `queued`；若已有带这个 `annotation_id` 的修订则直接置 `applied`（防止重复改）。

### C. 详情响应扩展（`GET .../:materialId`）

- `revisions[].annotation`、`revision.annotation`：这一版对应的批注（含 quote、body、author），不是按批注改的为 null。
- `blocks[].history`（只在看最新版时给，Markdown 才算；HTML 给空数组）：沿着历次修订把这一块往回追（用相邻版本的分块 diff 对齐），每次 modified / added 记一条 `{version, kind, before, requestedBy, at, annotation}`，新的在前、最多 5 条；没改过为空数组。
- `annotations`：这份材料全部批注，新的在前。
- `removed`（只在看最新版时给）：历次修订里被删掉的块（Markdown 按块；HTML 按行、去标签后非空的才算），带版本、谁、何时、对应批注；已被恢复（后面某版又出现完全相同文本）的不再列出。`id` 用稳定值（例如 `v<version>-<块序号>`）。PDF / Word 为空数组。
- `proposals`：`proposed_for` = 当前查看者且 `pending` 的提议（只在看最新版时给）。
- 正文 `blocks` 仍可包含 removed 块（契约没变），Web 会隐藏。

### D. 垃圾篓恢复

- `POST .../:materialId/restore`：`{ removedId, version }`；`version` 不是最新 → 409 `VERSION_CONFLICT`；把那段插回「它原来的前一块」之后（前一块已不存在就插到它原来位置附近 / 文末），存成新版（`requestedBy` = 操作人，summary 「从垃圾篓恢复」）。返回最新详情。只读格式 400。

### E. 共识提议

- 对话工具 `propose_material_edit`（`piConversationRuntime.ts`，与 `edit_material` 同样只在当前对象的材料可见时提供）：参数 `{ materialId, summary, edits: [{find, replace}] }`；校验 find 在当前版唯一；存 `pending` 提议（`proposed_for` = 对话本人），返回一句「已在左侧材料上方提议，点『按这个改』生效」。
- 提示词：对话中双方就当前在看的材料内容**达成明确共识**（对方同意了某个具体改法）时，用 `propose_material_edit` 提议，不要直接改；对方明确要求「改 / 写进去」时仍用 `edit_material` 直接改。不确定是否共识就不提议。
- `POST .../:materialId/proposals/:proposalId`：`{ decision: apply | dismiss }`；只有 `proposed_for` 本人；apply 时若版本已变，先在最新版上重验 find：都唯一就照改，否则置 `stale` 返回 409；成功落版（`requestedBy` = 本人，summary = 提议 summary）。返回最新详情。
- 同一份材料新改过一版后，旧的 pending 提议若 find 不再唯一，读详情时置 `stale` 不再返回。

### F. HTML 预览里的选区

- `GET .../preview` 返回 HTML 材料时，在 `</body>` 前注入一段很小的内联脚本（不加外链）：`mouseup` 后若有非空选区，`parent.postMessage({ type: "tianshu-material-selection", text, prefix, suffix, rect: {top,left,width,height} }, "*")`；选区清空时发 `{ type: "tianshu-material-selection", text: "" }`。prefix/suffix 取选区前后各最多 200 字的纯文本。iframe 是 `sandbox="allow-scripts"`，不需要同源。

## 完成定义

- 测试（`TEST_PG_URL=postgres://postgres:postgres@localhost:55432/postgres`，在 `apps/api` 下 `node node_modules/vitest/vitest.mjs run --maxWorkers=1 ...`；不要用 pnpm exec）：批注幂等；只读格式 `kept`；两条批注串行（桩 Agent 断言第二条拿到的是第一条改完的版本）；`no_change` / 失败重试后 `failed`；恢复后不重复改；revisions 带 annotation；blocks.history 追溯多版；removed 列出且恢复后消失、恢复插回原位；提议 apply / dismiss / stale / 非本人 403；preview 注入脚本只对 HTML；对话工具 `propose_material_edit` 校验 find 唯一。
- API 类型检查（`node node_modules/typescript/bin/tsc --noEmit -p .`）通过；全量 API 测试跑一次，已知无关失败：部署脚本 9 条、导入 CLI 超时 1 条。
- 不改 Web（Claude 负责），不改契约字段，不做 git 写操作，不新增依赖，不读打印密钥，不停占用其他端口 / 进程（3100/3450/3500/3610/4500/4610/4650、5432、55432 等）。
