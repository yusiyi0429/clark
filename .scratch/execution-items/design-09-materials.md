# 工单 09 · 材料区：大家上传，只有 Agent 改，改动留痕 · 设计

日期：2026-09-28。依据：

- 用户 2026-09-28 原话要点：
  - 左侧依然显示材料区，每个人都可以上传材料，但只能删除自己上传的材料。
  - 大家不能直接编辑，要通过跟 AI 的对话去编辑，并且会有记录。
  - 「我们可以充分信任 Agent 的智能……直接让它去修改就好。修改完之后，我们可以以一种不显眼的方式去标注修改的版本」：
    - 修改某句话：可以显示它之前是什么样子的；
    - 新增内容：就直接新增。
  - 「人类不具备在天枢系统里直接编辑这些文档的权利。」
- 同日选定：只让 Agent 改；只有文本材料（Markdown）能改，PDF、Word 只读。
- 成员工作台规划 `.scratch/member-workspace/spec.md` §11.2：群里任何人都能上传材料（复用会议材料的存储与解析），只有上传者能删除自己传的。
- SSOT C-08（材料页签小胶囊）、DRI-05（会上改过：改完只留一行很淡的说明）。

## 0. 本单做什么、不做什么

**做**：
- 议题和执行事项的材料区：上传、看、下载、删除自己传的；
- 我的 Agent 读材料、改 Markdown 材料、新写一份 Markdown 材料；
- 改动留痕：
  - 材料里不显眼的修改标注，点开能看改之前的原文；
  - 改动记录；
  - 群里一条 Co-Agent 说明。

**不做**：
- 会议的材料。会议已有「会前材料」和预审，本单不动；成员上传、Agent 改会议材料，放到会议那一单一起做。
- 个人卡。个人卡有自己的讨论和修改建议流程，不是材料。
- 人手动编辑、恢复到旧版本的按钮。要撤回，就让 Agent 改回去。
- 协同实时光标、「正在改」的动画。Agent 一次写完，不流式改文档。

## 1. 哪些对象、谁能做什么

| 对象 | 谁能看、能上传 | 谁能删 |
|---|---|---|
| 议题 | 议题群成员；还没建群时只有 CEO | 上传者本人 |
| 执行事项 | 推进人和在职协作者（事项群成员） | 上传者本人 |

- 「上传者本人」对 Agent 新写的材料来说，就是让 Agent 写的那个人。
- 删除是软删：列表和 Agent 都看不到了，数据库里留着，改动记录也留着。
- 退群的人看不到这个对象的材料，也不能删自己以前传的。
- 能改的只有 Markdown（`.md`，以及 Agent 新写的）。PDF、Word 只读，Agent 能读它们的文字，不能改。

## 2. 数据：迁移 `040_object_materials.sql`

编号 038 已被工单 10 使用，039 已被工单 08 使用。

```sql
CREATE TABLE object_materials (
  id UUID PRIMARY KEY,
  object_type TEXT NOT NULL CHECK (object_type IN ('issue', 'task')),
  object_id TEXT NOT NULL,
  file_name TEXT NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 240),
  format TEXT NOT NULL CHECK (format IN ('markdown', 'pdf', 'docx')),
  size_bytes INTEGER NOT NULL,
  page_count INTEGER,
  -- 上传的原件在材料卷里；Agent 新写的没有原件
  storage_key TEXT,
  sha256 TEXT,
  origin TEXT NOT NULL CHECK (origin IN ('upload', 'agent')),
  -- 上传者；Agent 新写的记让它写的人
  owner_id TEXT NOT NULL,
  current_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  deleted_at TIMESTAMPTZ,
  CHECK ((origin = 'upload') = (storage_key IS NOT NULL)),
  CHECK (origin = 'upload' OR format = 'markdown')
);
CREATE INDEX object_materials_object ON object_materials (object_type, object_id, created_at) WHERE deleted_at IS NULL;

-- 每一版的全文。第 1 版是上传解析出的文字，或 Agent 写的初稿。
CREATE TABLE material_revisions (
  material_id UUID NOT NULL REFERENCES object_materials (id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  body TEXT NOT NULL,
  -- 第 1 版上传时为空；Agent 写的每一版记让它改的人
  requested_by TEXT,
  summary TEXT CHECK (summary IS NULL OR char_length(summary) BETWEEN 1 AND 200),
  agent_run_id UUID,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (material_id, version)
);
```

