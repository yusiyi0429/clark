# Iteration 3 — existing input design contract

Evidence: full web regression reported 2551 passed / 2553 total, two failures in field-style.test.ts. Handoff CSS introduced resize:vertical for textarea and a >=2px outline for its focus rule. The existing test documents the user's earlier unified input styling preference; this is real repository evidence, not a new subjective aesthetic judgment.

Expected change: preserve visible keyboard focus and wrapping while using existing --field-* input colors/border/ring, no manual textarea resize, and keeping normal focus outlines on non-input controls. Do not relax existing tests.

Mechanism/source: actual field-style.test.ts and global input rules govern these controls. Reuse established token behavior rather than invent another field treatment. Analogy limit: compliance does not prove readable contrast, touch, focus visibility or ideal text-field geometry in a browser.

Judge via the formerly failing policy cases, handoff regressions and complete final web suite. Regenerate real-component gallery after CSS changes to maintain matching source hashes. Save final checkpoint and reusable records with evidence limits.

Result: policy+handoff targeted24/24 passed without weakening tests. Final309-file web suite2566/2566 passed after the additional final identity correction. Gallery regenerated and root verification passed; visual/user criteria remain unverified.
