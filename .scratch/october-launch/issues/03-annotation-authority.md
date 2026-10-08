# 03 · 材料批注按「谁写的」区分：能改的人立即改，其他人的批注等采用

Type: implementation
Status: ready-for-agent
Blocked by: —（基于 7c1480f 的材料批注；尚未上线，不需要迁移旧数据）

## 背景

新的合作方式：会前大家批注材料，会中针对批注讨论，会后采用的批注由 Agent 修改。9/30 的规则「Markdown / HTML 批注写完立即排队修改」只对能改这份文档的人保留。决定记录：项目文档 `claude/决策记录_10月上线与协作批注_2026-10-06.md` 第二节第 6 条。

## 规则

1. **能改这份材料的人** = 上传者（`object_materials.owner_id`）+ 对象负责人：执行事项是推进人（`tasks.owner_id`），会议是主持人（`meetings.lead_dri_id`），议题是 CEO。
2. 选中文字后：
   - 能改的人：「保存」（只留批注）和「立即修改」（进现有队列）。与任务卡批注的两个按钮同一套样式和文案。
   - 其他人：只有「保存」。保存后批注上显示「待{上传者名}处理」。不加说明文字。
3. 能改的人在每条别人的批注上可以「采用」或「不采用」（原因可不填）。采用 = 进入现有串行队列，Agent 按批注改；修订记录写清提出人和采用人。不采用的批注收起，悬停可见。
4. 能改的人也可以把自己「保存」过的批注改成立即修改（同「采用」）。
5. 原文已经变了：批注标「原文已改」；采用时 Agent 找不到原文就 `no_change` 并写原因（沿用现有）。
6. PDF / Word 原件：只能保存批注，没有「采用」。
7. **对话守同一道门**：不能改的人在对话里让 Agent 改别人的材料，`edit_material` 不可用，改用 `propose_material_edit`，提议的接收人是能改的人（不是对话本人），出现在他们的材料上方，点「按这个改」生效。能改的人在对话里照旧可以直接改。

## 要做什么

- API：`POST .../annotations` 加 `intent: note | edit`（省略为 note）；edit 只允许能改的人，其他人 403。新增状态 `noted`（留着未处理）和 `declined`；`kept` 并入 `noted`（不可采用的格式不给采用动作）。新增 `POST .../annotations/:id/decide { decision: adopt | decline, reason? }`，只允许能改的人；adopt → `queued`。修订表记录 `adopted_by`。
- 提议：`material_edit_proposals.proposed_for` 在不能改的人发起时写成上传者（对象负责人也能看到并处理）。
- 对话工具：按当前人是否能改这份材料决定开放 `edit_material` 还是只开放 `propose_material_edit`；提示词同步。
- Web：选区菜单按角色给一个或两个按钮；批注列表 / 悬停卡里给能改的人「采用 / 不采用」；材料下拉上显示待处理条数（只给能改的人）。
- 契约改动后重新生成客户端。

## 不做

- 批注下跟帖回复；攒一批让 Agent 整体重写；会后在会议结论里采用批注（另开工单）。

## 完成定义

- 测试：两类人各自的按钮与权限；note 不改正文；edit 立即排队；采用后排队并记录采用人；不采用收起；非能改的人对话里拿不到 `edit_material`、提议落到上传者；只读格式没有采用。
- 浏览器：上传者、推进人、普通协作者三种身份在执行事项材料上各走一遍；手机 390 宽。
- API / Web 类型检查与相关测试通过。

## Comments

### 2026-10-08 · 实现完成，待浏览器验收（分支 feat/october-launch-03，4e42486）

