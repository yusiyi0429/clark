---
title: CEO WarMap MVP
status: ready-for-agent
scope: product-and-platform
language: zh-CN
---

# CEO WarMap MVP 规格说明

## 问题陈述

CEO 目前缺少一个只围绕决策工作的统一驾驶舱。外部变化、DRI 提交、会前材料、会议逐字稿、会后结论、月度目标和日常追问分散在不同文件、页面与本地演示状态中，CEO 无法稳定回答这些问题：现在什么需要我判断，依据是什么，会议形成了什么，哪些内容已经生效，哪些任务需要外发，历史讨论属于哪个对象。

当前前端同时承载展示、硬编码业务数据、状态迁移、模型调用和本地持久化。它包含大量超出 CEO WarMap 的旧页面、Agent、录音、研究、本体、DRI 和秘书功能，无法作为前后端分离目标的可靠基础。相同 Issue 可能重复出现在战略、战场和能力区域；会前、会后和月度状态存在多份本地来源；Conversation 也没有稳定的对象级事实源。

CEO 需要的是单公司、单 CEO、桌面 Web 决策驾驶舱。系统必须真实跑通雷达、预研、决定、会议和月度计划，同时保留当前 CEO WarMap 已验证的视觉与微交互。Agent 可以自动保存候选材料，但不能自行改变组织事实；所有正式变化必须来自 CEO 的确定性 Action。

## 解决方案

建立前后端分离的 Monorepo。新的 Web 只渲染类型化 Card、保持现有 CEO WarMap 的像素级交互并提交后端提供的 Action；独立 TypeScript API 拥有业务对象、状态迁移、鉴权、调度、Pi Runtime、CompanyMemory MCP、外部导入和 PostgreSQL 持久化。

系统保留六个实体：Issue、Signal、Meeting、MeetingOutcome、MonthlyPlan 和 Conversation；保留 RadarConfig 与 BattlefieldConfig 两类配置。通知、战场正反面、Radar 态势和 MeetingOutcome 处理进度均由业务对象投影，不建立重复对象。

Radar 每日自动扫描并允许手动补扫。达到确定性门槛的 Signal 自动创建 pending Issue 并立即展示，不增加 CEO 二次“形成议题”操作。所有 Issue 自动执行唯一深度的预研；CEO 可以直接决定，也可以加入 Meeting。Meeting 使用会前预审和严格的结构化 Transcript，MeetingOutcome 中的决定、普通待办、CEO 判断与复议条件由 CEO 逐项确认或忽略，确认后立即产生精确可撤回的效果。MonthlyPlan 每月自动装配，经外部 DRI 反馈和 CEO 签发后生效。

Pi SDK 提供 Chat agent loop、自定义 Web Search、Session 和 compaction。PostgreSQL 保存原始 Conversation、业务对象和可恢复的 Pi runtime entries；CompanyMemory 通过只读 MCP 按需提供目录、段落、证据和人员。Runtime 不拥有业务记忆，也没有组织写入工具。

新的 Web 从空目录建立，只迁移已确认的 CEO WarMap 视觉、布局和微交互。scope 内页面按当前桌面界面像素级重构；scope 外新增状态和动作沿用相邻组件的视觉语言。新系统验收并经用户确认后，旧前端整体删除，不迁移旧演示数据或本地状态。

## 用户故事

