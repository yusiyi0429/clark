# Partner UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or executing-plans to implement task-by-task. Independent files are delegated; root owns shared integration and acceptance.

**Goal:** 在真实内部版中统一伙伴工作流、降低默认展开密度，并修复不可信状态与历史断链。

**Architecture:** 沿用现有数据和WorkTimeline。会议与交接hook产出TimedBlock，团队卡逐级展开；主会话连接输入队列和所有事件。

**Tech Stack:** Existing Next.js, React, TypeScript, Vitest, CSS Modules.

**Spec:** [design.md](design.md)

## Global Constraints

原版提交和源码归档保留。无新依赖，无后台/API业务范围扩大；不自动确认会议或执行任务；保留所有者权限、失败重试、稳定请求ID。主会话独占Conversations.tsx和共享文档。

## Review Focus

- 深链指向折叠回复或未关联妙记时，应展开并定位。
- 同一收件内容刷新后不能丢失回复、重复显示或改变发送身份。
- 未来预约不得进入已发生事件的时间线。
- 已完成目标仍可打开历史，失败回执仍按原授权重试。
- 320px、长中文、多成员、错误及暗色需有明确机械检查与未测边界。

### Task 1: Team delivery progressive disclosure

**Files:** PartnerTeamCard.tsx、partnerTeam.module.css、partnerTeam*.test.tsx。
**Consumes:** 原TTeamDelivery与onSaved/onForward。
**Produces:** 同签名组件；摘要、历史折叠和深链展开。

- [ ] 冻结当前行为，加入多成员/回复深链/失败与动作可达检查。
- [ ] 改首层摘要与逐人历史展开，统一主次和触控尺寸。
- [ ] 跑相关测试与单独代码评审。

### Task 2: Meeting handoff work cards

**Files:** MeetingWorkHandoffs.tsx、meeting-work-handoffs.module.css、meetingWorkHandoffs.test.tsx。
**Produces:** `useMeetingWorkHandoffFeed(): {blocks:TimedBlock[];notice:ReactNode}`及兼容包装。

- [ ] 加入历史目标退出列表、待递送/失败、时间/key与动作检查。
- [ ] 将变化、递送摘要、下一动作和来源分层；集成已验证的历史链接候选。
- [ ] 跑组件回归和类型检查。

### Task 3: Meeting timeline and schedule

**Files:** PartnerMeetings.tsx、partner-meetings.module.css、partnerMeetings.test.tsx。
**Produces:** `usePartnerMeetingFeed(): {blocks:TimedBlock[];notice:ReactNode;scheduled:ReactNode}`。

- [ ] 增加未来预约与已发生事件分离、稳定key和来源失败/深链检查。
- [ ] 会议卡突出当前下一步，未来安排折叠，保持原入会/读记录/整理动作。
- [ ] 跑组件行为回归。

### Task 4: Main integration and trustworthy status

**Files:** Conversations.tsx、WorkIntake.tsx、SubSessionSummary.tsx、对应CSS与测试。

- [ ] BuddyView合并三类blocks，仅渲染一套时间线；队列移到输入附近。
- [ ] 分开运行/异常/等待汇总，队列摘要与原操作可达。
- [ ] 完成统一回归、语义类型检查、版本对照和独立评审。
- [ ] 根据实际反例继续修正；实机/视觉证据不足时保存checkpoint，不宣布顶级体验已证实。
