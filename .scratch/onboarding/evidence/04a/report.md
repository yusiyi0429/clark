# 04a 验收记录

日期：2026-09-27。范围：数据、轮次状态机、讨论候选导入、CEO 整理入口；个人卡页、意见写入、逐条处理和最终确认仍归 04b/04c，成员通知及共享分钟时钟归 04d。

## 测试前后

开工前已跑基线，见 [baseline.md](baseline.md)。API 全程使用 `pnpm --filter @warmap/api exec vitest run --maxWorkers=1`，未在参数前加 `--`。

| 检查 | 基线 | 完成后 |
|---|---|---|
| Contracts build / tests | build 通过；42/42 | build 通过；46/46 |
| API typecheck | 通过 | 通过 |
| API 全量 | 477 通过，8 失败（485） | 503 通过，同样 8 失败（511）；全部 50 文件，10 组串行 |
| Web typecheck | 通过 | 通过 |
| Web 全量 | 291/291，37 文件 | 314/314，39 文件 |
| gen:client | 基线无需生成 | 已执行成功，仅通过生成命令更新 OpenAPI JSON / TS |

已知基线失败均在 `deployment.test.ts`：Windows/Git Bash 下两个 compose backup 调用记录断言、六个 restore checksum/空目标断言失败。本单不改这些脚本。

第一轮全量回归为 500 通过、10 失败（510），日志 [api-final.log](api-final.log)。除上述 8 项外，`supplementMaterial.test.ts` 的 DOCX 预览及材料去重两项触发默认 5 秒超时；当时同时运行浏览器构建和 Web 测试。因此停止这些进程后重新独占运行完整 API 测试，同时纳入最后补的首页并发入口去重测试。

第二、三次运行中出现测试 worker 的 `ERR_IPC_CHANNEL_CLOSED`，未生成完整统计，日志 [api-final-isolated.log](api-final-isolated.log)、[api-final-complete.log](api-final-complete.log)。第二次的材料测试全部通过，两次 IPC 中断位置不同，均发生在旧业务测试期间。Tinypool 的 fork 子进程通道已关闭后仍发送消息；日志没有 heap/OOM/FATAL，不能把原因确定为内存不足。

随后追加 `pnpm --filter @warmap/api exec vitest run --maxWorkers=1 --pool=threads`，仍然仅一个 worker、执行全部断言，不改变产品或测试代码；运行 15 个测试文件后进程异常退出，返回 `3221225477 (0xC0000005)`，同样没有完整统计，见 [api-final-threads.log](api-final-threads.log)。这些中断不计作通过。

最终采用原命令 `pnpm --filter @warmap/api exec vitest run --maxWorkers=1 <本组文件>`，全部 50 个测试文件按名称排序分为 10 组，每组 5 文件，组之间串行。只缩短运行器的进程生命周期，未跳过用例、未放宽断言或超时；最终统计来自 [api-batches.log](api-batches.log) 及 `api-batch-01.log` 至 `api-batch-10.log`，不冒充一次全量长跑。长时间运行的本机 Node/Vitest 稳定性仍需环境侧复核。

10 组均生成完整统计：通过数依次为 45、42、66、77、12、34、57、64、45、61，总计 **503**；只有第 2 组中的原有部署测试失败 **8** 项。文件集合去重后正好 **50**，全部用例 **511**。API 与 Web 类型检查、客户端生成及 `git diff --check` 均通过。

测试按迁移、契约、仓储状态机、路由、调度、导入、Web 的顺序先红后绿。额外回归覆盖等待轮次锁期间撤换 DRI、首页并行读取时同槽 slot 与轮次重复、配置页顶栏不能把当前草稿写成已确认组织事实，以及到点后 closed 过渡态继续刷新直到 Review 写好的情况。未放宽测试超时，未跳过用例。

## 测试库演练

`missionDraftHome.test.ts` 在公开本机测试 PostgreSQL 54329 的随机一次性库中完成实际 API 链路：

1. 未签发时首页无整理入口，直接整理返回 409，并说明先签发。
2. 签发 2026-10 计划后出现真实 slot；非拍板人返回 403。
3. 并发整理同一份只读候选，两次都返回同一个轮次；得到 **1 轮、5 张卡、12 条 Mission**。Mission 均为 v1、`placeholder=true`、id=code，只挂战场 01；来源说明、四个补充字段、`待定 · ` 里程碑符合候选文件。
4. 同文件重放不覆盖、不升版本、不改变时间；文件内容变化返回 409，不增加对象。
5. 开放时间严格 +48 小时；到点快照只收截止前 1ms 的意见，恰在截止时刻的意见不收；快照记录全部 12 条 Mission 版本。
6. 重开变为第 2 轮，记录操作者、时间和原截止。仓储测试另验证下一次截止并入上轮截止后留言、结转处理结论而不结转核对备注，两个战场互不干扰。

并发开放、重复截止、重放、旧版本 latestCard、确认后禁止重开、当前权限与成员可见性、挂卡禁止普通编辑、有轮次禁止删除战场，以及 CLI 重跑均有测试。CLI 和入口使用同一个导入函数。