1. 作为 CEO，我希望通过一个经过鉴权的 Web 入口进入 WarMap，从而避免公司决策材料被公开访问。
2. 作为 CEO，我希望首页保留当前 WarMap 的空间布局，从而让重构后的产品延续我已经形成的操作习惯。
3. 作为 CEO，我希望在一个驾驶舱中看到公司战略、战场、能力、Radar 和通知，从而无需在多个产品之间切换就能理解当前决策面。
4. 作为 CEO，我希望所有 Issue 入口都打开同一种 Issue 体验，从而不因 Issue 来自 Radar 或 DRI 而面对不同页面。
5. 作为 CEO，我希望每个对象页面都有稳定 URL，从而在刷新、浏览器回退或分享链接后仍能定位当前对象。
6. 作为 CEO，我希望底部 Conversation 输入框在各页面保持相同视觉位置，从而让讨论不会与决策材料争夺空间。
7. 作为 CEO，我希望键盘、焦点、Escape 和 reduced-motion 行为得到保留，从而让重构后的界面继续可预测且可访问。
8. 作为 CEO，我希望产品优先针对桌面 Web 优化，从而不让 MVP 被移动端或原生应用工作分散。
9. 作为 CEO，我希望 Radar 在每个 Asia/Shanghai 自然日自动扫描一次，从而无需手动操作也能收到重要外部变化。
10. 作为 CEO，我希望能额外触发一次手动 Radar 补扫，从而在来源漏扫时进行补救而不改变每日计划。
11. 作为 CEO，我希望定时扫描和手动补扫使用同一条处理管线，从而避免产生相互冲突的 Signal 语义。
12. 作为 CEO，我希望 Radar 同时监测普通 Web 来源和指定微信公众号，从而让账号级发布不会被近似成普通关键词搜索。
13. 作为 CEO，我希望每条 Signal 展示来源、摘录、采集时间和战略影响，从而区分检索证据与 Agent 推断。
14. 作为 CEO，我希望 Signal 的已读、收藏和隐藏状态可以独立共存，从而避免收藏操作覆盖阅读状态。
15. 作为 CEO，我希望合格 Signal 自动成为 Issue，从而不需要再次点击“形成议题”。
16. 作为 CEO，我希望 Radar 升级同时满足 CEO 决策类型、不同选择、可核对引文、合法归属、代码门槛和去重，从而在信任 Agent 的同时保留确定性质量门槛。
17. 作为 CEO，我希望新升级的 Issue 在预研排队时立即出现，从而避免紧急决策窗口被模型延迟隐藏。
18. 作为 CEO，我希望 Red Issue 必须有可核对的决定期限和原因，从而避免模型仅凭语气制造红色通知。
19. 作为 CEO，我希望能把错误升级的 Issue 移出决策面，从而不让 Radar 误判永久停留在 pending。
20. 作为 CEO，我希望 dismissed Issue 保留来源和去重指纹，从而避免同一外部变化被反复升级。
21. 作为 DRI，我希望通过鉴权 JSON 接口提交 Issue，从而无需 DRI UI 也能让有效决策请求进入 CEO 驾驶舱。
22. 作为 DRI，我希望不完整的 Issue 提交在创建前被拒绝，从而避免 CEO 收到没有来源或提交人的请求。
23. 作为 DRI，我希望提交 Issue 为什么现在重要以及建议归属，从而让预研从真实组织问题开始。
24. 作为 DRI，我希望 red 提交必须带 decisionBy 和 reason，从而让紧迫度成为明确承诺而不是 Agent 猜测。
25. 作为 CEO，我希望每个 Issue 只有一个主归属，从而避免同一对象重复出现在战略、战场和能力卡中。
26. 作为 CEO，我希望影响多个战场的 Issue 成为 Strategic Issue，从而把跨战场问题作为公司级选择处理。
27. 作为 CEO，我希望每个新 Issue 都触发同一种预研，从而让判断材料拥有唯一来源。
28. 作为 CEO，我希望预研状态区分 pending、running、ready 和 failed，从而避免空文档语义不明。
29. 作为 CEO，我希望预研失败时显示原因并允许显式重试，从而让恢复可见且不会发生隐藏重试。
30. 作为 CEO，我希望重试时整份重新生成 ResearchDoc，从而避免 Conversation 证据静默修改部分字段。
31. 作为 CEO，我希望只有 pending Issue 能重新预研，从而避免后来出现的证据改写已确认决定的依据。
32. 作为 CEO，我希望 ResearchDoc 包含摘要、选择、后果、证据、未知和来源，从而不在多个字段重复 Issue 判断。
33. 作为 CEO，我希望可以选择建议选项或编辑最终决定文本，从而让 Receipt 保存我真正批准的内容。
34. 作为 CEO，我希望提交前看到最终决定文本和当前预研状态，从而确保 Action 是有意识的确认。
35. 作为 CEO，我希望在预研 pending 或 failed 时通过二次确认直接决定，从而避免 Agent 故障阻断 CEO 最终权限。
36. 作为 CEO，我希望 Research Override 被记录到 Receipt，从而避免系统声称该决定基于完整预研。
37. 作为 CEO，我希望把 Issue 加入已有 Meeting，从而复用已经安排的决策讨论。
38. 作为 CEO，我希望从 Issue 新建 Meeting，从而无需额外建设会议管理产品。
39. 作为 CEO，我希望从公司人员目录选择 Meeting 参与人，从而让 Transcript speakerId 拥有稳定身份。
40. 作为 DRI，我希望通过服务接口导入 Meeting 元数据，从而让非 CEO 创建的会议也能进入预审。
41. 作为 CEO，我希望会前 Agent 装配提案、依据和 Issue brief，从而让会议准备保持一致。
42. 作为 CEO，我希望标记已阅、已核对和带到会议的项目，从而让准备状态在页面访问之间持续存在。
43. 作为 CEO，我希望修改已核对的会前条目后自动取消该核对，从而避免旧确认覆盖新表述。
44. 作为 CEO，我希望向 DRI 请求补充材料，从而在开会前明确证据缺口。
45. 作为 CEO，我希望 Supplement Request 区分已记录、待外发和已送达，从而避免界面伪造送达结果。
46. 作为 CEO，我希望取消尚未召开的 Meeting，从而让废弃会议不再停留在会前通知中。
47. 作为 CEO，我希望在 Meeting 页面上传标准 Transcript JSON，从而无需建设录音或 ASR 也能推进会议链路。
48. 作为集成客户端，我希望通过鉴权 API 上传同一 Transcript，从而让外部流程可以自动完成导入。
49. 作为 CEO，我希望不兼容的 Transcript 被整份拒绝，从而避免 MeetingOutcome 混入有效发言和猜测内容。
50. 作为 CEO，我希望每个 Transcript speakerId 必须匹配 Meeting participant，从而让负责人和 CEO 权限可追溯。
51. 作为 CEO，我希望成功导入 Transcript 后自动把 Meeting 标为 held 并开始 Outcome 抽取，从而不需要单独的开始或结束按钮。
52. 作为 CEO，我希望 Outcome 抽取失败时保留 Transcript 并允许显式重试，从而永远不丢失原始会议证据。
53. 作为 CEO，我希望每条提取内容绑定具体 Transcript turn 和连续引文，从而可以核对原始出处。
54. 作为 CEO，我希望未知说话人不能成为负责人或 CEO 判断来源，从而避免身份缺口变成组织事实。
55. 作为 CEO，我希望 Meeting 决定、普通待办、CEO 判断和复议条件作为独立审阅项展示，从而分别处理每一种效果。
56. 作为 CEO，我希望可以确认或忽略每个 Outcome item，从而让错误抽取不会阻止 Meeting 收敛。
57. 作为 CEO，我希望确认一个 Outcome item 后立即生效，从而避免已批准事项被整场会议审批阻塞。
58. 作为 CEO，我希望确认的 decision item 创建精确 Issue Receipt，从而知道它来自哪一个会议条目。
59. 作为 CEO，我希望确认的 todo 生成 DRI Handoff，从而让决策驾驶舱可以向外传递工作而不变成执行系统。
60. 作为 CEO，我希望没有真实接收渠道的 todo 标记为 pending_export，从而区分生成导出内容和真正送达。
61. 作为 CEO，我希望已确认 CEO 判断保留在 MeetingOutcome，从而让未来认知复盘可以读取而不直接写 CompanyMemory。
62. 作为 CEO，我希望已确认复议条件进入 Radar anchors，从而把会议中的重开逻辑转化为外部监测目标。
63. 作为 CEO，我希望按 effectRef 撤回审阅项，从而避免撤回操作影响其他条目或 Meeting 的效果。
64. 作为 CEO，我希望无法撤销的外部效果禁用撤回或显示 warning，从而避免界面报告虚假恢复。
65. 作为 CEO，我希望 open Meeting item 只展示而不自动创建 Issue，从而避免每个未决发言都污染决策面。
66. 作为 CEO，我希望所有可审阅条目都 confirmed 或 dismissed 后才把 Meeting 标为 reviewed，从而让进度代表处理完成。
67. 作为 CEO，我希望每月 1 日按 Asia/Shanghai 自动创建一个 MonthlyPlan，从而让计划周期稳定开始。
68. 作为 CEO，我希望月度生成失败时显示错误并允许显式重试，从而避免 scheduler 或 Agent 故障产生静默空计划。
69. 作为 CEO，我希望在月度页面编辑公司和战场目标，从而让 Agent 草案继续保持候选性质。
70. 作为 CEO，我希望月度工作使用普通待办而不是 Mission，从而避免 WarMap 变成执行模型。
71. 作为 CEO，我希望每个月度待办包含负责人、可选截止时间和来源，从而无需任务生命周期也能导出。
72. 作为 DRI，我希望通过鉴权导入提交月度反馈，从而无需 DRI Web 工作区也能参与协商。
73. 作为 CEO，我希望所有 DRI 反馈都关联同一个 MonthlyPlan，从而避免通知和详情页维护两份草稿。
74. 作为 CEO，我希望只有 CEO 账户可以签发 MonthlyPlan，从而避免导入反馈自行变成公司目标。
75. 作为 CEO，我希望签发 MonthlyPlan 后刷新战场目标和 Radar 基础 anchors，从而让驾驶舱反映新的经营周期。
76. 作为 CEO，我希望战场卡能在决策上下文与待办反馈之间翻转，从而在没有虚假百分比的情况下保留现有交互价值。
77. 作为 CEO，我希望战场卡不显示 Agent 推测的完成百分比，从而避免界面暗示不存在的测量模型。
78. 作为 CEO，我希望拥有一个持久 global Conversation，从而为跨对象推理提供稳定位置。
79. 作为 CEO，我希望每个 Issue、Signal、Meeting 和 MonthlyPlan 拥有独立 Conversation，从而避免对象之间串话。
80. 作为 CEO，我希望在一条 global 消息中注入多个对象 Card，从而跨上下文比较决策。
81. 作为 CEO，我希望被引用的 Card 内容在发送时生成快照，从而避免对象变化后改写历史消息。
82. 作为 CEO，我希望后端根据 Card ID 和 version 生成引用快照，从而避免把浏览器提交内容当作可信业务上下文。
83. 作为 CEO，我希望 Chat 优先根据当前对象回答，再考虑外部搜索，从而避免内部上下文被无关 Web 结果稀释。
84. 作为 CEO，我希望 Chat 在缺少当前外部事实时自主搜索，从而无需手动选择搜索模式。
85. 作为 CEO，我希望 Chat 区分内部证据、外部证据和推断，从而持续看见来源质量。
86. 作为 CEO，我希望证据充分后 Search 自动停止，从而避免 agent loop 无限消耗。
87. 作为运维人员，我希望单 turn 有 180 秒超时和 8 次搜索异常保护，从而阻止异常循环失控。
88. 作为 CEO，我希望可以停止正在运行的 Chat turn，从而保持对长时间研究的控制。
89. 作为 CEO，我希望 Conversation compaction 保持上下文连续，从而让长对象讨论不超出模型上下文窗口。
90. 作为运维人员，我希望原始 Conversation 消息与 Pi runtime entries 分开保存，从而避免 compaction 破坏产品历史。
91. 作为运维人员，我希望把 Pi runtime entries 序列化到 PostgreSQL JSONB，从而在进程重启后恢复对象 Session。
92. 作为运维人员，我希望损坏的 Pi 执行态可以从当前对象和最近消息重建，从而避免 Runtime 损坏导致业务数据丢失。
93. 作为 CEO，我希望 CompanyMemory 按相关章节检索而不是全量注入，从而避免长公司上下文挤占当前决策材料。
94. 作为未来 DRI Agent，我希望复用同一个只读 CompanyMemory MCP，从而让不同角色保持一致的公司术语和证据协议。
95. 作为未来 CoAgent，我希望复用同一个只读 CompanyMemory MCP，从而避免第二个 Agent 发明竞争性的公司记忆协议。
96. 作为 CEO，我希望 CompanyMemory 不被当前 WarMap Action 直接修改，从而避免单次决定或对话自动成为公司认知。
97. 作为 CEO，我希望未来 CompanyMemory 更新先由每日认知复盘提出候选，从而在批准前比较文件、已确认对象和 Conversation。
98. 作为运维人员，我希望系统保存 Candidate Material，但不给模型组织写入工具，从而安全检查失败或中断的运行。
99. 作为运维人员，我希望每个批处理 Agent 通过严格 schema Tool 提交结果，从而避免解析散文时静默产生业务数据。
100. 作为运维人员，我希望每个 Agent 场景拥有独立版本化 Prompt，从而可以分别追踪和测试变化。
101. 作为运维人员，我希望生产 Pi 忽略用户级 Skills、Prompt 和配置，从而避免开发机环境改变业务行为。
102. 作为运维人员，我希望关闭 Pi 的所有 coding tools，从而避免 Chat 读取文件、执行 Shell 或修改服务器。
103. 作为运维人员，我希望通过环境变量配置 light、heavy 和 compaction 逻辑模型槽位，从而避免模型选择进入前端。
104. 作为运维人员，我希望应用可见的 Pi run、Tool 事件、输入、输出、usage 和错误进入 LangSmith，从而便于诊断失败。
105. 作为运维人员，我希望 Prompt 和 trace 排除凭据，从而在完整观测时不泄露密钥。
106. 作为运维人员，我希望 Web 与 API 可以独立部署，从而避免业务逻辑重新漂回 Next.js 应用。
107. 作为前端开发者，我希望 Web 客户端类型从 API OpenAPI schema 生成，从而避免 Card 和 Action 契约因手写而漂移。
108. 作为前端开发者，我希望每种 Card kind 使用固定 React renderer，从而避免业务 JSON 演变成无限布局 DSL。
109. 作为前端开发者，我希望当前 scope 内页面依据视觉基线重构，从而避免前后端分离意外重新设计产品。
110. 作为前端开发者，我希望新增 scope 外状态复用现有视觉组件，从而让重试、上传和错误自然融入 WarMap。
111. 作为前端开发者，我希望 Web 不保留业务 API Routes，从而让模型、存储和状态迁移全部留在 API 服务。
112. 作为运维人员，我希望 Web 与 API 健康检查没有副作用和付费调用，从而避免监控行为修改数据或消耗模型。
113. 作为运维人员，我希望 Radar 和 MonthlyPlan 定时任务使用 PostgreSQL 锁和公司日期键，从而避免重启或重复进程创建重复工作。
114. 作为运维人员，我希望所有存储时间统一为 UTC，并使用 Asia/Shanghai 解释业务日期，从而让每日和每月触发保持确定性。
115. 作为运维人员，我希望每天生成异机加密 PostgreSQL 备份，从而避免容器或服务器故障毁掉 CEO 决策。
116. 作为运维人员，我希望上线前完成一次真实恢复，从而避免把存在备份文件误认为真正可恢复。
117. 作为维护者，我希望从空 Web 应用开始，而不是在数百个旧模块中原地删除，从而避免隐藏业务依赖存活。
118. 作为维护者，我希望旧业务数据和浏览器本地状态不迁移，从而避免演示历史污染新数据库。
119. 作为维护者，我希望目标路由、API 链路、视觉回归和 bundle 检查通过后才删除旧前端，从而避免过早移除唯一可用参考。
120. 作为 CEO，我希望删除旧前端前根据当前桌面体验审阅最终重构界面，从而避免“前端分离”变成未经授权的视觉重设计。

