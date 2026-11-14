# Iteration 1 — actual workspace implementation

Gap → the original BuddyView appended meeting, handoff and queue panels after chat chronology; recipient history expanded by default; running summary included acceptance rework. These were observed in source, not inferred from user behavior.

References → actual official Muse design essay, OpenAI dots feature page, and xAI Grok Bot overview from the preceding UI assessment. Transfer the primary conversation + secondary activity/details pattern. Existing WorkTimeline and InputBar height observer provide the implementation mechanism. Analogy fails at team receipt authorization, explicit meeting confirmation, and long multi-recipient workflows; those retain TianShu's own rules.

Experiment → real isolated branch changes, unchanged APIs/permissions, progressive disclosures, feed hooks, scheduled/occurred separation, measured queue beside input, historical receipt-target links and separate running/rework counts. Expected benefit and criteria were recorded before each module in task reports. Baseline a1f365a1 and v0 archive preserved; first implementation preserved in versions/v1/source.zip.

Result → initial selected baseline 24 passed. Root first checks: status/draft/queue14 passed; main composition1 passed; web typecheck exit0. Module implementers recorded their own specific red/green checks. Independent review found four concrete issues for iteration2: reply-update focus stealing, unbounded header schedule, mixed-offset string chronology, and primary record reading instead of an awaited meeting action. No browser visual score or improved user completion time is inferred.

Judgment → keep structural direction provisionally and fix the four counterexamples. Compactness as a UX benefit remains candidate. Source-level tests support only represented markup/state/routing properties, not real comprehension, touch, theme contrast, live provider behavior or production permission validation.
