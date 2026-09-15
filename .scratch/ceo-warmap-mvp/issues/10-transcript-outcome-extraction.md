# 10: 导入 Transcript 并抽取 MeetingOutcome

Type: implementation
Status: resolved
Blocked by: 09 完成 Meeting 创建与会前准备

## What to build

让 CEO 或集成客户端向 Meeting 导入严格结构的 Transcript，成功后进入 held 并抽取可追溯的 MeetingOutcome Candidate Material。

## Acceptance criteria

- [x] Web 与服务接口只接受 `warmap-transcript.v1`，并执行相同的认证、大小限制和 schema 校验。
- [x] 重复 turn ID、未知 speakerId、空文本、时间顺序或其他必填错误导致整份拒绝且不改变 Meeting。
- [x] 有效 Transcript 在一个事务中保存并把 scheduled Meeting 变为 held，提交后才启动 Outcome 抽取。
- [x] 每个 Outcome item 绑定准确 turnId，quote 必须连续存在于被引用 turn，而非仅存在于全文其他位置。
- [x] owner、CEO judgment 和权限类型依据 Person/speaker 确定性校验，未知身份不能产生组织效果候选。
- [x] 抽取失败保留原始 Transcript，页面展示失败原因并允许 CEO 显式重试。
- [x] Transcript 替换只允许不存在 confirmed effect 时经危险 Action 二次确认；替换使旧 candidate 和 actionId 失效并重新抽取。
- [x] 不实现录音、ASR、说话人猜测、格式转换或部分导入。

## Comments

实现：`packages/contracts/src/transcript.ts`（`WarmapTranscript`/`PostMeetingCandidate`/`MeetingOutcomeState`/`ReplaceTranscriptRequest.confirmReplace`）；`apps/api/migrations/009_meeting_transcript_outcome.sql`（`meetings.transcript`/`outcome` JSONB）；`apps/api/src/outcome.ts`（整份校验、候选确定性校验、`runOutcome`、启动恢复、`hasConfirmedEffect`）；`apps/api/src/postMeetingAgent.ts`（HEAVY 严格 Candidate Tool）；`apps/api/src/meetings.ts`（`importTranscript`、危险替换、显式重试、Card Action）；`apps/api/src/app.ts`（CEO multipart 与 service API 共用一个导入边界，413 映射）；`apps/api/src/server.ts`（启动恢复）。

验证：`apps/api/test/transcript.test.ts` 25 条（两入口同边界、8 类整份拒绝、双入口大小限制与鉴权、跨 turn quote 拒绝、owner/CEO/issueId 校验、失败保留 Transcript + 显式重试幂等、替换失效旧 candidate/actionId、confirmed effect 阻断替换、缺二次确认 400、启动恢复）；`apps/api` 159 passed、`@warmap/contracts` 18 passed、三包 typecheck/build 通过、`git diff --check` 干净。注意本机默认并行 `pnpm test` 的 5s 超时为既有环境现象，串行参数下基线与改动后均全绿。

Herdr review：pi/deepseek-flash 只读 reviewer 两轮，Standards + Spec 双轴无 blocking；已修复 4 项非阻塞发现（`confirmReplace` 二次确认、`agent_runs.object_ref`、DRI 路径 OpenAPI 413、恢复清 `startedAt`），F1/F5/F6/F7/F8 按 YAGNI 或既有模式明确不做。

延后边界：逐项确认/忽略/撤回（Ticket 11）与 Web 上传/替换状态（Ticket 14，调用 `meeting.replace_transcript` 必须带 `confirmReplace: true`）；本票不实现录音、ASR、说话人猜测、格式转换或部分导入。