## 实施决策

### 产品与所有权

- 产品限定为单公司、单 CEO、桌面 Web 决策驾驶舱。
- DRI 通过鉴权导入和导出契约参与，不建设 DRI Web 工作区。
- WarMap 拥有全部六个业务实体，不依赖日历或会议系统。
- Meeting 是 Issue 的可选路径，CEO 可以直接决定。
- Conversation、CEO 自由输入和 Meeting open item 都不能创建 Issue。
- CompanyMemory 对本 MVP 只读，未来通过独立的每日认知复盘候选流程更新。

### Monorepo 与服务边界

- 在一个 Monorepo 中建立可独立部署的 Web 和 API 应用。
- Web 负责页面、组件、CSS、动画、无障碍、临时表单输入以及仅展示用途的排序和筛选。
- API 负责鉴权、实体、配置、Card 投影、Action 执行、调度、Pi、MCP、外部导入和持久化。
- Caddy 是 Docker Compose 中唯一公网入口和 TLS 终止点，按同一域名把 `/`、`/api/*`、`/mcp/company-memory` 分别转发给 Web 与 API。
- Web 应用不保留业务 API handler。

### API 与契约

- API 使用 Node.js、TypeScript、Fastify 和 TypeBox。
- API 校验和 Pi Tool 参数共用 TypeBox schema，并从同一 schema 生成 OpenAPI。
- Web 客户端从 OpenAPI 生成，不手写重复类型。
- Card 使用固定类型和固定 React renderer，不建设布局 DSL。
- Action ID 对 Web 不透明，由 action type、object、version 和 item 确定性签名，不使用随机 nonce。
- API 根据 action ID 与规范化 input 计算 action fingerprint；已有同 fingerprint 效果时先幂等返回，未命中才执行 Card version 校验。
- GET 和 query 必须无副作用。

