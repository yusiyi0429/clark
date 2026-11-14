# Main integration experiment — preregistration

Gap (observed): BuddyView appends meetings/handoffs/queue after WorkTimeline rather than ordering occurred events; queue always expands entire messages; summary combines running and failed.

Expected improvement: chronological real events in one conversation; future schedule in header disclosure; pending queue beside input, default compact except failures. Existing InputBar.dock participates in its ResizeObserver measurement, so use that instead of an unmeasured floating overlay.

State evidence correction: PlanDecision.subStage explicitly defines failed as acceptance rework (重做中), not necessarily a crashed runner. Preserve that wording and count rework separately; do not invent a new user-attention/error state or claim backend failure semantics changed.

Criteria: actual running count excludes failed; no duplicate standalone meeting/handoff; pending queue action eligibility unchanged; no network/durable draft semantics change; full text/retry reachable and primary controls 44px. Relevant regression/type checks plus independent review. Browser geometry and user comprehension remain unverified without observation.

Sources: installed Next client component guide; existing InputBar ResizeObserver and contract enums; Muse/dots/Grok Bot official research cited in stage design. Analogy limit: timeline consolidation does not prove chronological choice improves real task completion.

## Results and review follow-up

- Status test red: 2 expected failures exposed combined count; green: 5 status cases passed. Existing failed row icon label also says 重做中 rather than announcing a running process.
- Status/draft/queue targeted group: 14 tests passed. Buddy workspace integration: 1 passed, asserting all four block types and single measured input queue.
- Root web semantic typecheck: exit0.
- Independent review confirmed queue participates in InputBar's ResizeObserver/log spacing. Found unbounded header schedule (Task3 owner fixing body scroll containment).
- Independent meeting review found mixed-offset chronology in shared WorkTimeline. Root expanded scope narrowly to that helper and its existing test file; 2 new cases red then 40 work tests green. Valid times sorted by instant; equal instants stable; original at strings and sequence placement retained.
- Final web suite:309 files,2566/2566 passed,0 failed/0 pending. Fresh semantic typecheck exit0;23 frozen source hashes unchanged. Browser/phone/actual keyboard and live permission/navigation remain unverified.
