# 隔离的多人验收

从仓库根目录运行。使用本仓库的 Fastify、会话 cookie、迁移、PostgreSQL 客户端、现有接口及合成成员。每个场景启动一个全新的内存数据库，并在自己的临时目录写入附件。

数据库使用 `@electric-sql/pglite` 的真实 PostgreSQL WASM 后端。建议使用本地已安装的 0.3.16 或兼容版本。可通过 `PARTNER_QA_PGLITE_MODULE` 指定已安装包目录的绝对路径。缺省先从本项目解析；Clark 工作区内也可复用相邻 `Chat_Service-lab` 已安装的同名包。接口测试只使用进程内的数据库协议流。没有系统 PostgreSQL、真实帐号或外部服务依赖。

```powershell
node .scratch/partner-work-continuity/qa/migrate-pglite.mjs
$checks = 'baseline','work-intake','queue-turns','queue-recovery','events','meetings','recordings','team','team-upload-validation','fixed-collection','handoffs'
foreach ($check in $checks) {
  node apps/api/node_modules/tsx/dist/cli.mjs ".scratch/partner-work-continuity/qa/$check.mts"
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
```

| 场景 | 被验收的入口 |
| --- | --- |
| `baseline` | 三位独立登录成员，原项目读权 |
| `work-intake` | 持久追加、优先、取消、权限变化、失败重试和既有回执恢复 |
| `queue-turns` | 第一轮回答中追加第二句、上游忙时保留原提问与接力计数、恢复过期已接收任务时不重复发出 |
| `queue-recovery` | 首页对话换段后用原段重试，收到回执后模拟进程退出，恢复时只查原回执 |
| `events` | 审批原链接、受阻与普通报告、并行专题和去重 |
| `meetings` | 原始会议身份、补轮询、重登、来源撤权、相近场次由所有者选择、改期和取消 |
| `recordings` | 上传音频分片、候选、主持人确认后读取同一场会议的记录 |
| `team` | 文件字节和版本、原件权限变化、多人问题与追问的原待办链接、按失败收件人重试 |
| `team-upload-validation` | 空文件、未知类型、超限大小及第21个文件均拒绝，回滚后可复用同一发送标识 |
| `fixed-collection` | 原每周征集、每人一行和发起人汇总 |
| `handoffs` | 原 Nexus 确认、独立授权、多目标、部分失败、重试、实际专题执行交代 |

飞书、转写、表格和 Chat 上游使用进程内替身。浏览器中的实际交互、现场采音、远端人员入会以及原生 PostgreSQL 的多连接锁竞争需要另外验证。

## 最终回归

2026-11-14 恢复暂停后的复测：Web全量2528项通过，会议及来源6套87项通过，团队并发、文件回滚和文本检查3项通过，API／Web／contracts类型检查及客户端生成通过。本轮契约158项、API独立单元9项亦通过；实际双人场景按上表逐项执行。

```powershell
pnpm --filter @warmap/web gen:client
pnpm --filter @warmap/api typecheck
pnpm --filter @warmap/web typecheck
pnpm --filter @warmap/contracts typecheck
pnpm --filter @warmap/web test --maxWorkers=4
pnpm --filter @warmap/contracts test
node apps/api/node_modules/vitest/vitest.mjs run --config .scratch/partner-work-continuity/meeting-vitest-offline.mts test/meetingMinutes.test.ts test/feishuMinuteInbox.test.ts test/meetingRecordings.test.ts test/meetingFeishuEvent.test.ts test/partnerMeetings.test.ts test/internalTranscript.test.ts test/teamDeliveries.test.ts
```

离线Vitest配置仅替换数据库测试帮助函数与一个旧线程用例的超时预算；生产应用注册、鉴权、路由和用例断言照常执行。PGlite使用单后端连接，HTTP并发重放与事务回滚的通过不等同于原生PostgreSQL多连接锁竞争已验证。

## 合成账号预览

```powershell
node apps/api/node_modules/tsx/dist/cli.mjs .scratch/partner-work-continuity/qa/preview.mts
```

脚本启动仅监听 `127.0.0.1` 的独立API与Next服务，在控制台给出随机端口、登录入口、合成账号和运行目录。合成成员甲为 `qaone / 2847`，乙为 `qatwo / 5827`。预先完成引导并为每人创建项目，甲向乙发出一条信息征集。模型调用使用验收替身。

运行目录中的 `status.json` 记录真实状态，`next.log` 记录服务输出；在该目录创建空 `stop` 文件即请求关闭本次进程。Next意外退出会标记失败并返回非零退出码，不能只凭中途的Ready输出宣告预览可用。

2026-11-14 Shell访问返回EACCES、内置浏览器导航超时。旧监督进程已通过stop入口退出，残留Next实例仍占着开发锁，当前环境查询CIM和终止该进程均失败；后续预览实例已自行退出。因此本轮未恢复可验收的预览，也未声称页面交互或布局通过。应先在可管理旧开发服务的本机环境将其关闭，再运行上述命令，验证双方登录、来件回复、附件、预约与入会、录音及手机布局。