### 领域模型

- 保留 Issue、Signal、Meeting、MeetingOutcome、MonthlyPlan 和 Conversation 六个实体。
- 保留 RadarConfig 和 BattlefieldConfig 两类配置。
- Notification、Radar 态势、战场正反面和 Outcome 处理进度均为投影。
- Research、Receipt、Preflight、Transcript、review 状态、todo 和引用快照均为内嵌结构。
- Issue 来源仅限 Radar 与 DRI。
- Issue 状态为 pending、decided、dismissed，不支持 deferred。
- Signal 的 read、saved 和 dismissed 时间相互独立。
- Meeting 状态为 scheduled、held、reviewed、cancelled。
- MonthlyPlan 状态为 draft、negotiating、confirmed。
- MeetingOutcome 整体状态由每个 item 的 pending、confirmed、dismissed review 状态派生。

### Radar 与 Issue

- 按 Asia/Shanghai 每个自然日执行一次 scheduled scan，并允许额外 manual scan。
- MVP 只接一个真实 Web Search Provider 和一个真实微信公众号账号级渠道。
- Agent 负责研判候选，代码负责最终分数、red 资格、归属、引文校验和去重。
- promotion fingerprint 使用版本化的 decision kind、规范化问题和规范化 location 确定性计算。
- 全部升级门槛通过后自动创建 pending Issue。
- Issue 创建后立即展示，预研状态原位更新；启动前崩溃留下的超时 pending research 必须转为可见 failed，不自动重试。
- 外部 red Issue 必须有来源支持的决定窗口和连续 deadline quote；DRI red Issue 必须明确提供 decisionBy 和 reason。
- 错误升级进入 dismissed，不物理删除，并阻止等价问题再次升级。

