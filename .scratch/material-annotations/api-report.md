# 材料批注 API 实现报告

范围：工单 `issues/01-api.md` 的 apps/api 部分。未改 Web 或契约字段，未新增依赖，未执行 git 写操作；保留其他会话改动。

## 文件

- 新增 `apps/api/migrations/049_material_annotations.sql`。
- 新增 `apps/api/src/materialAnnotationAgent.ts`、`materialAnnotationQueue.ts`、`materialFeedback.ts`、`materialHistory.ts`、`materialSelection.ts`。
- 修改 `apps/api/src/objectMaterials.ts`、`materialDiff.ts`、`piConversationRuntime.ts`、`routes/materials.ts`、`app.ts`。
- 新增 `apps/api/test/materialAnnotations.test.ts`；修改 `helpers.ts`、`migrate.test.ts`、`objectMaterials.test.ts`、`piConversationRuntime.test.ts`。`app.ts` 和 migration 测试基于原有未提交内容增量修改，保留已有 seen marks 接线与 048 记录。

## 实现

Migration 049 新建批注表和修改提议表；批注有作者/clientId 唯一约束、六种状态 CHECK；修订增加可空 `annotation_id` 外键，并用唯一索引保证同一批注最多对应一版。提议保存 edits JSONB、面向的人、可空 conversation_id、四种状态及决定时间。

串行队列按 materialId 维护进程内 Promise，数据库按 created_at/id 选最早待处理批注。认领时持有材料行锁并提交 applying；执行时再次持有 `FOR NO KEY UPDATE` 行锁，其他 worker 遇到 applying 队首不能越过。锁内读取最新版、运行 heavy Pi Agent，再调用现有 `editObjectMaterial` 复用同一事务落版。直接修改、恢复及应用提议与该锁互斥；修订和 applied/applied_version 原子提交。失败用 savepoint 回滚本次尝试并重试一次；第二次仍失败则 failed。幂等命中先只读返回，避免重复请求等待正在修改的批注行。

启动及每分钟恢复 queued/超时 applying：先按 annotation_id 查修订，已有修订直接 applied；否则 applying 超过十分钟重新认领。恢复也取得材料行锁，不会打断还持锁运行的 Agent。认领后执行前再次检查状态，停顿进程恢复时若其他进程已经处理完成则跳过。每次模型调用限五分钟，服务关闭传播取消信号。恢复查询失败只记录错误并等待下次轮询，保留数据库故障时健康接口的 degraded 响应。

`revision.annotation`、`revisions[].annotation` 和 `lastRevision.annotation` 返回对应批注及作者，无批注则 null。`blocks.history` 通过相邻版本的现有分块 diff 顺序对齐，将未变块的历史向后传递，modified/added 追加一条，新的在前，最多五条；第 1 版、旧版与 HTML 无历史。

`removed` 汇总历次 removed 块，Markdown 按块、HTML 按非空行且去标签后非空；稳定 ID 为 `v<删除版本>-<原块下标>`。只要之后任一版出现完全相同文本，就注销该次删除记录；之后再删会得到新记录。恢复优先插在原前一块之后，该块不存在则插到原位置附近或文末，沿用现有落版与群消息；旧 version 返回 409 `VERSION_CONFLICT`，PDF/Word 返回 400。

提议工具在现有材料工具的相同对象范围提供，校验 find 唯一后仅保存 pending。详情只给当前查看者的 pending；旧提议在最新版不再匹配时置 stale。只有本人能 apply/dismiss；apply 重新在锁内验证最新版，失效返回 409，仍可匹配则落版。HTML 预览注入选区 postMessage 内联脚本，下载源码不注入，PDF/Word 不注入。

## 提议相关提示词

CEO 与 DRI 提示词均已更新：对方同意当前材料的具体改法、形成明确共识但未要求执行时，主动调用 `propose_material_edit`，本人点「按这个改」才生效；明确说「改／写进去」继续直接 `edit_material`；不确定是否共识就不提议。修改或提议前先 `read_material`，沿用 HTML 保持标签结构、不加外链脚本约束。

## 验证

- 相关测试最终 76 通过、0 失败（9 个文件，含批注 14/14、可观测性 9/9）。覆盖幂等、只读 kept、单/双队列串行、最新版输入、no_change、重试、恢复防重复、认领进程停顿、批注修订、跨版本历史、垃圾篓恢复、提议权限与失效、HTML 预览及 Pi 工具。最终相关批次原为 75/76，PDF 预览准备阶段达到原有 5 秒超时；全量结束后串行复测通过，未改超时或断言。证据：`api-final-related.json`、`api-timeout-recheck.json`。
- 契约编译 `node node_modules/typescript/bin/tsc -p tsconfig.json` 通过；API `node node_modules/typescript/bin/tsc --noEmit -p .` 通过；差异空白检查通过。
- 全量 API 完整运行一次：79 个文件、819 条用例，原始结果 **805 通过 / 14 失败 / 0 跳过**，无 Node 崩溃。全量进程启动早于最后两处修正：降级健康检查与停顿恢复竞态两条本次相关失败均已修复，并在新进程复测通过；PDF 预览、语音输入两条原有 5 秒超时也在全量结束后的串行复测通过（7/7）。证据：`api-full.json`、`api-full.log`。
- 按每个文件最后一次执行汇总：**809 通过 / 10 失败 / 0 跳过**。剩余全部为用户已知无关失败：部署脚本 9 条、导入 CLI 默认 5 秒超时 1 条，没有遗留本次相关失败。此数字为全量加复测汇总，不是第二次全量重跑；详见 `api-validation-summary.json`。
- 所有 API 测试均设置要求的 TEST_PG_URL，并使用 `node node_modules/vitest/vitest.mjs run --maxWorkers=1`，未用 pnpm exec / --filter。契约测试未运行，契约仅重新编译。

## 限制

没有未完成的 API 功能或契约字段疑问。未调用真实模型、未做 Web 联调；Pi 行为使用受控模型流及桩 Agent 验证。迁移仅由测试应用到隔离测试库，没有修改现有业务库或部署应用。
