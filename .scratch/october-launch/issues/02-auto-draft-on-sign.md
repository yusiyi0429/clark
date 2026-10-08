# 02 · 签发即起草任务卡并推给本人；战场参与者名单

Type: implementation
Status: ready-for-agent
Blocked by: —（与 01 并行；联调时需要 01 的个人复盘数据）

## 背景

用户 10/6 决定（决定记录：项目文档 `claude/决策记录_10月上线与协作批注_2026-10-06.md`）：

- CEO 签发月度目标后，Co-Agent 为每个战场的参与者起草任务卡，**起草完直接交给本人确认**。取消战场 DRI 的「整理任务卡草稿」和「交给本人确认」两步。
- 之后不变：全员本人确认 → Co-Agent 组合核对 → **战场 DRI 确认**。
- 拿卡的人 = 这个战场的**参与者**（不只是上月有 Mission 的人）。参与者名单在战场配置里维护。CEO 不拿卡。
- 起草依据增加「已知的 10 月任务」：王创峰在飞书写好的 10 月卡；刘人豪、于斯一以本体 world-02 上已建的 3 个 Mission 为底（renhao-202610-b、renhao-202610-c、siyi-202610-1）。

这是对 ADR-0022 与 `docs/contracts/mission-card-preparation-review.v0.1.md`「战场 DRI 从准备进度入口交给本人确认」的变更，需新增 ADR 并改该口径文档。

## 要做什么

### A. 参与者名单

- `battlefield_config` 加 `participant_ids jsonb NULL`。NULL 表示没设过：按「上月在本战场有 Mission 的人」推算（即现有 `draftOwners` 的规则）。CEO 存过一次就以存的为准。
- 战场配置页加「参与者」：从人员目录多选，默认显示推算结果并注明「按上月 Mission 推算」。
- 起草名单 = 参与者，去掉角色含 `ceo` 的人。现有 `draftOwners` 改为读这个名单。

### B. 签发即起草、起草完即交给本人

- `executeSignMonthlyPlan` 提交成功后，对计划里有本月结果的每个战场，以**系统身份**启动起草（从 `executeDraftMissionRound` 抽出不校验 DRI 身份的内部函数；签发重放不重复启动；已有轮次的战场跳过）。
- `completeMissionRoundDraft` 结束时：本轮没有起草失败，就以系统身份执行现有 `open` 的同一套检查与写入（目标快照、每卡至少一项任务），本人随即在通知里看到自己的卡。
- 有人起草失败：轮次停在草稿，失败的人在 CEO 与战场 DRI 的进度里可见，可点重试（沿用现有重试）。重试全部成功后同样自动交给本人。
- 删除 DRI 首页 / 通知里的「整理任务卡草稿」入口和「交给本人确认」按钮；DRI 在本人准备阶段只看进度，最后的「确认任务组合」不变。
- 动作留痕写「CEO 签发后系统起草」「起草完成后自动交给本人」，不冒充 DRI 的操作。

### C. 签发页

- 签发确认框按战场列出「签发后为这些人起草 10 月任务卡并直接发给本人」，每个战场一行名字，带「改参与者」链接到战场配置。名单为空的战场标出来，签发不拦。

### D. 起草依据：已知的 10 月任务

- 读 `seed/imports/2026-10-known-missions.json`（路径走环境变量，和 `draftsDirectory` 一样只读挂载）。`kind: feishu` 的条目已有原文 markdown（王创峰）。
- `kind: world-02` 的条目 `markdown` 还是空的：**今天**用现有 world 客户端从当前 world-02 实例导出这 3 个 Mission 的定义块与计划块，写成 markdown 填进文件（10/8 本体会重建实例、重发 id，所以要在重建前导出；内容为准，id 之后再用 `world:link-missions` 对上）。导出不到就把条目留空并在 Comments 说明，起草照常进行。
- 起草输入新增 `knownMissions`（按 personId），提示词：有已知任务时以它为底，沿用它的拆分和标题，按已签发的目标、上月任务卡与复盘、起草规范补全和修正；不要另起一套。

## 不做

- 不改本人准备、组合核对、DRI 确认、确认后更正的任何规则。
- 不做逐人提前推送（整个战场起草完才一起交给本人）。

## 完成定义

- 测试：签发后各战场自动起草；全部成功自动进入本人准备；部分失败停在草稿、重试成功后自动进入；签发重放不重复起草；参与者名单为空时按上月推算、存过后按名单、CEO 被排除；DRI 不再看到整理 / 交给本人入口；起草输入带上已知任务。
- 浏览器：CEO 签发 → 看到起草进度 → 成员收到自己的卡；手机 390 宽看签发确认框和战场参与者编辑。
- 真实模型在临时库上跑一次战场 01（含于斯一、刘人豪），记录起草耗时与结果，贴进 Comments。
- 契约改动后重新生成客户端；API / Web 类型检查与相关测试通过；新增 ADR，改口径文档。