### 预研与决定

- 只提供一种预研深度。
- 判断、选择、后果、证据、未知和来源只存在 ResearchDoc。
- 只有 pending Issue 可以整份重新生成 ResearchDoc。
- Chat 发现不能合并进 ResearchDoc。
- 预研未完成时默认禁用决定，但允许 CEO 通过二次确认执行 Research Override。
- Receipt 保存 CEO 最终编辑的决定文本和决定时预研状态。
- 所有撤回进入统一 effect revoker；meeting-item Receipt 不得绕过 MeetingOutcome 直接修改，避免 Issue、Outcome 与 Meeting 状态漂移。

### Meeting 与 Transcript

- Meeting 从 Issue 创建或由 DRI 导入，不建设会议管理页。
- participant 来自通过 `company-people.v1` 校验的 CompanyMemory 人员目录，并保存身份快照；不从姓名临时生成 personId。
- 保留当前会前视觉模式，但把草稿状态放回 Meeting。
- Supplement Request 诚实区分已记录、待外发和已送达。
- 只接受版本化结构 Transcript 契约。
- 任一 turn、speaker 身份、时间或必填字段无效时整份拒绝。
- 不实现录音、ASR、格式转换、部分导入或说话人映射。
- 只有有效 Transcript 保存后才把 Meeting 标记为 held。
- Transcript 替换只允许在没有 confirmed effect 时发生，并整体使旧 Outcome candidate 和 actionId 失效后重跑抽取。
- MeetingOutcome 必须带 turn 绑定连续引文，并执行确定性 speaker 和权限检查。