- 限额：
  - 单个文件 20 MB，类型和解析都复用会议材料的 `parseMaterialBatch`（PDF、DOCX、MD），一次上传一个；
  - 每个对象最多 30 份（不算已删的）；
  - Markdown 正文最多 100,000 字（`MAX_MATERIAL_TEXT_CHARS`）。
- 原件存在现有的材料卷里，路径前缀 `objects/<objectType>/<objectId>/`，和会议材料的存储写法一样。

## 3. 改动怎么算、怎么标

每次 Agent 写一版，服务端拿上一版和这一版按「块」比：

- **块**：
  - 空行隔开的段落是一块；
  - 标题一行是一块；
  - 列表项每项是一块；
  - 表格、代码块整体是一块。
- **比法**：
  - 先按块做最长公共子序列，相同的块不标；
  - 同一个空档里剩下的，前后一一配对，算「改了」，记改之前的原文；
  - 多出来的新块算「加了」，少掉的旧块算「删了」。
  - 「改了」的块里，再按字比一次，给出这一块里具体哪几段字变了。
- 这件事只在服务端算，读的时候按版本现算，不存。

**标注（不显眼）**：

- **改了的句子**：
  - 变了的那几个字下面一道很淡的虚线，颜色取天枢蓝的淡色，不加底色；
  - 点它或悬停，弹出一小块：
    - 「原来：……」；
    - 下面一行灰字：「孙铭泽让 Agent 改的 · 10/5 14:20」。
- **加了的内容**：直接出现，不标（用户原话）。
- **删了的内容**：
  - 在原来的位置留一个很小的灰色「⋯」；
  - 点开看删掉的原文，也写谁让改的、什么时候。
- **材料顶上一行很淡的灰字**：
  - 例如「第 3 版 · 孙铭泽让 Agent 改了 2 处 · 10/5 14:20」；
  - 点开是改动记录：每一版一行，写谁让改的、什么时候、Agent 写的一句说明；
  - 点某一版，就看那一版和它那次的标注。
- **默认显示范围**：只标最新这一版相对上一版的改动。
  - 看旧版本时，顶上写「这是第 N 版，不是最新」，外加「回到最新」。
- 只有上传的第 1 版时，没有这一行，也没有标注。

## 4. Agent 怎么改

「我的 Agent」（CEO Agent 和 DRI Agent 一样）在议题页、执行事项页上多 4 个工具。每次调用都按当前的人和数据库现状查权限：这个人得是这个对象的群成员，议题未建群时得是 CEO。

- `list_materials {}`：这个页面对象的材料，返回 id、文件名、格式、能不能改、当前版本、谁传的。
- `read_material {materialId, version?}`：
  - 全文。Markdown 是正文；PDF、Word 是解析出的文字，最多 100,000 字。
  - 同时返回当前版本号。
- `edit_material {materialId, baseVersion, edits, summary}`：
  - `edits` 是 1 到 20 条，每条二选一：
    - `{find, replace}`：`find` 在当前全文里必须恰好出现一次；
    - `{append}`：加在文末。
  - `summary` 是一句话说明改了什么，最多 200 字。
  - 这些情况一律不写，并把原因和当前版本返回给 Agent，让它重读再改：
    - `baseVersion` 不是当前版本；
    - `find` 找不到或出现不止一次；
    - 不是 Markdown；
    - 改完超长。
  - 写成功后：
    - 新增一版；
    - 在这个对象的群里发一条 Co-Agent 消息：「按孙铭泽的要求改了《版本规划.md》：{summary}」；
    - 返回新版本号和改了几处。