## Comments

### 2026-10-08 · 实现（分支 feat/october-launch-02，待合并与浏览器验收）

做了什么

- 迁移 057：`battlefield_config.participant_ids jsonb NULL`。起草名单 `missionCardParticipants`：NULL 时按原 `draftOwners` 规则推算（上月本战场的任务卡 Owner + 上月/本月本战场的 Mission Owner），存过以名单为准（空数组 = 没人拿卡），去掉角色含 `ceo` 的人和人员目录外的人。`GET /api/config/battlefields` 每个战场返回 `participantIds`、`participantsDerived`（推算按最新一份月度计划的月份，月底签下月计划时与起草一致）；`PATCH` 接受 `participantIds`，必须在人员目录里（`INVALID_PARTICIPANT`）。
- 签发即起草：`monthly-plan.sign` 提交成功且不是重放时，路由调用 `startSignedMissionDrafts`：逐战场锁战场行，已有轮次跳过、名单为空跳过，建 `drafting` 轮次（`action_fingerprints` 为空，`draft_source.trail` 记 `{ by: "system", text: "CEO 签发后系统起草" }`），后台起草；起草没能开始只记日志，不影响签发结果。`executeSignMonthlyPlan` 本身未改。
- 起草完成：本轮没有失败 → 同一事务里用与 DRI「交给本人确认」共用的 `openForOwners`（已签发目标、每卡至少一项任务、冻结目标快照）交给本人，留痕「起草完成后自动交给本人」；检查不过（如战场缺六个月目标）→ 停在草稿，原因写进 `draft_source.openProblem` 并作为 CEO/DRI 的待办句，补齐后战场 DRI 用原交付动作手动交给本人。有人失败 → 停在草稿，准备进度里标「起草未完成」，战场 DRI 点「重试起草」（沿用 `mission-round.draft` 重试），重试全部成功后同样自动交给本人。卡的群组时间线按留痕原文显示这两步，不记成任何人的操作。
- 删除入口：首页与 CEO 只读 MCP 待办里的 slot（`listMissionRoundDraftCards`、`mergeMissionRoundCards`）、引导「可以整理任务卡草稿」、通知栏的整理流程与 `missionRoundDraft` 深链、契约 `MissionRoundDraftPayload`。正常流程里 DRI 看不到「交给本人确认」；它只在自动交付被检查拦下或人工导入占位草稿时出现。
- 起草依据：`MISSION_CARD_KNOWN_MISSIONS_FILE`（`.env.example`、compose 只读 seed 挂载、`server.ts`），只取月份与轮次一致、有 markdown 的条目，按 personId 进起草输入 `knownMissions`；提示词加「以它为底，沿用拆分和标题……不要另起一套」。王创峰的飞书条目会进入 10 月起草输入。
- Web：签发确认框（勾选「我确认签发」后）按战场列名单，月份取计划月份，名单为空标出来，签发不拦，「改参与者」打开战场配置并直接展开该战场的编辑；签发成功后刷新首页，通知栏随即出现起草进度。战场编辑弹层加「参与者」多选（不列 CEO，没保存过时注明「按上月 Mission 推算」，没动过不保存），≤599px 时弹层贴卡片两侧。草稿阶段的状态句、计时标签与成员战场页不再写「下发 / 整理」。
- 文档：新增 ADR-0026；ADR-0022 开头加更新说明；`docs/contracts/mission-card-preparation-review.v0.1.md` 改「状态与权限」口径；`CONTEXT.md` 战场配置与轮次条目。

验证（本机 Postgres 16，`TEST_PG_URL=postgres://postgres:postgres@localhost:54329/postgres npx vitest run …`）

- API 24 个文件 202/202：missionRounds 25、missionDraftHome 2、missionCardNotices 4、personalReviews 10、config 23、monthlyPlanSign 10、migrate 6、missionCardDraftAgent 7、ceoMcp 3、personalMcp 3、onboarding 7、missionRoundRoutes 3、missionCardPreparation 12、personalMissionCards 21、journey 9、missionCardOwnerReview 13、missionRoundReview 8、missionCardAnnotations 12、missionCardCorrections 10、memberHome 5、personalMissionCardContext 2、missionCardAgentTools 3、missionRoundScheduler 2、missionRoundGuards 2。新增用例覆盖：签发后各战场按参与者起草并自动交给本人、重复启动/签发重放不再起草（HTTP 重放与函数重入两种）、部分失败停草稿且 CEO/DRI 都看得到、DRI 重试成功后自动交付、自动交付检查不过停草稿并给原因、名单推算/保存/CEO 排除、`knownMissions` 进输入且缺文件照常起草、首页与引导没有整理入口、DRI 动作里没有交给本人。
- Web 51 个文件 491/491（config、cards、lib、missionCards、member、onboarding、shell、通知栏相关）；contracts 8 个文件 74/74。
- 类型检查：contracts / api / web 通过；`pnpm --filter @warmap/web gen:client` 已重新生成客户端。