### MeetingOutcome 与 DRI 效果

- 决定、普通待办、CEO 判断和复议条件分别审阅。
- 每个 confirmed item 立即生效并保存准确 effect reference。
- dismissed item 视为已处理但不产生效果。
- 已确认 CEO 判断保留在 MeetingOutcome，不直接写 CompanyMemory。
- reopenWhen 只有在父 decision confirmed 后才可确认；父 decision dismissed 或撤回时同步处理其子条件和 Radar anchors。
- 已确认复议条件进入 Radar anchors。
- 已确认 todo 导出到 DRI 边界，真实接收方确认前保持 pending_export。
- open item 只展示。
- 所有可审阅 item 均 confirmed 或 dismissed 后，Meeting 才进入 reviewed。

### 月度计划

- 每月 1 日按 Asia/Shanghai 自动创建一个 MonthlyPlan。
- 草案输入包括已确认方向、上月复盘、DRI 反馈和相关 CompanyMemory。
- todo 与叙述性 feedback 可带 battlefieldId；战场背面按该字段投影，不能通过 owner 反推。
- DRI todo-feedback 只追加文本、证据和 observedAt，不修改 todo 执行状态。
- DRI 反馈进入同一个计划，不建立第二份通知草稿。
- 月度工作使用普通 todo，不使用 Mission。
- WarMap 不为 todo 建立执行生命周期。
- 只有 CEO 可以签发计划。
- 签发后刷新战场目标和 Radar 基础 anchors，但不直接更新 CompanyMemory。

### 四层记忆与 Pi

- 四层产品记忆为当前运行上下文、对象 Conversation、业务对象记忆和 CompanyMemory。
- TypeScript API 使用 Pi SDK 提供 agent loop、Tool、Session 和 compaction。
- PostgreSQL 是原始 Conversation 和业务对象事实源。
- 每个 Conversation 把 Pi Session entries 作为可替换 runtime JSONB 保存。
- 从 PostgreSQL 加载 entries 后通过内存 Session 恢复 Pi。
- runtime 状态损坏时，使用当前对象和最近原始消息重建。
- 使用自定义 ResourceLoader，关闭用户资源发现和全部内置 coding tools。
- Chat 只开放 Web Search 和只读 CompanyMemory MCP Tool。
- 当前业务对象和 Card 引用由 API 注入，不开放业务库任意遍历 Tool。
- 结构化批处理 Agent 使用临时 Pi Session。
- 批处理结果通过严格的 submit-candidate Tool 返回，再由编排器校验并持久化。

### Search、限制与观测

- Agent 自主判断是否搜索以及搜索次数。
- Prompt 要求证据充分后停止。
- 每个 turn 使用 180 秒超时和 8 次搜索异常保护。
- Pi message 和 Tool 生命周期事件流式返回 Web。
- 应用可见的输入、输出、Tool 事件、usage 和错误进入 LangSmith。
- LangSmith 不要求捕获 Provider 内部传输细节。
- Prompt 与 trace 排除凭据和 service token。

### CompanyMemory MCP

- 提供章节目录、相关章节搜索、段落读取和人员查询的只读 MCP 契约。
- MVP 把 MCP endpoint 部署在 API 容器内，同时保留未来 DRI Agent 和 CoAgent 可复用的协议边界。
- 当前 Markdown 和未来数据库都隐藏在同一 MCP 接口之后。
- 不提供 CompanyMemory 写入 Tool。

