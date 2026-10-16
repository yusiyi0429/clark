# Inception → MVP 回迁总图（2026-10-15）

来源：`tkos-inception` 的 master 分支（7906d68）。它直接复用了 MVP 的 dac9986，之后 10/09–10/14 新增约 220 个功能/修复提交。
落点：分支 `feat/inception-ceo-port`（从 origin/main 6b54c62 切出），工作树 `../Tianshu-MVP-ceo-port`。
原则：只搬 CEO 侧、跟具体演示无关的改动。DEMO_MODE、demo-api、demo_* 表、演示资料与客户代号一律不带。迁移编号顺延到 060 之后。

## 一、确定采用（直接搬）

| # | 内容 | 主要来源 | 备注 |
|---|---|---|---|
| A1 | 排印 `--doc-*`（16/13/12、两档字重、三级墨色）、`--touch-hit` 44px（仅 ≤959 或触屏）、手持/折叠/三折叠的点触与页头折行 | globals.css、handheld-* 样式 | 不含 `--field-*`（见 Q10） |
| A2 | 外壳：Esc 链、返回栈（修“后退后点 × 卡在加载中”）、DetailPanel 按版本防旧卡覆盖、DetailFrame backLabel | shell/escapeChain、returnStack | |
| A3 | SegmentedSwitch、lib/markdown（修中文旁加粗不生效）、toast / undoWindow / motion | | |
| A4 | CEO 可见的 LTO/PO 改为中文“长期目标 / 本月目标”（ceoTerms 显示层，原文不动） | lib/api/client.ts、displayText | 只用于 CEO 路径；DRI 侧见 Q11 |
| A5 | 雷达：抓原文全文与配图、封面图与图片代理、同文去重、升级议题前查重、默认按重要度排序加组合筛选、未评估如实标注、移出后 5 秒撤销 | radar/signals/articleText/signalCover/radarDedupe、RadarCard/SignalCard/SignalArticle | 封面抓取改为逐跳复核，补上 SSRF 漏洞 |
| A6 | 对话：流式匀速上屏、滚动控制、放大或收起不卡顿、深度讨论台（取 inception 最新版）、句末出处标记加依据面板、回答末尾选项、历史“加载中 / 无记录 / 失败可重试” | conversation/** | 去掉 demo 提案与直接写入 |
| A7 | 对话后端：出错就地恢复与“继续 / 重新回答”、修网关 503（不回传早先轮次的条目身份）、新对话与归档、后台滚动压缩（修“Nothing to compact”导致对话永久失效） | conversationRecovery/Compaction/Stream | 压缩模型可配置，默认沿用 COMPACTION_MODEL |
| A8 | 语音听写：腾讯实时识别加两段式整理（沿用 feat/port-inception-input，换成 inception 最新版） | dictation* | |
| A9 | 富内容块：公式、指标对比、时间线、多泳道路线图 | richBlocks | 自由图示 visual 见 Q6 |
| A10 | 会前预审 v4：读会议和议题群的最新材料与讨论；不再强制凑 3–5 题；依据追溯到版本和段落；资料变化提示报告过期；预审转后台并显示真实步骤 | meetingPreflight/meetingEvidence/preflightStaleness/preflightProgress | 对应王总反馈 12、18、22 |
| A11 | 议题历史分层（仍有效 / 此后的变化 / 本次待判断）、依据直达材料原段落、固定目录、会后主决定与子决定、左栏卡与会议页双向同步 | issueDecisionHistory、SourceViewer、MeetingOutline、meetingSync | 对应王总反馈 9、10、13、14 |
| A12 | 议题页：排印重排、判断依据移到最后、去掉“决策路径 / 移出”两节、更多菜单（加入已有会议、移出议题）、雷达来源小标签 | IssueCard、IssueMoreMenu、OriginTag | 跟 inception 一起去掉议题页的“安排一场会议”（反馈 16：收敛一号位操作）；“组织配置”里仍可新建会议 |
| A13 | 月度计划：改一个战场只把这个战场退回“未核对”的修复；计划和复盘页的中文用语 | monthlyPlans、monthlyReview | |
| A14 | world 客户端：健康检查改 `/v1/health`（旧 /healthz 已经 503）、实例按配置切换、凭证可从文件读取 | worldClient | 不碰 MVP 的写回 |
| A15 | 杂项：确认卡错误文案中文化、确认后刷新、去掉“AI 建议 / 模拟”标签、书面化文案、网页代理超时放宽 | | |

## 二、待你决定

| # | 事项 | 取舍 |
|---|---|---|
| Q1 | 首页战场卡改成“决策 / 战况”翻转卡，加集团块和首页雷达信号流 | 战况面的指标、判断、卡点只来自演示表，MVP 没有对应数据，搬过来战况面是空的。翻转版还去掉了卡上的 Missions 列表。建议先不做，等有真实数据源再做 |
| Q2 | 首页去掉月度计划入口、左栏去掉月度协商和任务卡组 | 这是客户“只定半年目标”的决定；MVP 的 DRI 月度流程要靠这些入口。建议不跟 |
| Q3 | Agent 在对话里直接改业务数据，事后可撤销 | inception 是演示专用的一套表和写入；MVP 现在是先出确认卡、再生效。要的话得在 MVP 的 Action 上重写 |
| Q4 | 对话按问题分档选模型（快答 / 检索 / 深度，默认 Claude Sonnet / Opus），思考摘要实时译成中文显示 | 回答质量和过程可见性更好；成本和延迟上升，DRI 的对话也会走这套 |
| Q5 | LangSmith 轨迹按明文上报系统提示和业务正文 | 排障方便；企业知识和会议正文会发到第三方 |
| Q6 | 对话里的自由图示 visual（模型生成的脚本，在沙箱 iframe 里运行） | 表达力强；需要做一次安全评审 |
| Q7 | 会议页整体按议题重排，CEO 在议题块里直接拍板 | 王总反馈 15 要的就是这个；inception 只在演示模式开放拍板；MVP 的会议由主持 DRI 操作。另外和你在途的 fix/world-meeting-missions 冲突 |
| Q8 | 议题指派主责人（通知被指派人并拉进议题群） | 给 DRI 新增一类角色和通知 |
| Q9 | 月度计划分步确认、去掉普通待办、签发后的“任务卡”进度页 | 改变 DRI 流程：CEO 在 DRI 确认前就能看卡，还能按批注触发重写；战场页的待办和复盘输入会变空 |
| Q10 | 全站输入框、下拉、日期统一成对话输入条的样式 | 观感统一；DRI 端和登录页一起变样，文字框的聚焦外框没了 |
| Q11 | 用语：DRI→负责人、“我的 Agent”→“天枢”、引用→批注、“一号位”的称呼 | 会改到 DRI 端；“批注”和任务卡上已有的批注重名 |
| Q12 | 本体只读接入：本体里的公司、战略、战场目标进入 Agent 上下文；正式实例和 TK 实例配置 | 需要先确认 MVP 的本体映射 |
| Q13 | “已处理”归档页 | 依赖会后流转模块 |

### 待定项在分支里的默认处理（等你回复后再按决定调整）

- Q1、Q2：首页、首页战场卡、左栏保持 MVP 原样。左栏另外带上 inception 的雷达来源标签、书面化措辞，会前预审进行中时 5 秒刷新一次。
- Q3：去掉 inception 的直接写入、撤销和提案卡。
- Q7：会议页按议题重排、吸顶目录、依据直达都搬过来；议题块里的拍板按钮不放（决定照旧由会后结论确认）。
- Q8：不加“指派”，议题页页头恢复“邀请成员”。
- Q9：月度计划页保持 MVP 原样。
- Q10、Q11：DRI 端（成员工作台、执行事项、任务卡、导览、首次引导、登录页）保持 MVP 原样。会话里“引用→批注”这一处是共用组件，跟着 inception 改了。
- Q13：不搬“已处理”页。
- Q4：分档路由保留，但不配 `CONVERSATION_MODEL` 时三档都用 `HEAVY_MODEL`；后台压缩只用 `COMPACTION_MODEL`。不配置就不会调用 Claude。
- Q5：只有设了 `LANGSMITH_TRACING=true` 才上报，正文与逐字稿沿用 MVP 的遮蔽（`redactSecrets`）。
- Q12：worldReader 要实例配置里写 `reads: true` 才启用；MVP 的 `config/world-instance.json` 没有这一项，所以不读。写回保持原样。
- Q6：自由图示 visual 的规则跟着图表块规则一起进了 CEO 提示词。要关掉，从 `RICH_BLOCK_RULES` 里删 visual 段即可。

## 四、移植中补上的地方

- inception 的图表块、句末出处、回答末尾选项、决策六节规则原本只挂在演示版 CEO 提示词上。现在并入 MVP 的 CEO 提示词（`CEO_SYSTEM_PROMPT`），并加回两个只读工具：`read_group_evidence`、`read_decision_history`。「选择某方案」那条改成：只说明改法和执行人，由 CEO 自己执行（MVP 的 Agent 只读）。
- 议题页页头的「邀请成员」与「更多 ⋯」合到同一个容器里。之前两颗按钮落在 grid 的同一格，手机上叠在一起。
- 首页战场卡上的「LTO ·」改为「长期目标 ·」。

## 五、验证（2026-10-15）

- `pnpm -r typecheck`：4 个包全部通过。
- web vitest：183 个文件、1571 条全部通过。
- contracts：75 条全部通过。
- 浏览器验证：用 inception 最新场次库的副本 `ceoport_review` 跑（本体已关闭，不写真实本体）。
  - 1440：首页、议题页、会议页、雷达都检查了；对话实测出了时间线块和末尾选项按钮。
  - 375：首页、议题页，没有横向溢出，页头按钮 44。
  - 768 双屏：会议页，目录收成按钮。
  - 1180：会议页三栏。
- 发现一个疑似 MVP 原有问题，没改：600–959 双屏打开详情页时，右侧对话列根节点留在文档流里，把壳的 grid 撑出第二行（约 274px），右页底部空出一截。CSS 规则和渲染条件都与 MVP 一致。

## 三、不搬

demo-api、准备台、DEMO_MODE 分支、demo_* 表、战役（demo_missions）、会后决定写入战场（只写演示表）、演示资料与客户代号、根目录 package 改名、删掉 `output: standalone`、`NEXT_PUBLIC_DEMO_MODE` 默认值、API 端口改 4321。