- `create_material {title, body, summary}`：
  - 新写一份 Markdown，文件名是 `title` 加 `.md`；
  - 群里发一条「按孙铭泽的要求新写了《…》：{summary}」。
- 没有删除工具。删材料只能上传者本人在页面上点。
- 页面上下文：
  - `ConversationMessageRequest` 加可选的 `viewingMaterialId`：
    - 网页在看某份材料时带上它；
    - 服务端核对它属于这个 scope 的对象，把 `{id, fileName, version, editable}` 放进 currentObject 的 `viewingMaterial`。
  - 议题 scope 用 `issue:<id>`，执行事项用 `task:<id>`，都是现有的。成员能在议题 scope 上用自己的 Agent，是工单 08 开放的。
- 提示词（`SYSTEM_PROMPT` 和 `driSystemPrompt`）：「只读边界」这一节加一句例外：
  - 只有在对方明确要求修改或新写材料时，才能用 `edit_material`、`create_material`；
  - 只能改 Markdown 材料；
  - 改之前先用 `read_material` 读当前版本；
  - 「这份」「这里」指正在看的那份；
  - 不确定要改哪里时先问；
  - 改完用一句话告诉对方改了什么。
  - 其余写入仍然禁止。
- 群里的 Co-Agent 消息：
  - 在 `threads.ts` 抽一个 `postCoAgentMessage(q, ref, content)`，把 `threadIntro.ts`（工单 08）和 `tasks.ts` 里的私有插入改成用它，只做这一处抽取；
  - 对发消息之外的群成员算未读。
- 审计：沿用对话接口现有的 agent_runs，版本表的 `agent_run_id` 记这次对话的 run id。

## 5. 接口（契约由 Claude 冻结）

`packages/contracts/src/materials.ts`：

- `MaterialObjectType = issue | task`。
- `MaterialView`：
  - 基本信息：`{id, objectType, objectId, fileName, format: markdown | pdf | docx, sizeBytes, pageCount?}`；
  - 来源与主人：`origin: upload | agent`，`owner: {personId, displayName}`；
  - 时间与版本：`createdAt, updatedAt, version`；
  - 权限：`editable`（是不是 Markdown），`canDelete`（我是不是主人）；
  - `lastRevision`：`{version, requestedBy: {personId, displayName}, summary, at} | null`，只有上传的第 1 版时为 null。
- `MaterialListResponse {materials: MaterialView[], canUpload: boolean}`。
- `MaterialChangeSpan {text, changed: boolean}`。
- `MaterialBlock`：
  - 字段：`{text, change}`，`text` 是这一块的 Markdown 原文；
  - `change` 取值：
    - `null`；
    - `{kind: "modified", before, spans: MaterialChangeSpan[]}`；
    - `{kind: "added"}`；
    - `{kind: "removed", before}`。删掉的块 `text` 为空。
  - 修订信息放在响应上，不在每一块上重复。
- `MaterialRevisionView {version, requestedBy: {personId, displayName} | null, summary: string | null, at}`。
- `MaterialDetailResponse`：
  - 字段：`{material: MaterialView, version, latest: boolean, revision: MaterialRevisionView, blocks: MaterialBlock[] | null, revisions: MaterialRevisionView[]}`；
  - PDF、Word 的 `blocks` 为 null，页面用预览地址。