### 鉴权、持久化与部署

- 使用环境变量配置 CEO 凭据，并签发 HttpOnly secure session cookie。
- DRI import/export 和 MCP 使用独立服务凭据。
- Caddy、Web、API 和 PostgreSQL 部署在单服务器 Docker Compose 中，只有 Caddy 暴露公网端口。
- PostgreSQL 保存业务实体、配置、Transcript JSONB、Candidate Material、Conversation 和 Pi entries。
- API 进程内运行轻量 scheduler，使用 PostgreSQL 锁和日期键去重。
- MVP 不引入 Redis、消息队列、对象存储、Kubernetes 或独立 worker。
- 数据库时间使用 UTC，公司计划按 Asia/Shanghai 解释。
- 宿主机 cron 每天执行加密数据库备份并通过 SSH/SFTP 复制到异机，至少保留 7 天；提供独立 restore 脚本。

### 前端重构

- 新建干净 Web 应用，不在旧前端中原地清理。
- scope 内像素级保留 WarMap 布局、Card 几何、通知栏、浮卡、战场翻转、对象页过渡、Conversation dock、引用、字体、颜色、阴影、动画、焦点和键盘行为。
- 业务内容变化与视觉一致性分别验收。
- 新增状态通过现有视觉组件组合，不引入第二套设计系统。
- 为登录、首页、Issue、Meeting、Radar、Signal 和 MonthlyPlan 提供稳定路由。
- 删除座位选择、DRI 身份、prototype 路由、语音、TTS、ASR、录音、深研、FoldMaterialDesk、本地命令解析和能力独立页。
- Web 只保留 Next.js、React、图标、class 组合、Markdown、GFM 和请求状态需要的最小依赖。
- 目标路由、API 链路、视觉回归、bundle 检查和用户审阅通过后删除旧前端。

## 测试决策

- 首要测试 seam 是经过鉴权的桌面用户旅程，贯穿 Web Card 渲染、API 状态迁移、PostgreSQL 持久化和 Pi/MCP 集成。测试外部可观察状态与响应，不测试私有类结构。
- 使用一个具有确定 ID 和真实内容长度的端到端 fixture 公司测试所有目标路由，并保持视觉几何稳定。
- 普通 Radar 测试在 API 边界使用录制的 Provider 响应；MVP 另外执行一次真实 Provider 验收。
- 自动 Signal 升级通过最终 Signal、Issue 和 Card 状态验证，不断言内部评分 helper 调用。
- 通过 pending、running、ready、failed API 观察测试 Research 状态，包括显式重试和 Research Override。
- 通过返回 Card、持久 Receipt 和幂等重放行为测试 CEO 直接决定。
- 在鉴权服务边界测试 DRI Issue 导入，包括缺字段、无效身份、无效归属和不受支持的 red 紧迫度。
- 通过持久草稿、编辑后核对失效和诚实 Supplement Request 外发状态测试 Meeting preflight。
- 根据公开 Transcript 契约测试有效输入、重复 turn ID、未知 speaker ID、空文本、时间顺序错误以及任一错误时整份回滚。
- 使用完整 Transcript turn 测试 MeetingOutcome，证明引文必须存在于被引用 turn 中，而不只是出现在全文其他位置。
- 通过 Outcome API 行为测试 owner 识别、“我来”归属、未知 speaker 和 CEO 战略权限类型。
- 通过准确副作用和派生进度测试每个 Outcome item 的确认与忽略。
- 先确认两个独立 item，再撤回其中一个，证明精确撤回不会影响另一项。
- 分别测试 pending_export 与 delivered，防止虚假 DRI 送达声明。
- 通过公司日期、启动补跑和重复触发保护测试 MonthlyPlan scheduler。
- 通过战场与 Radar 投影测试 MonthlyPlan 签发，而不是直接测试内部更新函数。
- 使用 global、Issue、Meeting scope 测试 Conversation 隔离，并证明一个 scope 的历史不会进入另一个 scope。
- 根据 Card ID/version 测试引用快照生成，并拒绝过期或未授权引用。
- 使用确定性假 Web Search Tool 测试 Pi loop 的搜索、免搜索、证据充分停止和 8 次异常终止。
- 使用长合成 Conversation 测试 Pi compaction，并确认 PostgreSQL 原始消息保持不变。
- 通过 JSON 序列化、进程重建和恢复后的可见 Conversation 行为测试 Pi runtime entries。
- 通过公开只读方法测试 CompanyMemory MCP，并证明不存在写入方法。
- 使用隔离 ResourceLoader 启动生产 Pi，并断言用户级资源和 coding tools 不存在。
- 测试 GET 和健康检查不触发模型、搜索或持久化副作用。
- 使用 CEO session、过期 session、无效 service token 和未授权 MCP 调用测试鉴权。
- 使用旧 Card version 提交 Action，测试乐观并发冲突返回最新 Card。
- 连续两次发送同一 Action，确认只产生一个 Receipt 或 effect。
- 复用现有静态 Issue 渲染、通知交互、Radar 门槛、MeetingOutcome 归一化、重试、超时和持久化测试经验，但依据目标契约重写断言，不保留旧对象。
- scope 内重构在 1440×900 和 1600×1000 进行桌面视觉回归。只遮罩动态文本，比较容器几何、视觉 token 和稳定 chrome。
- 动画终态、焦点返回、Escape、reduced motion 和关键 accessible name 与像素截图分开测试。
- Radar 完成前执行一次真实 Web Search 和一次真实微信公众号账号级采集验收。
- 使用生产模型端点执行一次真实 Pi compaction/recovery 验收。
- 实际恢复一次加密 PostgreSQL 备份，并验证恢复后的对象、Transcript 和 Conversation。
- 能通过 Card、Action、MCP 或 API 边界观察的行为，不再为私有 helper 编写重复测试。

