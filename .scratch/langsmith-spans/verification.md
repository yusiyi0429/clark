# Verification

Real SDK Client/RunTree with a controlled external transport exercises POST at actual start and PATCH at completion. PostgreSQL-backed HTTP tests cover a failed attempt, app rebuild, same logical-turn retry, completed replay, input conflict, nonduplicated user messages, stable UUID7 and separate trace roots. Real Pi provider/tool loops verify spans equal actual dispatch/execution counts; no reconstruction from fake SSE tool events. Model tests cover genuine first-token deltas, missing first-token/usage, cache usage, concurrent identities and private child agents. Existing observability credential/body redaction and transport-failure isolation checks are retained under the new wire protocol.

Live service ingestion is not verified: executor network policy does not allow api.smith.langchain.com. No credential is committed to source, documents or fixtures.

Results:
- API full run: 968 checks, 959 passed initially. Five failures concerned the migration expected list, memory-title redaction, database-seam fixtures, or a test counting unrelated background runs; fixes passed on focused reruns. Four existing material tests hit the default 5s timeout. The pre-change 27473b8 archive reproduced material-suite timeouts (5 failures / 13 checks); with a command-only 20s test timeout, all 13 material checks pass on the implementation. No material source/test assertions or configured timeouts were changed.
- Latest SDK/HTTP/security subset: 19/19; full main-conversation/runtime suite and identity/migration subsets also passed after integration. Retry/restart preserves trace identity and completed replay points to the saved execution id.
- Web full suite: 814/814 before the additional retry check; current hook subset 9/9 including that check. Web typecheck and production build passed.
- Contracts: 75/75. API TypeScript build passed.
- Diff whitespace checks passed. Ablation removed the obsolete posthoc adapter, temporary fetch compatibility, root tool/usage aggregates and unused trace-only display labels. Remaining context wrappers map directly to real execution boundaries; only the durable thread/attempt persistence is additional state.

Live cloud ingestion remains unverified under the executor network policy. Runtime key injection is required; no production deployment or production schema migration was performed.
