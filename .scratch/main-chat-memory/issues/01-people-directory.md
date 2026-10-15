# 01 — 解耦人员目录，保持登录与授权行为

Type: implementation
Status: resolved

**What to build:** 身份与权限不再依赖公司认知存储；公司记忆替换过程中，现有成员仍能以相同身份登录、读取本人对象、连接已有个人 MCP。

**Blocked by:** None — can start immediately.

这是 to-tickets 允许的宽重构例外：先 expand 新人员目录接口、迁移身份调用方，旧认知接口暂保留；删除旧形式在 06 contract，不能在本票同时停用旧企业知识。

- [ ] 通过现有登录、会话和本人数据接口验证 personId、角色及可见范围不变。
- [ ] 保持其他 MCP、群组、批注和 M2 的既有行为。
- [ ] 目录缺失仍如实失败，不用 World 业务负责人推导登录权限。

**TDD seams:** 登录/session HTTP 接口、本人对象 HTTP 接口；必要的目录模块公开接口。只验证行为，不通过私有函数或数据库侧查询替代断言。

## Execution

Each ticket uses one implement subagent in an isolated worktree; red/green evidence and Standards/Spec review evidence must be recorded before resolution. User-approved public seams and fixed point are in ticket-breakdown.md.

## Implementation evidence

- Expanded `PeopleDirectory` and independent validated people-seed loader; identity/session, personal MCP and identity projections consume the directory. Legacy CompanyMemory keeps its compatible people method until ticket 06 and cognition tools remain available.
- TDD public directory seam: `node apps/api/node_modules/vitest/vitest.mjs run test/peopleDirectory.test.ts --root apps/api` RED (module not present), then GREEN (1 passed). Checks stable member identity/roles/name search and defensive copies so callers cannot grant roles by mutating results.
- API typecheck: `node node_modules/typescript/bin/tsc -p apps/api/tsconfig.json --noEmit` passed.
- Existing HTTP regression seams: auth 7, member home 8, personal MCP OAuth 9 passed in focused run; legacy company memory tests initially exposed changed missing-seed error wording, fixed to preserve the established error.
- Offline pnpm install unavailable due missing mirrored package metadata; copied existing dependency structure and invoked local Node tools directly (pnpm wrapper attempted an unsolicited install). No dependencies changed.


## Standards review

Parallel reviewer: no documented-standard violations. One nonblocking Mysterious Name finding (identity-only helpers still named their directory parameter companyMemory); fixed positional helper parameters. Existing named compatibility options remain until ticket 06 to avoid breaking unrelated callers.

## Spec review

Parallel reviewer: one partial migration finding (legacy-conversation ownership and recording service construction still consumed cognition repository); fixed their directory injection, including server bootstrap. No scope creep or incorrect behavior found.

Final checks: 38 unique focused tests passed (directory 1, auth 7, member home 8, personal MCP OAuth 9, legacy company memory 9, conversation owner 4); API typecheck passed. Missing/invalid/duplicate directory seed fails honestly and legacy cognition MCP remains active. Diff whitespace check passed. No new configuration/dependency or unnecessary abstraction introduced; narrow directory seam and legacy compatibility export are needed for ticket 06 cutover.