## 范围外

- 多公司租户。
- 多 CEO 审批人或基于角色的审批链。
- DRI、CoAgent、秘书或 operator Web 工作区。
- 项目管理、任务执行、todo 状态跟踪或 Mission 管理。
- 日历同步或外部会议系统同步。
- 录音、ASR、说话人分离、说话人映射和 Transcript 格式转换。
- 移动 Web 验收和原生应用。
- 实时语音 Conversation、TTS 和麦克风控制。
- 深研升级或多种研究深度。
- CEO 自由创建 Issue。
- Conversation 创建 Issue 或执行业务 Action。
- Meeting open item 升级为 Issue。
- deferred Issue 状态和提醒系统。
- WarMap 直接更新 CompanyMemory。
- 每日认知复盘和 Memory Update Proposal 实现。
- CompanyMemory 写入 MCP。
- 通用 JSON 页面布局 DSL。
- Notification 业务实体或跨用户通知已读状态。
- 独立 ResearchJob、ScanRun、Todo、Action、Approval 或 BattlefieldProgress 实体。
- 事件溯源、通用工作流和多级审批。
- 同时使用多个 Agent Runtime。
- 多 Web Search 或公众号 Provider 插件平台。
- Redis、消息队列、对象存储、Kubernetes 或分布式 scheduler。
- 旧业务数据迁移、localStorage 迁移或兼容路由。
- 目标验收后继续保留旧前端。
- 超出 MVP 健康检查和 trace 的大规模评测平台、对账报表或运营驾驶舱。

## 补充说明

- 产品意图和领域语言已记录在项目词表中，架构取舍已记录为 ADR。已被替代的 Runtime 决策只保留历史意义，不得作为当前实现依据。
- 结构化 Transcript 模板已经确定，并保持为 MVP 唯一导入契约。
- 目标设计附有技术架构图、六实体生命周期图和四张边界清晰的时序图，分别覆盖 Radar 升级、预研到决定、Meeting 准备与抽取、会后逐项确认。
- 时序图有意拆分，避免压缩成不可读的单张长图。
- Pi 已通过当前 OpenAI-compatible Responses 端点的真实 Tool loop、手动 compaction 和 Session entries JSON round-trip 恢复验证。
- 一个 Web Search Provider、一个公众号账号级渠道和 heavy 模型槽位仍需实施 PoC。PoC 未完成会阻止对应验收旅程，但不会重新打开产品意图。
- 像素级重构指保留当前 scope 内视觉与交互契约，不代表保留错误的本地业务行为。
- 本文在本地标记为 `ready-for-agent`。项目已配置 Local Markdown issue tracker，发布时应复制到对应 `.scratch/<feature-slug>/spec.md`。

## 生产切换风险豁免（2026-09-16）

用户明确选择方案 C，将以下两项从本次 cutover 阻塞门槛调整为上线后补齐：

- 微信公众号账号级 MCP 已完成扫码、精确账号订阅和安全边界验证，但真实文章拉取受微信 `ret=200013 freq control` 阻塞；保留实现，不以关键词替代，不宣称真实采集已通过。
- PostgreSQL 已完成真实 age 加密、checksum、空库恢复、六实体与运行数据核对并继续 Conversation；异机 SSH/SFTP 复制与至少 7 天保留尚未执行，用户明确接受单机故障时的数据丢失风险。

该豁免仅允许进入人工 UI 验收及后续 cutover 流程，不等于完成公众号或异机备份技术验收，也不替代 Ticket 17 对生产入口切换与删除旧 `frontend/` 的明确人工授权。
