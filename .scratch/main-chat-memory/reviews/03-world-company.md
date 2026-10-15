# Ticket03 · World Company review

Fixed base: `0378e37cb6505a6f4f9f131eb522d41520ab7854`.
Initial reviewed commits: `9e3d261`, `ee9ca9f`, `e82a983`.
Two independent read-only agents reviewed Standards and Spec in parallel. Root schedules integrated follow-up review after the fixes below.

## Standards

0 hard violations; 1 optional P3 judgment (Duplicated Code): Company/Personal per-turn handle registration uses the same small lookup-and-register shape twice. Reviewer explicitly considers retaining the two local branches compatible with repository MVP/YAGNI guidance. Kept without a new abstraction.

## Spec

2 initial P2 findings, both corrected:

1. Company reference handles originally bound only object/chunk position. They now bind the normalized document content and business revision/version. Expanding a changed/deleted/inaccessible reference returns `unavailable` and a change notice. Public regression: old implementation returned a new body under the old handle; fixed implementation returns no body.
2. Raw UTF-8 splitting could exceed the final 8 KiB JSON budget for quotes/backslashes. Splitting now counts JSON-escaped bytes, with bounded business title/status envelopes. Public regression: a valid escaped-text page was 9,280 bytes; every resulting page now stays <=8,192 bytes and remains expandable.

Summary: Standards 1 optional finding, worst P3; Spec 2 initial findings, worst P2, both fixed and verified through public boundary tests. No known unresolved Spec finding; independent post-fix confirmation remains part of final integrated review.

## Verification

- API TypeScript no-emit: passed.
- Company public HTTP/Runtime boundary: 11 tests passed.
- Existing Pi Runtime public behavior: 15 tests passed.
- Combined focused run: 26/26 passed (`/tmp/memory03-review-fixes.log`).
- `git diff --check`: passed.
- No live World instance or provider was used. Real-instance authorization, coverage and latest response shape remain unverified.
