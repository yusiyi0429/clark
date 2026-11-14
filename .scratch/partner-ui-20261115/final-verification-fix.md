# Final verification fix — interactive event identity

Independent whole-branch review found F3: WorkTimeline puts an event inside the after callback of a message-specific Fragment. Appending untimed history reparents the event from turn-N to turn-(N+1), causing a React remount even with an unchanged event key. Meeting record panels and handoff selections/instructions can be lost; hash focus can replay.

This is material to continuous work: pendingUserMessage itself can lack createdAt, so treating only permanently untimed histories is insufficient. Both timed→untimed→timed and repeat append must preserve the event's React parent.

Expected remedy: add an optional insertion path to ConversationTurns that renders message fragments and inserted event wrappers as one flat keyed sibling list. Preserve original turn, after/footer/status and streaming behavior for existing callers. WorkTimeline's actual-instant/afterSequence placement still determines visible order; only React ancestry changes. No fabricated times or global draft model added.

Acceptance: actual production React element ancestry/type/key stays identical for a stable meeting/handoff across bucket moves; new insertions appear once and preserve chronology; existing work/transcript tests pass; full web regression and semantic typecheck complete. If an installed real lifecycle renderer is unavailable, topology evidence is explicitly bounded: no fake browser or user typing observation is inferred.

Design lesson remains candidate beyond this mechanical condition: stable IDs alone are insufficient if an interactive component changes keyed parent. The existing card draft and deep-link behavior must be considered when moving data into one timeline.