## 浏览器实走与截图

使用 `agent-browser` skill 和机器上已有 CLI；未安装浏览器依赖。独立会话 `mission04a`，Web 3500 / API 4500。Web 临时副本 `apps/web-04a-preview` 与 `apps/web` 同级，`src`、`public` 为真实复制；`node_modules` 为 junction。API 使用 [browser-server.ts](browser-server.ts)，合成人员与登录数据、固定十月应用时钟，不接外部模型或声纹供应商。

在页面中逐项核对公司/战场结果 → 勾选签发确认 → 点击签发计划 → 回到首页出现整理入口 → 打开并取消一次确认框 → 在手机宽度确认整理 → 入口变为“草稿 · 可以统一开放讨论”。点击已建轮次留在 `/`，提示“个人卡页即将上线”。两种宽度都无横向溢出：document.scrollWidth 分别等于 1440、375。

| 截图 | 状态 |
|---|---|
| [01-before-sign-1440.png](01-before-sign-1440.png) | 签发前，只有月度计划入口 |
| [02-sign-plan-1440.png](02-sign-plan-1440.png) | 页面勾选结果与签发确认 |
| [03-draft-entry-1440.png](03-draft-entry-1440.png) | 签发后出现整理入口 |
| [04-draft-confirm-1440.png](04-draft-confirm-1440.png) | 桌面确认框及占位来源说明 |
| [05-draft-entry-375.png](05-draft-entry-375.png) | 手机入口 |
| [06-draft-confirm-375.png](06-draft-confirm-375.png) | 手机确认框，实际点击整理 |
| [07-draft-ready-375.png](07-draft-ready-375.png) | 手机显示可以统一开放讨论 |
| [08-draft-ready-1440.png](08-draft-ready-1440.png) | 桌面显示新阶段与个人卡页提示 |

浏览器数据库 `warmap_test_0831aa5f4a81` 在整理后的 SQL 核验结果：`rounds=1, cards=5, missions=12, all_placeholder=true, all_v1=true, ids_equal_codes=true`。

截图之后仅补了配置页顶栏及 closed 过渡态轮询的两处修正，均通过最终 Web 测试；整理草稿的交互流程未改变。

## 设计补充与范围差异

- 未建轮次入口新增独立 `MissionRoundDraftPayload`，保持 slot 身份，不给 `MissionRoundSummary.roundId` 填假 ID。
- 权限检查放在重放和版本冲突响应前；拿锁后重新读取当前 DRI，避免旧权限令牌读取最新内容或继续拍板。
- `goal_snapshot` 除显示文本外保存战场与计划的 id/version，满足冻结依据的追溯要求；公开 goals 投影仍只有设计的三个字段。
- `viewCardId` 契约保留，但 04a 在写入前明确返回 400 `VIEW_CARD_NOT_AVAILABLE`，因为个人卡投影属 04b。当前 CEO 整理入口只使用轮次响应，不受影响。
- 真实只读候选含 `carriedFrom.note`，校验器接纳这个可选来源说明，其余未知字段（包括多战场字段）仍拒绝。
- 04a 倒计时每分钟重新读取服务端摘要；04d 再接共享分钟时钟。未实现产品演示时钟或 Agent 自动起草。

## 清理与约束核验

- 浏览器会话已关闭。本次 3500/4500 启动进程及子进程已停止；一次性库已删除，`pg_database` 查询 remaining=0；临时人员目录及 Web 副本已删除。先解除 node_modules junction，再清理副本，没有递归到原 Web 依赖。
- 受保护服务前后均为：3100/4000 → PID 22856，3200 → PID 58088，4100 → PID 63752。3400/4400 本来未监听；未停止任何其他服务。
- 副本存在期间执行 pnpm 检查曾触发工作区自动依赖同步，增加临时 importer 并改写可选 peer 解析；副本清理后恢复了原锁文件，缓存依赖按原锁重新连接。没有新增依赖声明，锁文件最终无差异。
- 所有 Git 命令均为只读检查（status/diff/ls-files/show），没有 add/commit/reset/checkout/stash/push。API 声纹文件未修改；未读取真实密钥文件。
- 候选 JSON 未修改，前后 SHA-256 均为 `5c133d53a18025e9f8466fa58fda30aedf25f6ac4713641d5480715756086712`。

## 仍需人工确认

- Claude 验收本单后提交。候选内容与待定里程碑仍需要团队讨论，整理草稿不代表个人承诺已经确认。
- 部署前核对实际配置的战场 01、能力域 03/04/05 及五位 Owner；本次只连接隔离测试库，未读取或修改真实业务库。
- 已确定后的纠错规则 GAP-04 仍待产品决定；当前一律锁定 `mission.edit`。完整制定闭环仍需接续 04b/04c/04d。

## 改动文件清单

完整清单见 [changed-files.md](changed-files.md)，按迁移、契约、API、Web、文档与验收证据分组。
