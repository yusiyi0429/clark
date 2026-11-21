# Iteration 2 — review counterexamples

Baseline preserved in versions/v1/source.zip before review fixes.

Observed focus counterexample (independent controlled DOM/hook trace): after resolving #team-reply-A, arrival of unrelated B reopens/focuses A under unchanged hash. Expected fix: remember success for current navigation; retain retries for initially unresolved anchors and explicit later hash navigation. Judge via production effect callback regression, not a browser UX claim.

Observed sorting counterexample (source and deterministic timestamps): WorkTimeline sorted ISO strings lexically before placement. 12:00+08:00 is earlier than 05:00Z; a shared message gap or untimed history could show them backwards. Expected fix: sort valid times by parsed instant, preserve stable equal-time order and existing afterSequence placement. Judge with both untimed/timed history regression and original work suite.

Layout risk established by CSS: meetings in flex:none header have unbounded open schedule list. Expected fix: bounded scrollable schedule body, retaining visible summary and native disclosure. Judge source constraints and SSR structure; true 320px/short viewport geometry still requires browser evidence.

Source/association: native fragment navigation should be an explicit focus event; background polling should update evidence without repeating navigation. Bounded schedule list borrows the already-used SubSessionSummary/queue containment mechanism. Analogy limit: containment alone cannot prove ideal readable space or touch behavior.

New judgments remain candidate for UX. Numeric sorting can receive local_supported only within executed valid-time fixtures. No user preference or real task benefit inferred.

Additional observed action counterexample: API can return ready + needsAction + recordHref for pending confirmations or failed organization. The card promoted inline transcript reading, which has no confirmation controls. Expected fix: after join/unmatched precedence, promote the actual meeting route with a truthful generic action; keep transcript reader secondary and keep ready/no-action reading shortcut. Judge ready and attention fixtures against actual rendered primary anchor.

Sorting result: the new two valid-offset fixtures failed before implementation (38 existing tests passed), then all 40 work component tests passed after numeric sorting. Same-instant insertion remains stable; afterSequence coverage remains unchanged. This supports those deterministic ordering cases only.
