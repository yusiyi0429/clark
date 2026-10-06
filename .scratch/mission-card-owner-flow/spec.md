# 个人任务准备、Co-Agent Review 与责任人确认

Status: verified

用户已批准推荐方案并授权并行实现、必要取舍和验证。基础：feat/mvp-member-workspace，e46aa97。不得覆盖其他 scratch/output 未跟踪文件；不得部署或使用正式数据库验证。

## 产品决定

- 本人确认保留，表达已核对并认可本月可完成，不等于最终 Mission 签核。状态「待本人确认 / 本人已确认」，按钮「确认我的任务」。
- 按 Co-Agent demo 的职责：战场 DRI 确认本单元 Mission 组合，CEO 签核月度目标；CEO 兼战场 DRI 时以实际负责人权限执行。本人准备阶段仅本人能批注、提出改法或通过私人 Agent 改正文。
- 准备阶段草稿仅本人可读，上级仅见准备进度；本人确认后 CEO/战场 DRI 可读正文及依据，普通同事不可进入他人卡。
- 批注「保存」只留备注；「立即修改」明确提交给 Agent。未完成的改写需处理或明确留备注；普通保存备注可直接本人确认。
- 全员本人确认后自动生成真正的 Co-Agent Review，保留全部来源、原批注、澄清、修订及版本快照；模型不能自动改已确认内容或代人确认。DRI 可退回指定卡，其他确认保留；仅当前稳定版本能最终确认。
- 截止不代未完成人确认。显示准备缺口，提供实际可用的重新开放/退回入口；失败可重试，不显示虚假成功。
- 修复双击/三击/拖选等选区菜单；批注输入只留简洁圆角输入及两个按钮。正文显示最新文字，小 icon 预览 comments/原文/改写依据，点击固定完整记录，手机/键盘可用。
- 引用使用输入框上方可移除的 compact chip，hover/click 查看全文，不粘贴输入正文；发送时准确带来源与版本，失败保留、成功清除，切卡/身份不串内容。
- Markdown 阅读间距适中；保留正式字段和起草规范，首次多页引导同步实际新流程。业务事实经数据库/API获取。

## 分工

1. mission_backend：API、contracts、迁移054起、权限守卫、Review服务与后端测试。
2. mission_annotations_ui：选区、批注、正文历史呈现与其前端测试。
3. quote_chips：共享引用输入/历史、群组模式权限与其前端测试。
4. root：页头、进度、报告/退回/重试UI、引导、规范与隔离浏览器完整验收、最终审查。

## 验证

类型检查、相关契约/API/前端测试；独立随机 warmap_test_* 库与API4600/Web3520。真实 Chrome 桌面/390px：本人草稿、上级只见进度、同事无权、双击/三击、note保存不改、edit改写、澄清/留备注、引用chip、本人确认通知、自动Review失败重试/报告、DRI退回仅相关卡、再次确认、DRI最终确认及CEO越权拒绝。不改变用户3512/旧3500环境。

## 方法来源

- 飞书 TKOS_Mission_Card_Mission_Plan_v0.1_2026-09-30，revision26；现 docs/contracts/mission-card-writing.v0.1.md。
- TokenkingOS/Co-Agent-Design main a123af49b46b961462fbba03cc34d9cb4cf81172：docs/CURRENT-VERSION.md、workflow.mjs、runtime.mjs、goal-review/opinion-synthesis。参考方法，天枢保留用户要求的本人确认和自己的交互。

## 完成记录

2026-10-01：后端逐文件最新结果 874/874（全量后修复并顺序复跑全部失败文件与核心文件）；Web 完整 781/781；contracts 74/74。三包类型检查、生产构建、Chrome 桌面/390px 手机 16 组端到端全部通过。证据：run/validation-summary.json、evidence/results.json。工作只在隔离 warmap_test_* 数据库中验证，模型为可控响应；正式数据和服务未部署或更改。
