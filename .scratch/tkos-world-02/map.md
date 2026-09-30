# 天枢接入 tkos.world/0.2（world-02）· 总览

Status: in-progress
Owner: 天枢（对接人孙铭泽）；本体侧对接 E&O / 本体后端

## 目标

10 月 12–16 日试用期间，天枢把 E&O 的真实经营数据按 0.2 契约单向推给本体 world-02：周进展、会议、计划条目，以及人在天枢里做的确认（月度计划签发、任务卡确认、执行事项的指派／开始／完成／打回／通过、议题流转）经代记写进本体。10/16 联调验收。

## 时间表（倒推）

| 日期 | 事项 |
|-|-|
| 9/30 | 天枢部署上线（与本工程独立，见部署计划 飞书 Wvf0dyfWNoIdojx27SucM7jPnFe） |
| 10/1–10/8 | 实现 01–07；每张工单用 `examples-24e6202.md` 对应小节的真实请求／返回写测试 |
| 10/9–10/11 | 与 world-02 联调（实例可能再重建，id 与凭证整批换） |
| 10/12–10/16 | 试用；09 议题流转在试用周内接上 |

## 已议定（2026-09-29，与本体）

- 实例 `https://world-02.tokenkingos.com`，信封 `contract_version: "tkos.world/0.2"`；凭证 `tkos-secrets/ontology-runtime/world-02/tianshu.token`（本机在 `apps/api/.env` 的 `TKOS_WORLD_*`）。ids：`ids-24e6202.json`；实测示例：`examples-24e6202.md`（11 节，全部实跑通过）。
- 试用期天枢**不能建** Mission / Task。本体按 E&O 三个十月个人任务建了 Mission（草稿）：`renhao-202610-b`、`renhao-202610-c`、`siyi-202610-1`；周期目标与 Mission 的门留给天枢代记。
- 外部引用：`{system:"tianshu", id:"mission:<编号>"}` 由天枢写到 Mission；`capability:05` 已由本体写在 E&O 单元上（Agent 改单元会 403）；`todo:<uuid>` 由 E&O 建 Task 时写。战场暂不写。
- 新增执行事项的交接：天枢即时在 Mission 执行计划块写 `plan_item`（组件 id `todo:<uuid>`），E&O 据此建 Task。
- 委托已登记：刘明华（CEO）、于斯一（E&O DRI／Owner／IC）、刘人豪（Owner／IC），族 门／指派／生命周期／议题，域 eo（CEO 加 company），到 10/31。
- 进展条目：主链接放 entries 的 `url`，其余链接放同组件 `artifacts`，不拆条。
- 块内容一律放 `payload.blocks.<块 id>`；外部事件内容放 `content`。

## 工单

| # | 工单 | 批次 | 依赖 | 状态 |
|-|-|-|-|-|
| 01 | [world 客户端与同步台账](issues/01-world-client.md) | 一 | — | ready-for-agent |
| 02 | [Mission 外部引用](issues/02-mission-external-refs.md) | 一 | 01 | ready-for-agent |
| 03 | [每周执行状态快照](issues/03-weekly-execution-snapshot.md) | 一 | 01、02 | ready-for-agent |
| 04 | [会议事件](issues/04-meeting-events.md) | 一 | 01、02 | ready-for-agent |
| 05 | [执行事项 → 计划条目](issues/05-plan-items.md) | 一 | 01、02 | ready-for-agent |
| 06 | [代记门：月度计划签发、任务卡确认](issues/06-delegated-gates.md) | 二 | 01、02 | needs-triage |
| 07 | [执行事项生命周期代记](issues/07-task-lifecycle.md) | 二 | 01、05、08 | ready-for-agent |
| 08 | [执行事项「通过」](issues/08-todo-accept.md) | 二 | — | needs-triage |
| 09 | [议题流转](issues/09-issue-flow.md) | 三 | 01、02、03 | needs-info |
| 10 | [复盘与 LTO 审视 → 本体事件](issues/10-review-events.md)（用户 9/30 追加） | 二 | 01、02、personal-review/02 | ready-for-agent |

批次一 10/12 前必须到位（不依赖代记）；批次二本体希望 10/12 前也到位（试用与对照实验最需要的数据）；批次三试用周内接上。

## 不做

- 战场的外部引用与战场对象；0.1 world-lab 相关一切（已作废）；会后战略条目（Strategy／长期目标）的代记；本体侧建对象。
- 旧的拉取接口 `GET /api/ontology/weekly-progress` 在 03 完成后删除（方向已改为天枢单向推送）。

## 结果摘要

（各工单 resolve 后追加）
