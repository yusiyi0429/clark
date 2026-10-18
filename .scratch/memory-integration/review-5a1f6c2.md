# 按 PR #12 最新 head（5a1f6c2）重新核对评审结论

上次评审基于 73e05cd。之后人豪推了两个提交：

- 971274c「align memory learning contracts and trace business outcomes」：按他自己 `.scratch/memory-clean-repro/findings.md` 的方案 A，对齐提炼候选的契约（新增 `status: apply | noop | needs_clarification`，提示词写明「每条 change 至少一条本轮证据」），把校验和写入包成 `finalizeCandidate` 放进轨迹，测试改成「记忆正文可进轨迹、凭证不进」。
- 5a1f6c2「make company query tool schema compatible with Qwen」：`query_company` 的参数 schema 改成 Qwen 能接受的形式，只动了 piConversationRuntime.ts 和对应测试。

核对方法：`gh pr view 12`、`git diff 73e05cd 5a1f6c2`、读 5a1f6c2 的源码（git archive 出来逐个看），`git merge-tree origin/main origin/codex/main-chat-memory-langsmith` 统计冲突。

## 已被修掉的

| 结论 | 现状（5a1f6c2） | 依据 |
| --- | --- | --- |
| CI 失败（langsmithSpans.test.ts:332、440，observabilitySecurity.test.ts:105，personalDistillation.test.ts:36） | **已修**。971274c 把这几条断言改成「正文可出现、`test-key` 不出现」；PR 上 deterministic-gates 为 SUCCESS（2026-10-16 11:10 UTC） | `gh pr view 12 --json statusCheckRollup`；`git diff 73e05cd 971274c -- apps/api/test/langsmithSpans.test.ts apps/api/test/observabilitySecurity.test.ts` |
| 提炼候选契约不清，自然学习整批被拒（人豪自己的复现：模型引用旧轮证据 → `NO_CURRENT_USER_EVIDENCE`） | **部分修**。提示词和 schema 描述写明「本轮证据」，加了 `status`。整批原子拒绝的设计保留 | personalDistillation.ts:7-19 |

## 仍然存在的

| 结论 | 现状（5a1f6c2） | 位置 |
| --- | --- | --- |
| 存储：每人一个 Personal.md，DB 只记版本 | 不变。`memory_documents(revision, pending_revision, epoch)`，正文在 `<storageDir>/<directory_id>/Personal.md` | migrations/061；personalMemory.ts:76-114 |
| 条目只有 id、title、text，没有时间、anchor、替代标记 | 不变 | personalMemory.ts:6-10 |
| 全文 16 KiB 上限，整份覆盖写 | 不变。`write()` 每次 `serialize(items)` 重写整份；超过 16384 字节直接抛 `PERSONAL_MEMORY_TOO_LARGE`，提炼得到的新条目整批丢弃 | personalMemory.ts:135-147、157 |
| 每条消息排一个 explicit 任务，回答完再排一个 natural | 不变 | routes/conversations.ts:279-281、434-437 |
| 按人串行；输入最近 12 条用户消息 + 整份记忆；限时 30 秒；最多调 light 模型 2 次 | 不变 | personalDistillation.ts:78、99、104 |
| 命中「不是/改成/删除/记住…」正则时在请求内同步跑 | 不变。正则还会命中大量普通句子（「不是」「不想」「记忆」），这些句子都会同步等一次提炼 | personalDistillation.ts:25-27；routes/conversations.ts:289-296 |
| 同步路径失败时替换主回答、上下文存成 [] | **仍在**（推断已由代码确认）。`memoryClarification` 非空时不调主模型，回答直接是「个人记忆修改尚未完成，已保存请求稍后重试。」等文案，`runtimeEntries: []` 写回且 `context_schema_version=2`，下一轮 `rebuildFromRaw` 为 false，从空历史开始。抢不到锁（`PERSONAL_MEMORY_BUSY`）、超时、校验失败都会走到这里 | routes/conversations.ts:292、364、408-427 |
| 任何显式改动清空本人所有会话的上下文 | 不变。`invalidate()` 对 `owner_id=$1` 的全部会话 `runtime_entries='[]'`、换 `pi_session_id`、推进 `memory_history_cutoff` | personalMemory.ts:116-134 |
| 读取：Anchor、Reference（二字词匹配）、read_anchor / query_company / search_memory / read_reference，无检索原始聊天的工具 | 不变 | piConversationRuntime.ts:380-510；personalMemory.ts:220-240 |
| 提炼提示词只记偏好和习惯 | 不变。「记忆是长期个人偏好、习惯、个人约束」 | personalDistillation.ts:19 |
| 与 #10 冲突 | **仍在**。merge-tree 报 39 个冲突（上次 38；多出的是 `infra/staging/runbook.md` 的 modify/delete）。两边迁移都占 060–063；trace_threads 两套表结构（#12：`business_key, thread_id` + `trace_turns`；main 066：`thread_key, thread_id, turn_no, attempt, turn_status`）；LangSmith 两套实现（#12 `langsmith.ts`，main `tracing.ts`） | `git merge-tree --write-tree --name-only origin/main origin/codex/main-chat-memory-langsmith` |
| World 读不到时拒绝回答 | 不变。`company.ts:181` 返回「未使用旧记忆或本地信息补充正式事实」，系统提示写「不可用不等于不存在，不得以本地目标、页面草稿或历史替代」。main（#10）的 `read_ontology` 读不到时回退本地 | company.ts:181；piConversationRuntime.ts:79、131 |

## 新发现（本次核对时看到）

- #12 把非任务卡页面的看板工具（`get_warmap_overview`、`list_missions`、`list_pending_issues`、`read_ontology`）从主对话里拿掉了（`availableBoardTools = personalCard ? boardTools(...) : []`，piConversationRuntime.ts:447）。main 上这些工具是一号位主对话的主力，接回时不能带这个改动。
- #12 把 `companyMemory.ts`（本地知识库 + 人员目录）拆成 `peopleDirectory.ts`，并改了约 60 个文件的 import。这是重命名式重构，和记忆功能本身无关。
- `query_company` 依赖按人授权文件 `COMPANY_WORLD_ACCESS_FILE`（personId → domain 列表），没有这个文件时一律 `coverage_unavailable`。部署时需要配置。
