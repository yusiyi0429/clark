# 05 — 主私聊结束后自然蒸馏个人记忆

Type: implementation
Status: resolved

**What to build:** 用户自然表达长期偏好或反复的个人情况，无需说“记住”，会在后续私聊中体现；当前回答不被后台蒸馏阻塞。

**Blocked by:** 04（持久存储、版本、遗忘和主聊消费已可用）。

- [x] 对话成功提交与持久任务排队一致；重启、重复消费和并发更新不丢失或覆盖新纠正。
- [x] 只依据本人消息蒸馏，不把 Company、Anchor、假设、他人话语或助手推测当本人事实。
- [x] 支持 add/update/remove/noop，区分明确偏好与谨慎归纳；失败不影响主回答。
- [x] 明确纠正/遗忘不依赖助手成功回答；旧任务不能复活已遗忘内容。

**TDD seams:** messages HTTP 到下一轮公开记忆读取的完整行为、Personal 蒸馏 worker 的公开任务接口；模型响应在 provider 边界受控，不 mock 内部函数。

## Execution

Each ticket uses one implement subagent in an isolated worktree; red/green evidence and Standards/Spec review evidence must be recorded before resolution. User-approved public seams and fixed point are in ticket-breakdown.md.

## Implementation evidence

- Commits: `0361613`, `9b64eec`, `8020d46`, `5580549`, and the final receipt-governance commit. Skip dependency cherry-picks `ccaf842`/`c33f738` when integrating with Ticket 04 already present.
- Public seams: main Conversation HTTP → own memory GET; durable worker enqueue/processNext/status; controlled Pi provider responses. Setup SQL creates input histories; assertions inspect public memory and job status. AgentRun audit inspection verifies no second copy of private text.
- Red → green: successful HTTP turn had no future Personal memory before route wiring (`/tmp/memory05-red02.log`); old-only evidence incorrectly rewrote a later unrelated turn (`/tmp/memory05-red04.log`); malformed structured submissions made 3 provider calls rather than the budgeted 2 (`/tmp/memory05-red07.log`). Their corresponding fixes pass.
- Review regressions: newer explicit intents and manual-forget barrier; a fully occupied 5-connection pool using the held route connection; a new scope when the person already has epoch > 0; 100 exclusions stop automatic additions; same-topic/new-key recovery requires precise explicit permission.
- Latest complete focused run: 13 existing Conversation tests + 10 distillation tests = 23 passed (`/tmp/memory05-finalallfocused.log`). Personal and candidate runtime focused tests also passed (18 total including the 10 distillation tests in `/tmp/memory05-finalfocused.log`). API TypeScript check passed (`/tmp/memory05-typecheck07.log`). An earlier buildable claim used the wrong prior log; the later check fixes the unsupported SDK import and is the authoritative result.
- Ablation: temporarily disabling private audit redaction makes the observable AgentRun assertion fail (`/tmp/memory05-ablation-audit.log`); redaction was restored. Removing the provider-call cap produced the documented failing 3-call result. The job ledger, epoch barrier, bounded excluded-attribute context, and shared connection are required by the observed failure modes; no generic queue abstraction or new dependency was added.
- Independent review: [report](../reviews/05-natural-distillation.md). Standards: 0 findings. Spec: 2 P1 findings corrected with regressions; final PR-level review remains Ticket 07.
- Environment: real PostgreSQL in isolated throwaway databases and real installed Pi SDK; provider is controlled. No live model quality or real personal information was used. Natural semantic extraction and same-attribute equivalence still require live-model evaluation. Lexical triggering controls only synchronous execution: every received main-private user message now queues an explicit-intent classifier atomically with its raw message, so unfamiliar wording and main-model failure do not lose the instruction. This adds one bounded background classification per turn in the MVP.

- Final receipt loop: `arbitrary wording` public HTTP test first failed with Personal still containing the removed preference (`/tmp/memory05-red11.log`); atomically persisting raw user + explicit-check job passes after worker restart (`/tmp/memory05-green11.log`). The fast-path regex no longer gates durable queueing.
- Final remove loop: a natural-stage remove originally let an older delayed job revive the preference (`/tmp/memory05-red12.log`); remove now uses explicit epoch/exclusion governance and rejects inferred forget evidence. The regression now proves the old task is superseded and a semantic tombstone remains.
- Authoritative final focused run: 33/33 across 12 distillation, 13 Conversation, 5 Personal, and 3 candidate-runtime tests (`/tmp/memory05-final12.log`); API TypeScript check passed (`/tmp/memory05-typecheck08.log`). The private-audit ablation was restored and its focused test passed (`/tmp/memory05-ablation-restored.log`). No full suite was intentionally run for this ticket; an initial `pnpm test -- path` invocation accidentally started broader discovery and was stopped, then all checks used explicit Vitest file arguments.