没验证

- world-02 导出：本沙箱没有 world-02 凭据和网络，renhao-202610-b、renhao-202610-c、siyi-202610-1 三条的 markdown 仍为 null；起草照常进行，这两人按签发目标、上月任务卡与复盘起草。需在本体重建前另行导出填入文件。
- 真实模型跑战场 01：沙箱没有模型凭据，只用假 Agent 跑通流程，起草耗时与质量未记录。
- 浏览器（CEO 签发 → 起草进度 → 成员收到卡；390 宽签发确认框与参与者编辑）：未做，由合并后验收。

后续

- 签发后才补参与者的战场不会自动起草，产品内也没有补起入口；签发提交到建轮次之间若进程中断同样不会补起（ADR-0026 限制）。
- 三个战场同时起草，模型并发约等于参与者总数（10 月约 12 人）。
- `MISSION_CARD_DRAFTS_DIR` 现已无代码读取，可另行删除。

### 2026-10-08 world-02 导出（本机）

- 用 `WorldClient` 只读 `GET /v1/world/objects?type=Mission` + `GET /v1/world/objects/{id}` 从当前 world-02 实例（scope `a92430fd…`，eo 域 `88674067…`，即 10/1 按 Content Pact 重建的 v0.6.x 实例）取到 3 个 Mission，标题与负责人都对得上：renhao-202610-b = `f3f9bbd7…@2`、renhao-202610-c = `82c852a2…@2`、siyi-202610-1 = `7885a696…@2`。三个都还没有 `mission:<编号>` 外部引用。
- 本体上只有「战役定义」块有内容（outcome + acceptance_criterion）；「Mission 计划」「Task 全景」块都是空的。导出的 markdown 按「战役定义 / Mission 计划」写，计划写明「本体上暂无」，填进 `seed/imports/2026-10-known-missions.json` 两条 `kind: world-02`（同时补了 `title`、`sourceRef`）。原始对象存档 `.scratch/october-launch/evidence/world-02-missions-2026-10-08.json`。
- 发现：`apps/api/config/world-instance.json` 仍是 9/29 实例的 id（scope `1e8552e2…`、eo `280fb9c9…`），按它列 eo 域对象返回 404，`world:link-missions` 会失败。需换成 `.scratch/tkos-world-02/ids-v0.6.0.json` 的 id 后才能关联（待 Sean 定）。

### 2026-10-08 浏览器验收（时间机器，一次性测试库，合成身份，不连模型）

时间机器加了 `TM_PLAN_STAGE=negotiating`（`bce8fab`）：签发即起草后，原 fixture 启动时签发会与自动建的轮次撞唯一约束。

通过：
- 勾「我确认签发」后按战场列名单：灯塔项目 孙铭泽；团队协作 何望舒、孙铭泽；产品战场「名单为空」标橙。「改参与者」打开 `/config/battlefields?battlefieldId=product`，直接展开该战场编辑框，参与者注明「按上月 Mission 推算」。
- 签发后：灯塔项目、团队协作各建一轮（留痕「CEO 签发后系统起草」），产品战场名单为空没有建轮。
- 起草失败（时间机器没有模型）：CEO 通知栏两张进度卡「未交给本人确认」，每人「起草未完成」；团队协作（DRI = 验收 CEO）气泡里有「重试起草」，点了产生新的 attempt（又因无模型失败，符合预期）；灯塔项目（DRI = 林知行）气泡里 CEO 没有重试按钮。
- 390 宽：战场编辑框贴卡片两侧，参与者多选排得下；签发名单区可读。

发现（未改）：
- CEO 卡片列表里非本人负责战场那一行仍写「起草未完成，**可重试**」，CEO 实际不能重试。
- 390 宽：计划页签发区（`.commitArea`）不换行，「我确认签发…」被挤成一字一行，说明文字与卡片左侧被裁约 13px。签发区布局为原有问题，非本工单引入。
- 战场编辑框「保存」按钮无样式（`battlefield-management.module.css` 的 `.cancel,.danger` 共用规则漏了 `.save`，9/22 起就有）。

未验：起草全部成功后自动交给本人、成员收到卡（需要真实模型）。
