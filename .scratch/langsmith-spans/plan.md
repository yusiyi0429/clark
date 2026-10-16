# SDK trace implementation

Base: 27473b8. Scope: API Pi and shared candidate runtime; web only durable turn identity/retry plumbing. Native LangSmith Threads/Traces views provide Thread/Turn switching; each root is one execution attempt, never an aggregate session.

Use RunTree at actual dispatch/execution boundaries. Allowed metadata is restricted to the user-provided eleven keys. Caller is a tag. Persist UUID7 thread associations and logical-turn attempt counters. Carry main conversation identity across retries; background jobs have explicit logical job identities and the same durable conversation thread where applicable. Preserve existing memory/credential redaction.

Verification reuses the approved public HTTP, Runtime/provider and external transport seams. Test real SDK payloads against controlled transport, real Pi tool loops/compaction, and PostgreSQL-backed retry/restart identity. No production payloads or credentials in fixtures. Live LangSmith API access is not permitted by the current executor's destination policy; do not claim live ingestion.
