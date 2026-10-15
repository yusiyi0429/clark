# Ticket07 integration and review evidence

Fixed review base: `9e4779bb575b7b4a7fe93d6e5c22a78e41776f1d`. User-approved final PR review base remains `b32e531eb2df7e0396393877aa509569364fde9a`; the parent agent owns that independent overall review.

## Delivery

- Historical context schema upgrades discard replaceable legacy Pi JSON and rebuild from original user/assistant rows. Baseline route already stored `req.body.message` separately from the old JSON provider prompt; no JSON decoding heuristics, raw-history deletion, or bulk Personal import are necessary.
- Real Fastify → default Pi → actual Personal assembly is tested using a provider seam, including short reference handles, search, and lossless long-section pagination. Old clients omit new fields and remain supported.
- Four temporary read tools keep their actual results in a run-private map. Pi receives paired placeholders; only the main provider copy after the latest user message receives live content. Cross-turn reused call IDs cannot recover old bodies. Budgets run after restoration; compaction never sees restored bodies.
- Escaped Card/attachment/Personal prose is paginated against JSON byte size. Personal headings generated inside one attribute cannot split its stable identity. Valid long Personal sections keep a bounded recall excerpt and a version/resource-bound expansion cursor; model cursors are short per-turn aliases.
- Complete current user text reaches distillation even when a forget intent appears after character 8,000. Only older context is reduced. A clarification response does not enqueue a second natural job.

## TDD and ablation evidence

Each change has a public-behavior regression, not a check of the evaluation JSON:

| Regression | RED | GREEN / necessary boundary |
| --- | --- | --- |
| Escaped attachment expansion | 12,133 JSON bytes exceeded 8,192 | Complete document reconstructed from bounded tool pages |
| Escaped Anchor expansion | 9,011 JSON bytes exceeded 8,192 | Authorized Card read stays bounded |
| Expanded memory persistence | `OLD_EPHEMERAL_BODY` persisted and appeared next turn | Live provider body retained; entries and later turn omit it; repeated tool IDs do not cross turn boundary |
| All four read tools | Supplementary coverage of the same path; preceding row records the public RED | Current provider sees Anchor/Company/Personal bodies; Pi entries only paired placeholders |
| Generated Personal subheading | One stable attribute became two | `apply → readOwn → forgetOwn` removes the complete attribute |
| Long Personal section | Valid >4 KiB section disappeared from select | Summary remains recallable, complete text paginates losslessly |
| Cross-section cursor | Numeric offset accepted for another section | Backend handle/revision binding and runtime PC aliases reject mismatch |
| Current query tail | Actual provider input 8,000 versus 18,009 characters | Complete current query and tail evidence preserved; remove succeeds |
| Ambiguous forget | `processNext` found an unnecessary natural job | No second classification before user clarification |

Removing the live-result overlay breaks current tool-loop reading; removing the placeholder breaks persistence isolation; removing JSON-aware byte reduction breaks escaped text; removing heading normalization breaks forget identity; removing the current-query exception drops the explicit intent. These are directly needed boundaries. No new dependencies, generic retrieval framework, or arbitrary local skill access were added.

## Checks

Isolated PostgreSQL 17: `postgres://postgres:postgres@localhost:54329/postgres`. No production data or credentials used. Exact logs were kept in `/tmp` during execution.

| Command / scope | Result | Log |
| --- | --- | --- |
| API `node node_modules/vitest/vitest.mjs run --maxWorkers=4 --testTimeout=30000` | Initial full run: 94 files, 949 tests; 944 pass / 5 fail, 362.40s | `/tmp/memory07-api-full.log` |
| Web full test | 98 files, 814/814 pass | `/tmp/memory07-web-full.log` |
| Contracts full test | 8 files, 75/75 pass | `/tmp/memory07-contracts-full.log` |
| M2 existing ordinary Node tests | 96/96 pass | `/tmp/memory07-m2-full.log` |
| `pnpm typecheck` | All four workspace projects pass | `/tmp/memory07-typecheck-full.log` |
| `pnpm build` | Contracts/API/Web/M2 all pass | `/tmp/memory07-build-full.log` |
| Web `gen:client` | OpenAPI and schema regenerated with no content diff | `/tmp/memory07-openapi.log` |
| Changed memory/Pi modules, 7 files | 59/59 pass at `aed5a3d` stage | `/tmp/memory07-delta-focused.log` |
| Initial failed behavior files except thread timing, 4 whole files | 52/52 pass | `/tmp/memory07-compat-retest.log` |
| Final changed behavior tests | 4 files, 32/32 pass (distillation13, thread7, main integration7, boundaries5) | `/tmp/memory07-final-green.log` |
| API typecheck/build after last source delta | Both pass | `/tmp/memory07-final-tsc-afterdelta.log`, `/tmp/memory07-final-build-afterdelta.log` |

