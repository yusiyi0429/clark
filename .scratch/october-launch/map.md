# 10 月首轮上线（10/8 复工）· 进度

决定记录：项目文档 `claude/决策记录_10月上线与协作批注_2026-10-06.md`。数据：`seed/imports/missions-2026-09.json`（+05-4）、`seed/imports/reviews-2026-09.json`、`seed/imports/2026-10-known-missions.json`，飞书原文导出在 `clark/tmp/feishu-sep/out/md`（不在仓库）。

| # | 工单 | 状态 | 10/8 必需 |
|-|-|-|-|
| 01 | [导入飞书 9 月复盘，CEO 从公司复盘开始](issues/01-review-import.md) | ready-for-agent | 是 |
| 02 | [签发即起草任务卡并推给本人；战场参与者名单](issues/02-auto-draft-on-sign.md) | ready-for-agent | 是 |
| 03 | [材料批注按「谁写的」区分](issues/03-annotation-authority.md) | ready-for-agent | 来不及就上最小版：所有批注只保存不自动改，对话改稿限能改的人 |

## 10/7 上线前

1. 只读核查线上：LTCO、战场与负责人、能力域与负责人、人员 9 人、有无演示残留、9 月复盘与 10 月计划的状态、`schema_migrations` 最大编号。
2. 临时库（线上备份恢复）上部署 HEAD，跑 `missions:import`、`reviews:import`，真实模型走一遍：公司复盘 → LTO → 签发 → 起草 → 本人准备。
3. 推送分支、合并 main（先问用户）→ 备份 → 部署 → 导入 → 冒烟 → `access:issue` 发初始码。

## 10/8 之后

- Word 上传自动生成可编辑副本；会后在会议结论里采用批注；world-02 工单 06（签发与任务卡确认按原确认时间补记）。

## 结果摘要

### 2026-10-08 Sean 已定

- `reviews:import --cycle-start`：用今晚发版、导入完成那一刻（实际执行时取当时的上海时间 ISO），倒计时立即开始。
- 工单 01「不覆盖」：保持现实现——只跳过已提交、CEO 已跳过、本人改过的个人复盘；系统自动起草、本人没碰过的草稿照样被导入覆盖。
- 复盘项来源文案：不区分，导入确认的项都写「飞书导入 · 未在天枢逐项确认」。
- 签发前要把各战场参与者名单设好（名单为空的战场签发时不起草，之后也补不了）。
