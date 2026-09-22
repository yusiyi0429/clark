# Ticket 27 · 妙记 Markdown Transcript 导入确认

Type: feature
Status: resolved
Blocked by: none
来源样本（仅本地验收，禁止复制进仓库/证据目录/测试 fixture）：
- 会前材料：`/Users/renhaoliu/Downloads/TKOS 本体结构（M1 范围）｜CEO 对齐稿，当前 v0.8 草稿 2026-09-22.md`
- Transcript：`/Users/renhaoliu/Downloads/26_09_22 本体建模 Part 2.md`
视觉基线：`UpgradeDesign.pen` → `页面 / Meeting 会前预审`（nszdy）中的 `Transcript Import Overlay`（ZeV65）/`Transcript Import Preview`（aB4pK）

## 样本事实（已核对）

- 会前材料：58,710 bytes / 401 行；现有 Markdown Meeting Material 可直接处理，无新增解析器。
- Transcript：79,425 bytes / 1,203 行；妙记 Markdown；396 个 turn；总发言文本 26,440 字；单段最长 677 字；时间从 00:01 到 01:16:31，无倒序、无空段。
- 说话人：刘明华 179、刘人豪 125、白田田 66、于斯一 26；四人均唯一精确命中当前企业知识人员目录。
- 文件头 `2026年9月22日 下午 8:24` 只有分钟精度；最终绝对时间以 Meeting `scheduledAt` 为唯一锚点，turn 相对时间只做 offset。

## 语义决策（已定）

1. 首版只支持规则明确的妙记 Markdown 与既有 `warmap-transcript.v1` JSON；不做通用自由文本 Agent、不做录音、ASR、OCR、姓名猜测。
2. 妙记解析是确定性 adapter：`姓名 mm:ss` / `姓名 hh:mm:ss` + 后续正文；只解析 `### 文字记录` 后内容。
3. exact displayName 只在企业知识人员目录唯一命中时自动映射；0 个或 ≥2 个匹配均标 unresolved，由 CEO 手工选择 personId。
4. 候选是 Meeting 内嵌 Candidate Material（`meetings.transcript_candidate JSONB`），不是新实体；scheduled only，已有 Transcript 时拒绝。
5. 上传 Markdown 只生成候选并 bump Meeting version，不改变 status，不启动 Outcome。
6. CEO 以 versioned opaque Action `meeting.confirm_transcript_candidate` 确认 speaker mapping；同事务补齐 Meeting participants、写标准 Transcript、清候选、status→held、outcome→pending；COMMIT 后启动既有 Outcome Agent。
7. `meeting.discard_transcript_candidate` 清候选；重新上传允许整份替换旧候选并 bump version。
8. 最终 `startedAt = 当前 Meeting scheduledAt + offsetSeconds`。确认时以锁内最新 scheduledAt 计算；保证单调。Web 明示时间锚点。
9. participant 只存企业知识 personId 的既有投影结构；不存在于 Meeting 的已映射人员在确认时加入。lead/CEO 不变。
10. 最终 StoredTranscript 增加可选 `source` 元数据 `{format,fileName,sizeBytes,sha256,parserVersion,timeAnchor}`；旧 JSON/历史行免迁移。原始 Markdown 不在 Card/Action JSON 复制，发言正文已完整保存在标准 turns，哈希用于追溯。
11. Outcome 仍只读最终 Transcript；会前材料不进入会后抽取；Conversation/open item 仍不能创建 Issue。
12. 更新 ADR 0007：允许 CEO 对受限妙记 Markdown 做确定性转换 + 人员目录精确匹配 + CEO 确认；其余边界保持。

## W1 · Parser、契约、迁移、ADR

- 新 `transcriptMarkdown.ts`（或现有最小合适模块）：
  - UTF-8 fatal decode；最大沿用 `MAX_TRANSCRIPT_BYTES=1 MiB`；
  - 标题区必须出现 `### 文字记录`；
  - header regex 支持两段/三段时间，二段解释为 mm:ss，三段为 hh:mm:ss；秒/分范围合法；
  - turn 1..2000，id 确定性 `turn-0001`；文本 trim 后非空，≤20,000；offset 不倒序；
  - speaker 名保留原文 trim；不合并相邻同说话人（保持来源颗粒度）；
  - 结构错误整份拒绝，返回行号与错误码；不保存部分结果。
- contracts：Transcript source、候选投影、speaker mapping、confirm/discard Action input；MeetingCardPayload 加 `transcriptCandidate: ... | null`。
- migration 020：`meetings ADD COLUMN transcript_candidate JSONB`；MeetingRow/columns/projector 全链路。
- ADR 0007 更新；`CONTEXT.md` Transcript 词条同步。
- contract/parser tests（短小合成 fixture，不能复制真实会议全文）。

## W2 · API 候选与确认 Action

- `POST /api/meetings/:id/transcript-candidate`：CEO multipart 单 `.md` 文件；scheduled/no transcript；解析后按 company people exact displayName 建候选；保存全量内部 turns + source metadata，Card 仅投影 speaker summary、turnCount、durationSeconds、sampleTurns、warnings、source。
- 候选内部必须保存每 turn 的 `speakerName/offsetSeconds/text`，确认 Action 不回传全量 turns。
- `meeting.confirm_transcript_candidate`：input 只含 `speakerMappings:[{speakerName,personId}]` + `confirmAddParticipants:true`；校验覆盖全部唯一 speakerName、personId 存在、无一名映射多 person；锁内重新核对 candidate 与 scheduled 状态。
- 事务内用企业知识目录投影补齐 participants，构建 `warmap-transcript.v1`，写 source metadata、held/pending/version/fingerprint，清 candidate；提交后 runOutcome。
- `meeting.discard_transcript_candidate`：scheduled only，清 candidate、version+1、fingerprint。
- 现有 JSON multipart immediate import 与 DRI service import行为不变；现有危险替换仍只收标准 JSON，本票不做 Markdown 替换。
- 测试：解析成功、unresolved、重复 displayName、unknown 手工映射、参与人补齐、版本冲突/幂等、discard、重上传替换、确认后 Outcome 启动；失败不改 Meeting。