The broad API run was not repeated after fixes. Four failures were fixed and rechecked: expected migration list/count, retired CompanyMemory shape, ResearchDoc tool/Company input shape, and invalid Reference validation occurring after an unrelated malformed-home fixture was projected. The latter was traced to `projectMonthlyPlanCard` reading `negotiation.feedback` in a fixture with `{}`; Reference authorization now fails before that unrelated projection. No home projection exception is swallowed.

The fifth failure was an existing test timing assumption: task creation already writes a fixed introduction; inviting a collaborator writes another introduction. Waiting for total message count exactly one can pass before the invitation arrives or fail once both messages arrive. A baseline detached checkout at `b32e531` passed the single test before the second write; a controlled 100ms observation on the integrated code showed both expected messages. Product code in this path differs only by the directory migration. The test now waits via public HTTP for the actual invitation content exactly once, preserving its intended assertion. No group product change was made. The complete seven-test file is included in the final focused command.

Next build's generated `next-env.d.ts` path changes were restored to the prior tracked content; generated OpenAPI files remain unchanged.

## Independent code review

Standards agent: initial and `aed5a3d` delta reviews found 0 actionable issues. Spec agent: initial review found 0; delta found one P2 resource-binding issue in the new Personal cursor. The issue was fixed with backend handle binding plus run-local short aliases and public cross-section mismatch coverage. Final independent delta reviews at `3861244`: Standards **0** actionable findings, highest severity none; Spec **0** unresolved findings, highest severity none. The earlier P2 cursor issue is closed. Reports distinguish these axes; no merged ranking.

## Acceptance limits

See [the 30-case matrix](../acceptance-matrix.md). It maps every fixed scenario to actual public mechanism tests and explicitly marks untested natural-language semantics. The fixture checks do not establish real model answer quality, inference quality, hypothetical-statement classification, prompt-injection resistance, or full live World coverage. Real World/model credentials were unavailable; no live acceptance, deployment, or provider latency comparison was performed.

Each ordinary successful turn can cause an explicit-intent classification and a natural distillation request in the background. This is the durable fallback for corrections expressed outside a fixed phrase list. Its latency/cost in a real provider remains unmeasured.


## Integrated commit selection

Own code: `ec30929`, `aed5a3d`, `3861244`. This branch also contains copied dependency commits `6fff41d`/`7a58f73`/`0b1a043`/`1ae2d5d` from Tickets05–06; the parent integration branch already has their original equivalents and should skip these copies.

## Final PR follow-up: same-turn clarification barrier

The parent’s independent PR-level Spec review found a further P2 after Ticket07’s reviews at `3861244`: a non-regex request could leave both explicit and natural jobs queued; the explicit classification could ask for clarification without changing the memory epoch, then the natural job could delete the unresolved attribute. The synchronous route guard alone covered only requests processed before the main reply.

The worker now checks an existing explicit job for the same person/conversation/user sequence before running a natural job. An unresolved, failed, or clarification-bearing classification supersedes natural processing without calling the model or applying changes. A successful ordinary no-op permits natural learning; a missing explicit row preserves existing direct/legacy natural-job behavior. This is a worker-side intent barrier, independent of phrase matching or process restart.

Public worker RED: clarification and terminal-failure scenarios both allowed the queued natural job to delete `drink`; successful no-op already passed. GREEN: the complete distillation file (16 tests) plus Personal HTTP routes (5 tests), **21/21 passed**, and API typecheck passed. Logs: `/tmp/memory07-explicit-barrier-red.log`, `/tmp/memory07-explicit-barrier-green.log`, `/tmp/memory07-explicit-barrier-tsc.log`. No broad suite was repeated. Parent independently reviews this final delta before delivery; earlier Ticket07 zero-unresolved counts apply to their stated fixed tip.
