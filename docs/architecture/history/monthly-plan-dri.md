# 原始月度计划与 DRI 集成方案

本文保留早期月度计划设计。当前月末复盘、本人准备和组合核对见[领域上下文](../../context.md)与[任务卡契约](../../contracts/mission-card-preparation-review.v0.1.md)。

## 1. 职责

实现每月自动草案、普通待办、DRI 反馈、CEO 签发、战场投影和统一 DRI JSON 边界。

不实现 DRI UI、Mission、项目管理或 todo 执行状态机。

## 2. 月初 Scheduler

每月 1 日按 Asia/Shanghai 计算并触发当前 period：

1. 获取 monthly advisory lock；
2. 尝试插入 `period` 唯一 draft；
3. 已存在则退出；
4. 创建 AgentRun；
5. 启动 MonthlyDraft Agent。

启动补跑只创建缺失 period。failed plan 必须由 CEO Action 显式重试。

## 3. MonthlyDraft Agent

输入：

- CompanyMemory 相关段落；
- 已确认 Issue Receipt；
- 上月计划和反馈；
- 当前 BattlefieldConfig；
- 已导入 DRI 反馈。

输出：companyOutcome、battlefield outcomes、普通 todos。

代码验证 battlefieldId、ownerId、sourceRef 和字段长度。Agent 不能签发。

## 4. MonthlyPlan 数据

```text
period
status: draft | negotiating | confirmed
companyOutcome
battlefields[{battlefieldId,outcome}]
todos[{id,battlefieldId?,title,ownerId,dueAt?,sourceRef}]
negotiation{edits,checkedItemIds,feedback[{id,todoId?,battlefieldId?,text,evidenceRef?,observedAt,sourceRef}],note}
runId/error/confirmedAt
version/timestamps
```

Todo 没有 open/done 状态。dueAt 空时 Card 显示本月末。

## 5. 协商

- Web 编辑/核对走 versioned Action；
- 首次编辑或 DRI feedback 将 draft 改 negotiating；
- DRI feedback 只追加，带 externalId/sourceRef；todo feedback 还可带 todoId、battlefieldId、text、evidenceRef 和 observedAt，但不修改 todo open/done 状态；
- notification 与 detail 使用同一 MonthlyPlan projector；
- 不在通知卡内保存第二份确认。

## 6. 签发事务

1. 锁 MonthlyPlan；
2. 校验必核对项、ownerId 和 version；
3. 锁 RadarConfig；
4. plan → confirmed，写 confirmedAt；
5. 重建受影响的 ontology-derived 基础 anchors，使用 `source=ontology` 和 `originRef=monthly-plan:<period>`；
6. 提交；
7. 返回 Monthly detail 和 Battlefield Card 新版本。

不直接更新 CompanyMemory。

## 7. 战场投影

正面：当前 MonthlyPlan battlefield outcome + pending Issue。

背面：按 battlefieldId 投影本期普通 todo、负责人和该战场最新 DRI feedback；battlefieldId 为空表示公司级，不进入单个战场背面。

不计算百分比、健康分或 BattlefieldProgress。

## 8. DRI 入站 API

```text
POST /api/integrations/dri/issues
POST /api/integrations/dri/meetings
POST /api/integrations/dri/monthly-feedback
POST /api/integrations/dri/todo-feedback   # 只追加叙述性执行反馈，不改变 todo 状态
```

每个请求要求：

- Bearer DRI_SERVICE_TOKEN；
- schemaVersion；
- externalId；
- sourceRef；
- 业务 payload。

相同 externalId 同内容返回原结果；不同内容返回 409。禁止直接改数据库。

## 9. DRI 出站 API

```text
GET  /api/integrations/dri/exports?status=pending_export
POST /api/integrations/dri/exports/:effectRef/delivered
POST /api/integrations/dri/exports/:effectRef/failed
```

导出内容来自 Meeting Supplement Request、MeetingOutcome todo、MonthlyPlan todo。它们仍内嵌在所属对象，不建立独立 Todo/Outbox 业务实体。

## 10. Export 状态

```text
recorded → pending_export → delivered
                          ↘ failed → pending_export（显式再导出）
```

failed 不自动重试。delivered 后若外部系统不支持撤销，WarMap 不伪造撤回。

## 11. JSON 模板

为每种 import/export 提供版本化 TypeBox schema 和示例。模板不带虚构默认人名、战场或截止日期。

## 12. Card

- monthly notice：摘要、状态、失败、进入详情；
- monthly detail：outcomes、todo、feedback、edits、checks、sign/retry；
- battlefield：正反面投影；
- export 状态：已记录、待外发、已送达、失败。

## 13. 失败

- 月度 Agent 失败：保留 draft + error；
- DRI feedback person/period 无效：422；
- 签发 version 冲突：409 + latestCard；
- RadarConfig 更新失败：整个签发事务回滚；
- export 失败不回滚已确认组织事实。

## 14. 测试 seam

- 同月唯一创建；
- 启动补跑；
- failed 不自动重跑；
- draft → negotiating → confirmed；
- feedback append/idempotency；
- sign 事务与 anchors；
- notification/detail 单一来源；
- 战场无百分比；
- export pending/delivered/failed；
- service token 隔离。

## 15. 完成条件

一个真实 period 完成自动草案、DRI feedback、CEO sign；战场正反面同步更新；普通 todo 可导出但 WarMap 不跟踪执行。
