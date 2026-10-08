# Mission draft CLI CI timeout

Status: verified

User approved setting only the existing Mission draft import CLI integration test to 30 seconds, then validating and pushing to feat/mvp-member-workspace. Main remains unchanged.

Original GitHub run: 36776041778, commit 2e6c77b. Web 781/781 and contracts 74/74 passed; API had one failure: test/missionDraftScript.test.ts exceeded Vitest's 5000ms default. This test performs fresh database migrations and four CLI startups. The previous local run passed at 10528.7ms with a command-line 30-second override. Rerunning locally with default settings reproduced failure.

Acceptance: targeted test passes using the repository configuration and no command-line timeout override; API typecheck passes; only its explicit timeout/comment change; remote full CI completes tests, typecheck, build and generated-client check.

Validation uses randomly named warmap_test databases on local PostgreSQL 55432. No production data, services or deployments are part of this task.

## Verification and follow-up

- d1c51e9: only the target test's timeout/comment changed. Targeted test passed without command-line timeout overrides at 10697.9ms; API typecheck passed.
- GitHub run 36859225478: contracts 74/74, Web 781/781 and API 875/875 passed (CLI case 5831ms); typecheck and production build passed. The last generated-client check found only an extra trailing newline in committed openapi.json.
- 2c64eca: regenerated OpenAPI and client with the repository emitter and pinned openapi-typescript 7.13.0. Parsed OpenAPI content and generated types are unchanged. Emitted bytes match and repeated regeneration gives a clean Git diff. Only openapi.json EOF formatting changed.
- Latest full CI run: 36861187153, commit 2c64eca3aabe302aa82b70c631deb69000534dd5. Completed successfully: contracts 74/74, Web 781/781, API 875/875 (CLI 8046ms), typecheck, production build and generated-client clean check all passed.
- Both fixes are committed and pushed; local tracked work is clean and latest branch has zero divergence from origin. Main remains at 9d1e546. Successful evidence: run-36861187153-all.log and https://github.com/TokenkingOS/Tianshu-MVP/actions/runs/36861187153.