## W3 · Web 预览确认

- Header 按钮改「导入会议记录」，文件 accept `.md,.json`：JSON 走旧 immediate import；MD 走 candidate endpoint。
- Card 收到 `transcriptCandidate` 后自动/显式打开 Preview dialog（设计 aB4pK）：
  - turnCount、speakerCount、duration、fileName/size/hash；
  - 人员映射表：已是 participant / 确认后加入 / unresolved 下拉；
  - 时间锚点（Meeting scheduledAt + 首末 offset）；
  - 服务端给出的抽样 turns；
  - warning/error；
  - 取消仅关闭；另提供“清除候选”；确认按钮仅全部映射有效时可用。
- 确认走 `useCardAction` opaque Action；不把全量 transcript 放进浏览器 Action input。
- a11y：dialog、焦点、错误 role=alert、文件按钮 label；不增加依赖。
- Web tests：MD/JSON 分流、mapping payload、未解析禁确认、candidate 恢复、清除。

## W4 · 验证与 staging

- typecheck ×3；contracts/web/API 全量（API `--maxWorkers=1`）。
- staging rebuild api+web；用合成临时 Meeting/短 Markdown 做 upload→preview→confirm→held→Outcome journey，做完删除自己创建的数据和文件。
- **真实本地样本只 dry-run parser，不上传、不落库**：断言 396 turns、4 speakers 计数、首 offset=1、末 offset=4591、无 warning、四人 exact 映射；输出只记录数字，不保存正文。
- 浏览器 1440×900 与 2560×1440 验 Preview dialog，无横向溢出。
- 每 W 一个 commit，不 push；更新 ticket/map。

## 边界

- 不支持任意会议纪要格式、DOCX/PDF Transcript、别名词典或模糊匹配。
- 不改会前 Material 解析；不把 Material 喂给 Outcome。
- 不新增 Transcript 实体/文件库；不做 Transcript 独立下载（source metadata 留痕即可）。
- 不把真实样本内容提交 Git；不改用户原文件。

## Comments

- 2026-09-22 resolved。W1 `2c58e75` 契约（`TranscriptSource` / 候选投影 / speaker mapping / confirm·discard input、`MeetingCardPayload.transcriptCandidate`）、migration 020 `meetings ADD COLUMN transcript_candidate JSONB`、确定性 parser `transcriptMarkdown.ts`、ADR 0007「受限的妙记 Markdown 例外」、CONTEXT.md 词条；W2 `00550ac` `POST /api/meetings/:id/transcript-candidate` 与 opaque `meeting.confirm_transcript_candidate` / `meeting.discard_transcript_candidate`；W3 `cb7575d` Web Header 入口按扩展名分流（.md 候选 / .json 旧直导）+ aB4pK 预览弹层（映射表 / 时间锚点 / 抽样发言 / 未映射禁确认 / 清除与确认）。
- 验证：typecheck ×3；contracts 33、web 141、API 351（`--maxWorkers=1`）全过；真实样本仅本地 parser dry-run——396 turns、4 speakers（刘明华 179 / 刘人豪 125 / 白田田 66 / 于斯一 26）、首 offset 1、末 offset 4591、0 倒序、无 warning、四人 exact 唯一映射，未上传、未落库、未提交真实正文。
- staging 重建 api+web（迁移 020 已应用）后用临时合成 Meeting + 短 Markdown 跑完 journey：upload 返回候选（status 仍 scheduled、transcript/outcome 为 null、version 2，DB 内保存全量 4 turns + source）；confirm 后 participants 补齐为四人、写入 `warmap-transcript.v1` 且带 `source`（timeAnchor=锁内 scheduledAt）、`startedAt = scheduledAt + offset`（5s / 90s 校验通过）、候选清空、Outcome 启动并落 `ready`（status 派生 reviewed）；journey 后删除临时 Meeting、其 `agent_run` 与临时文件，真实 Meeting 恢复原样。
- 浏览器 1440×900 与 2560×1440：预览弹层自动打开，`dialog` 与 `body` 无横向溢出。现有 JSON immediate import、DRI service import 与 held/reviewed 危险替换行为未改。

- 2026-09-22 收尾修复（1A + 2A）：`executeCancelMeeting` 在同一事务把 `transcript_candidate` 置 NULL（取消为终态，避免候选成为孤儿）；新增 API 测试「scheduled 有候选后 cancel → Card/DB candidate null、actions 空，且 title / scheduled_at / participants / issue_ids / preflight / draft / materials 逐字段不变」；`packages/contracts/src/openapi.ts` 登记 `POST /api/meetings/{id}/transcript-candidate`（multipart 单 `file`、200 `CardCollection`、400/401/404/409/413、`operationId: uploadMeetingTranscriptCandidate`），contract test 断言该路径、operationId 与响应集合；`pnpm --filter @warmap/web gen:client` 重生成 `openapi.json` / `schema.d.ts`（未手改）。验证：typecheck ×3，contracts 34、web 141、API 352（`--maxWorkers=1`）；staging 重建 api+web 后 `/api/healthz` ok、3 战场 / 7 能力 / 11 核对项 / 真实 Meeting 未变；合成临时 Meeting 跑通 upload→cancel（DB candidate null、其余列不变），journey 后删除临时 Meeting 与临时文件，真实 Meeting 保持 scheduled / v15 / 无 transcript、candidate、outcome。
