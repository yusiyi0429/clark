# Ticket04 review and validation

Fixed point: `0378e37cb6505a6f4f9f131eb522d41520ab7854`.
Diff: `git diff 0378e37cb6505a6f4f9f131eb522d41520ab7854...HEAD`.
Implementation commits: `1c633a1`, `d36454e`, `db2c7f9`.

## Standards

Initial independent review: **0 actionable findings; worst: none**. Persistence remains outside Pi, HTTP authentication stays at the route boundary, contracts use TypeBox and generated OpenAPI/client output. Production `personalMemoryStorageDir` environment and persistent volume wiring belong to Ticket06; production deployment durability has not been verified in this ticket.

## Spec

Initial independent review: **2 findings; worst: P1**.

1. Blocking personal advisory locks could prevent main chat from reaching its timeout. Fixed with a fail-fast advisory lock and reusing the already-held conversation DB connection for Personal selection, avoiding nested pool acquisition.
2. A completed forget during asynchronous turn assembly could still send previously loaded Runtime/history into the model. Fixed by rechecking the persisted memory barrier immediately before Runtime invocation and discarding stale entries/history/references. Checkpoint and final-result writes also preserve the forget barrier; a late assistant message is retained in raw chat but excluded from future model history.

Both findings are fixed and covered by failing-then-passing public regressions. Known unresolved findings: **0**. A second independent ticket-level recheck was not run; the coordinator reserved remaining review slots for Ticket05 and the final PR-level independent review will assess the integrated result.

## Validation

- Public service/HTTP/ConversationRuntime seams; real isolated PostgreSQL databases and temporary files.
- Initial RED: missing module, absent own HTTP endpoints, missing Personal Reference.
- Further RED: multi-paragraph section split changed stable identity; reauthorization ignored explicit evidence; late assistant answer reentered post-forget history.
- Review ablation RED: removing try-lock made main chat exceed a controlled 1-second bound; removing the pre-Runtime epoch check sent stale entries after an acknowledged forget.
- GREEN: 28 focused tests across `personalMemory`, `personalMemoryRoutes`, existing `conversationMain`, existing `conversation`.
- API typecheck and contracts build passed. OpenAPI and web types generated from schemas.
- Interrupted persistence test verifies filtered excluded data never returns to model or own GET, and a renamed file with pending control state is recovered without discarding retained content.
- Semantic exclusion tombstones are bounded backend-only hints (100 returned, text bounded to 2048 characters) for Ticket05's natural-distillation guard; they are never included in the main model Reference.

## Ablation

The two review safeguards were temporarily removed independently and the corresponding public regressions failed, then passed when restored. Per-person locking, pending revision recovery, exclusions, and epoch/CAS are needed for the approved concurrency and forgetting guarantees. Handles are bounded and checked against owner and document revision; no generic memory engine or UI was added.

## Integration ownership

Ticket02 injects ephemeral Reference at the provider boundary; Ticket03 registers unified memory tools and maps model-facing Personal handles; Ticket05 owns natural distillation and explicit chat correction/forget detection; Ticket06 wires production storage paths/volumes; Ticket07 performs integrated and full-suite verification. This ticket verifies its public boundaries without claiming live provider or deployed persistence validation.
