# 02c 会后闭环：录音 → 纪要与 Action Item → 推给负责人 → CEO 只确认战略项

状态：进行中（2026-09-26）

## 用户确认的规则

- **录音**：今天就接火山引擎录音文件识别。流程是浏览器录音 → 上传 → ffmpeg 转 mp3 → 传 TOS → 识别（带说话人分离）→ 生成会议记录候选 → 对应说话人 → 确认。
  - 实现照搬概念版 `clark-main/src/lib/recording/`。
  - 配置项 `VOLC_ASR_API_KEY`、`VOLC_ASR_RESOURCE_ID`、`TOS_*` 已从概念版复制到 `apps/api/.env`。模型已从 1.0（`volc.bigasr.auc`）切到 2.0（`volc.seedasr.auc`），2026-09-27 实测通过。
- **Action Item**：
  - 抽取完成后直接推送，生成负责人的执行事项，并发一条通知。
  - 负责人可以退回，退回要写原因，同时通知主持人。
  - 没有明确负责人的，给这场会的主持人。
- **CEO**：
  - 默认不推送任何东西。
  - 只有抽取判定为战略议题的，才出现在 CEO 通知栏：标题加一两句话，按钮「确认」「不同意」，不用点进去。
  - 确认后交给 Co-Agent 更新本体，今天先写一条「待更新本体」，由 co-agent 同事接。
  - 不同意就不更新，并通知主持人。

## 分工

- **我们**：
  - 录音与识别接入；
  - 推送、执行事项、通知；
  - CEO 确认卡；
  - 纪要页；
  - 两个 Agent 的接口与流水线。
- **co-agent 同事**：
  - 会后理解 Agent（`PostMeetingAgent` 接口背后的实现与评测）；
  - 本体更新 Agent（`OntologyUpdater` 接口背后的实现）；
  - 以后的会中 Co-Agent。

## 后端 B1：执行事项、推送、通知、战略项（子代理）

- **迁移 `026_tasks_and_notifications.sql`**：
  - `tasks` 和 `task_members` 按 spec §3.1，另加以下字段：
    - `origin_meeting_id`、`origin_item_id`、`source_quote`，并对 `(origin_meeting_id, origin_item_id)` 加唯一约束；
    - `created_by`；
    - `return_reason`；
    - `status` 增加 `returned`。
  - `notifications` 按 spec §3.1。
  - `ontology_update_requests` 记录待更新本体的请求：来源会议与条目、标题、说明、状态 `pending | applied | failed`、结果。
- **抽取契约**：
  - 新增 kind `strategic`：`title` ≤40 字，`brief` 一两句 ≤120 字，外加 `judgmentKind`。任何人的发言都可以。
  - `todo` 可以带 `dueDate`。
- **自动推送**：抽取完成时，每条 `todo` 生成一条执行事项，条目自动记为已确认（effect `task:<id>`），并给负责人发 `meeting_action_assigned`。
  - 没有负责人的，给主持人。
  - 负责人是 CEO 的，不推送（CEO 默认不接收），只留在纪要里。
- **战略项**：
  - 等 CEO 处理。「确认」复用 `meeting.confirm_item`：写入 `ontology_update_requests`，再调用 `OntologyUpdater`（默认不做事，保持 pending）。
  - 「不同意」复用 `meeting.dismiss_item`：给主持人发 `strategic_rejected`。
- **成员接口**：
  - `GET /api/me/home`；
  - `PATCH /api/me/tasks/:id`，改状态；
  - `POST /api/me/tasks/:id/return`，请求体 `{version, reason}`；
  - `GET /api/me/notifications`；
  - `POST /api/me/seen`。

## 后端 B2：会议录音与识别（子代理）

- **迁移 `027_meeting_recordings.sql`**：录音记录，状态依次为 recording、uploading、transcoding、transcribing、done，失败为 failed。
- **接口**：
  - 开始录音；
  - 按序号上传分片；
  - 结束，后台异步执行拼接 → ffmpeg → TOS → 识别 → 轮询 → 生成会议记录候选（`source.format = volc_asr`，说话人为「说话人 1」……），然后沿用妙记那条确认映射的路径；
  - 查询状态。
- 会议卡片带上最近一次录音的状态。重启后恢复轮询。

## 前端（我）

- **开始会议**：请求麦克风并开始录音，每 10 秒上传一片。不给麦克风权限时照样计时，状态行写明没有录音。
- **这场会开完了**：停止录音、传完、结束录音，然后记为已开完，默认打开会议记录，显示转写进度。候选到了自动弹出说话人对应。
- **会议记录页改成纪要**：
  - 摘要；
  - 会议共识（决定）；
  - 按负责人分组的 Action Item，带推送状态；
  - 提给 CEO 的战略议题，带确认状态。
- **CEO 通知栏**：「需要你确认」一栏，内容是标题、一两句话和两个按钮。
- **成员 `/me`**：
  - 我的执行事项，可标完成、可退回；
  - 通知栏显示「新执行事项」和「退回」提醒。

## 验收

- API：推送、退回、战略确认与不同意、通知、录音流水线（外部服务用假实现）都有测试。
- 网页：组件测试通过。
- 浏览器：CEO 走一遍会议页和通知栏；成员（127.0.0.1）看自己的执行事项和通知。
- 真实语音识别：用一段短录音做一次冒烟测试。

## 进度（2026-09-26）

- 后端 B1（执行事项、推送、通知、战略项）完成，迁移 026。CEO 负责的待办不推送，会议留在 held，直到 CEO 在会议页处理。
- 后端 B2（录音与识别）完成，迁移 027。真实冒烟测试已通过：合成的两人对话约 27 秒，5 秒转完，两个说话人分对。
- 前端完成：
  - 录音接进「开始会议」和「这场会开完了」，刷新后接着上一片的序号继续录；
  - 会议记录页显示转写进度，转完自动弹出说话人对应；
  - 纪要页；
  - CEO「需要你确认」；
  - 成员 `/me` 的执行事项与通知。
- **部署时要做**（第 6 步）：
  - Dockerfile 加 `RUN apk add --no-cache ffmpeg`；
  - 线上配置补上 `TOS_*`、`VOLC_ASR_API_KEY`、`VOLC_ASR_RESOURCE_ID`、`MEETING_RECORDING_STORAGE_DIR`（挂卷）；
  - API 能出网访问 TOS 和 `openspeech.bytedance.com`；
  - TOS 桶保持私有，并加生命周期规则。
