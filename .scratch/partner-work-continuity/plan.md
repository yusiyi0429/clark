# 天枢伙伴团队协作实施计划

用户于2026-11-13批准v0.2。主会话管理契约、集成与验收。技术栈为TypeScript、Fastify、PostgreSQL、TypeBox、Next.js和Vitest。执行者同时阅读[设计稿](spec.md)。

## 接口与工作顺序

| 工作 | 路径和负责人 | 联接约定与验证 |
| --- | --- | --- |
| A 会后收件与会议来源 | `apps/api/src/partnerMeetings.ts`、`routes/partnerMeetings.ts`、妙记归属与会议读取、`281_*.sql`，A负责 | `GET /api/me/partner-meetings` 返回 `{items}`。收件对象含稳定 id、meetingId（可能为 null）、title、at（ISO 时间）、stage、statusText、href、joinUrl（可能为 null）、needsAction、source，可选 preflightText、sourceUrl。预约与已结束的同一场会议复用 id。无权、取消、相近但未经确定的场次有独立用例 |
| B 首页、伙伴会议与立即开会 | `HomeView.tsx`、`MeetingControl.tsx`、新 `PartnerMeetings.tsx` 和本地组件样式，B负责 | 从同一数据展示首页近期／以后、伙伴收件、实际入会地址、预审和原会议动作；现场和远程各可发起。伙伴对话导出 `PartnerMeetingInbox`，由主会话放入时间线 |
| C 按成员发送文件与临时问题 | `apps/api/src/teamDeliveries.ts`、`routes/teamDeliveries.ts`、`packages/contracts/src/teamDeliveries.ts`、`282_*.sql`，C负责 | 现有requests与收件人记录保留。传送文件按人按版本，提问支持文字和附件回复。同一发送标识重复提交一次，来源链接仍按原权限。C与D通过共享接口表对齐 |
| D 收发界面、临时和固定征集 | 新 `apps/web/src/components/home/PartnerTeam.tsx` 及相关Web模块，D负责 | 导出 `PartnerTeam`，收件、发件逐人状态，选择同事、拖入文件、在原请求回复；复用既有固定征集页面。主会话接到伙伴对话和输入框 |
| E 已确认会议变化交回项目 | 新 `meetingWorkHandoffs.ts` 服务、同名routes、合同、会议操作组件、`283_*.sql`，E负责 | 只从本人有权处理的真实已确认结论和版本进入；分别验证目标、逐目标持久回执与失败重试，送至原项目动态。显式继续推进才递送，保留本机执行与Nexus边界 |
| 主会话 持续承接、事件和集成 | `packages/contracts/src/index.ts`、`openapi.ts`、`apps/api/src/app.ts`、`buddyActions.ts`、`Conversations.tsx`、生成的客户端以及独立集成测试 | 将关键事件和持久队列放回现有伙伴／项目，模型读取按成员范围。相关工具和界面共用业务入口，保留原本运行中的独立工作 |
| 独立验收 | 实现交回后，独立评审代码、跨人读取和授权、真实数据库与浏览器条件，主会话修复并复验 | 没有切换版本或没有真实飞书凭据的现场环节单列；不得替代真实证据 |

## 实施与验收

- [ ] 第一关。为已约会议、未关联妙记、相近场次、权限变化和录音缺失增加回归。实现A及B会议展示后，用相同场次对至少两位成员的读取核对记录与权限。
- [ ] 第二关。为甲投递乙、丙不可见、同一发送重试、答复归回对应人写测试。完成C与D后核对文件字节和临时／固定征集两种入口。
- [ ] 第三关。验证即时会议选人、远程地址就绪后入会、预约改期、取消及预审更新。保存记录、确认结论与授权执行分别检查。
- [ ] 第四关。测试连续追加、局部等待、确定性关键事件、会议三去向和部分失败重试。检查真实的接收上下文，避免仅维护回执。
- [ ] 集成。运行涉及的API／Web／contracts测试，重新生成客户端，Web与API类型检查，验证适用的DB和桌面／移动端路径。实施者各交局部证据，主会话核对实际diff、已执行命令和剩余限制。

共用文件由主会话单写；其他人在同一已隔离集成工作树各自负责独立文件。保留真实业务数据库和运行中的用户会话。主会话维护实施日志和可复现的验收条件。