做了什么
- 规则只在一处：`objectMaterials.materialEditor` = 上传者 + 对象负责人（执行事项 `tasks.owner_id`、会议 `meetings.lead_dri_id`、议题看 CEO 角色）。立即修改、采用 / 不采用、修改提议的收件与处理、恢复删掉的段落、对话里 `edit_material` 都调它；`editObjectMaterial` 落版前统一把关（403 `MATERIAL_FORBIDDEN`）。
- 迁移 058：status 新增 `noted` / `declined`，`kept` 并入 `noted`；`material_annotations.decided_by`（采用或不采用的人，立即修改时是作者本人；CHECK：noted 当且仅当 decided_by 为空）；`material_edit_proposals.proposed_by`。
- API：`POST …/annotations` 加 `intent: note | edit`（省略为 note；edit 只给能改的人，其他人 403，PDF / Word 400）；新增 `POST …/annotations/:annotationId/decide { decision: adopt | decline, reason? }`（只给能改的人；adopt → queued 并入队；已处理 409 `MATERIAL_ANNOTATION_DECIDED`）。
- 契约：`MaterialView` 加 `canEdit`、`pending`；`MaterialAnnotationView` 加 `decidedBy`、`stale`、`canDecide`、`canApply`；`MaterialEditProposalView` 加 `proposedBy`；新增 `DecideMaterialAnnotationRequest`；已重新生成 Web 客户端。
- 队列：按采用人的权限改，这一版 `requested_by` 记采用人，提出人经 `annotation_id` 取批注作者；别人提的批注摘要写「按某某的批注：…」。
- 对话：本人能改这里至少一份材料才有 `edit_material`；不能改的人只有 `propose_material_edit`，收件人是上传者，对象负责人也能看到并处理；`list_materials` 与 `viewingMaterial` 带 `canEdit`；CEO / DRI 提示词共用同一段。
- Web：选区「保存 / 立即修改」（任务卡同款按钮和文案），其他人只有「保存」；批注列表里其他人看到「待{上传者}处理」，能改的人在别人的批注上「采用 / 不采用」（原因可不填）、在自己保存的上「立即修改」；不采用的收起成一行，悬停或点一下展开；「原文已改」；材料下拉显示待处理条数；修订悬停写「某某采用」；别人提的修改提议写「某某在对话里提议修改」。

验证
- API：`TEST_PG_URL=postgres://postgres:postgres@localhost:54329/postgres npx vitest run test/materialAnnotations.test.ts test/piConversationRuntime.test.ts test/objectMaterials.test.ts test/migrate.test.ts`，4 个文件 44 条通过（新增「材料批注按谁写的区分」3 条、对话门 1 条）。
- 变异检查：放开立即修改的门、提议收件人改回本人、总给 `edit_material`、去掉落版把关，对应 3 条用例都失败；还原后通过。
- Web：`npx vitest run src/components/materials src/components/shell/materialMenu.test.tsx`，4 个文件 19 条通过；会议、议题、对话相关 6 个文件 97 条回归通过。
- `pnpm --filter @warmap/contracts typecheck`、`@warmap/api`、`@warmap/web` 均通过。

未验证
- 浏览器：上传者、推进人、普通协作者三种身份在执行事项材料上各走一遍、手机 390 宽，按约定由 lead 合并后做。
- 真实模型下采用后的改写效果（测试用桩 Agent）。

判断与后续
- 「修订表记录 adopted_by」没有给 `material_revisions` 加列：采用人存在 `material_annotations.decided_by`（排队时就要用，no_change / failed 没有修订也要显示），落版时 `requested_by` 即采用人，提出人经 `annotation_id` 关联，不重复存。
- 恢复删掉的段落也只给能改的人（同一道门，落版把关已覆盖）。
- 下拉待处理条数只数别人保存、等本人采用 / 不采用的批注，不数修改提议；不能改的人提的修改提议没有通知，能改的人打开那份材料才看到，后续可补群消息或计数。
- 「原文已改」：批注写在旧版，且选中的文字在最新版里找不到（去掉标签、实体、链接地址和列表序号后只比字母和数字）。

### 2026-10-08 浏览器验收（时间机器，一次性测试库，合成身份）

数据：孙铭泽（推进人）的执行事项拉林知行、何望舒为协作者；林知行上传 Markdown。时间机器 fixture 直接插 `tasks`/`task_members`，没有写推进人的 `thread_members`，推进人列材料 404；产品建事项会写（`tasks.ts:165`），测试库手补后继续。

通过（1440 宽）：
- 何望舒（普通协作者）：选中文字只有「取消 / 保存」；回车 = 保存；批注显示「待林知行处理」。
- 孙铭泽（推进人）：材料下拉单与「封面」上显示待处理 1；「采用 / 不采用」可用；不采用要原因（可不填），之后收成一行「孙铭泽不采用：…」，待处理角标消失；自己选中文字有「取消 / 保存 / 立即修改」，立即修改后升第 2 版、批注标「已改 · 第 2 版」，对话框提示变「让 Agent 改这份材料…」。
- 林知行（上传者）：有「保存 / 立即修改」。

发现（未改，均为材料批注原有问题，非本工单引入）：
- 手机（390，触屏）选中文字不弹「写批注」：Markdown 正文只在 `mouseup` 时取选区（`MaterialAnnotations.tsx` `useMaterialSelection`），触屏长按选字不触发；手动补发 mouseup 后浮层出现，但位置算到 y≈842（屏幕底边、被对话框挡住）。手机上实际无法写批注。
- 1440 宽：选中文档末尾附近文字时，批注浮层底部被材料区裁掉，「立即修改」只露出上半截（仍可点）。