路由：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/materials/{objectType}/{objectId}` | 列表 |
| POST | `/api/materials/{objectType}/{objectId}` | multipart，一个文件；返回 `MaterialView`；超限 413；类型不对 400 |
| GET | `/api/materials/{objectType}/{objectId}/{materialId}?version=` | 详情和标注 |
| GET | `/api/materials/{objectType}/{objectId}/{materialId}/file` | 下载原件；Agent 写的下载当前版 `.md` |
| GET | `/api/materials/{objectType}/{objectId}/{materialId}/preview` | PDF、Word 预览，复用 `renderMaterialPreview` |
| DELETE | `/api/materials/{objectType}/{objectId}/{materialId}` | 本人删；不是本人 403 |

- 不是群成员：一律 404。
- 读列表时不返回全文。
- `ConversationMessageRequest` 加 `viewingMaterialId?: string`（uuid），见第 4 节。

## 6. 页面

用在这几处：
- CEO 议题页 `IssueCard`；
- 成员议题页 `/me/issues/[id]`（工单 08 新做的）；
- 执行事项页 `TaskScreen`。

**材料页签**：照 SSOT C-08 和现有的 `MaterialTabs`（会议页已经在用）。
- 页头下面那颗 32px 小胶囊。
  - 议题页：
    - 现在左侧是 HeroUI 的两个页签「总结与判断」「研究与依据」；
    - 改成这颗胶囊里的前两个页签，内容不变；
    - 后面每份材料一个页签，最后一颗圆形「+」。
    - 这样一个页面只有一层页签，和会议页同一套。
  - 执行事项页：第一个页签「事项」（现在整页的内容），后面是材料和「+」。
  - 材料页签的短名是去掉扩展名的文件名。
- 能上传的人才有「+」。
- 执行事项页没有材料、也不能上传时，不放胶囊。议题页总有前两个页签，胶囊一直在。
- 看哪一份只换左侧，不跳页，每份各自记住滚动位置，沿用 `useRememberedScroll`。

**上传**：
- 点「+」选文件，只收 PDF、Word、Markdown，单个最大 20 MB。
- 上传中页签上显示一个转圈的占位；传好后新页签出现并选中。
- 失败时占位变成红色小字说明，点一下消失。

**看一份材料**：
- 顶上一行灰字：
  - 写谁传的、什么时候，例如「孙铭泽 上传 · 10/5」，Agent 写的是「Agent 按孙铭泽的要求写 · 10/5」；
  - 后面依次是「下载」和「删除」，只有本人才有「删除」，删之前要确认；
  - 有改动时再接一行改动说明（第 3 节）。
- Markdown 按块渲染，用现有的 `react-markdown` 和 `remark-gfm`。连续的列表项还是同一个列表，标注照第 3 节。
- PDF 内嵌预览；Word 显示清理后的 HTML 预览。页头写「只读」，灰字说明：「只有 Markdown 能让 Agent 修改」。
- 右列「我的 Agent」的输入提示，在看材料时改成「让 Agent 改这份材料…」，只对能改的材料这样写。

**更新**：
- 对话流里收到 `tool` 事件，`completed` 且名字是 `edit_material` 或 `create_material` 时，重新取材料列表和当前材料（`useConversation` 已经解析 tool 事件）。
- 群聊里收到 Co-Agent 消息时也重新取。
- 其余时候不轮询。

**样式取自概念版**：
- 顶上那行说明，照 `meeting-artifact.module.css` 的 `.editMark`：11.5px，灰色 #8a95a5。
- 改了的字的虚线：1px dotted，天枢蓝 #3a83f7，透明度约一半。
- 弹出块里「原来：」后面的原文，照个人卡修改建议的 `del` 样式：灰色，不加删除线，免得难读。
- 减少动效时，弹出块不做动画。

## 7. 测试

**API**：
- 上传：成员能传、非成员 404；类型和大小超限；每个对象 30 份上限。
- 删除：本人能删，别人 403；删了以后列表和 Agent 都看不到。
- 比对：改一句、加一段、删一段、调换顺序，块和字的标注都对。
- Agent 工具：
  - 版本冲突；
  - `find` 不唯一；
  - 不能改 PDF；
  - 写成功后新增一版、群里有一条 Co-Agent 消息；
  - 非群成员调用时报找不到；
  - `create_material`。
- 看旧版本。
- 原有测试全部通过。

**Web**：
- 页签和「+」；
- 上传中和失败；
- 删除只对本人显示、删前确认；
- 标注：虚线、点开看原文、删掉的「⋯」；
- 改动记录和看旧版；
- 只读说明；
- 手机 390 宽。

**浏览器（时间机器）**：
- 王路遥在执行事项里上传一份 `.md`；
- 让 Agent 改一句、加一段；
- 协作者打开看到标注和群里的说明；
- 协作者删不了王路遥的材料。
