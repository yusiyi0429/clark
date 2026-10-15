# 06 — 停用旧 CompanyMemory MCP，保留共同调用方能力

Type: implementation
Status: ready-for-agent

**What to build:** 旧企业知识端点、专用配置和 Markdown 事实源退出；主聊、雷达、预审等已有调用方使用共同 Company 能力，身份与其他 MCP 保持可用。

**Blocked by:** 01、03（先有独立人员目录和可替代公司读取路径，再 contract）。

- [ ] 没有旧 CompanyMemory MCP 或旧 Markdown 的隐藏公司事实回退。
- [ ] 停用专用端点/Token/启动条件，其他 MCP 和既有服务仍可运行。
- [ ] 配置、健康状态、部署存储与领域文档一致，旧 ADR 明确被替代。
- [ ] 不扩展群消息、任务卡批注或 M2 功能。

**TDD seams:** 应用启动与 health HTTP、旧端点停用、现有雷达/预审公共运行入口、其他 MCP 现有接口。

## Execution

Each ticket uses one implement subagent in an isolated worktree; red/green evidence and Standards/Spec review evidence must be recorded before resolution. User-approved public seams and fixed point are in ticket-breakdown.md.

## Ticket 06 checkpoint evidence

- Fixed review base: `9e3d261` (Company03 green checkpoint).
- Red/green 1: public HTTP retirement test first failed (`406` versus expected `404`), then passed after endpoint/MCP implementation removal; health remains OK without World or the old Markdown seed, `/mcp/me` retains its authentication boundary.
- Red/green 2: shared research public runner first read Company with an unspecified service person (`reads=1` versus expected `0`); explicit-service-person guard then passed. Company still enforces the configured person's World domain grants.
- Focused checks: API typecheck three times; web typecheck; generated OpenAPI/client; 90 tests across 7 focused files passed, compatibility 31 tests across 6 focused files passed, research 4 tests passed (includes all-page prose consumption and metadata omission).
- Removed old loader, MCP server/client wrappers/tools, endpoint, token, seed startup dependency and obsolete tool contracts. Shared identity-only consumers depend on PeopleDirectory; cognition consumers use CompanyContext/CompanyReader directly. Main/server/preflight share one CompanyReader via buildApp injection.
- Deployment now mounts a private persistent memory volume; documentation and ADR-0027 replace ADR-0004/0013. Historical Markdown remains on disk but has no API reader.
- Scope: changes to existing mission-card/group dependencies are type/import/Company-read adaptations only, with compatibility tests. No M2 changes.
- Ablation: removed legacy repository rather than retaining a compatibility adapter; removed obsolete section/passage/sourceRef fields from new Company model inputs. The eager pagination collector was subsequently removed during review, as noted below.
- Limitations: no real World credentials or live model invocation; independent Standards/Spec review pending root slot grant. A mistakenly invoked broad Vitest command was interrupted and is not counted as a completed full-suite run.

### Bounded Company review fix

Both initial review axes identified eager all-page Company injection as a context-window regression. Replaced the eager drain with one bounded CompanyReader page and a direct read-only `query_company` tool for radar/preflight/research. Per-run `CP1` continuation maps keep query-bound World cursor metadata server-side. Other existing generators keep their prior bounded count and receive explicit partial coverage status. Public research tool-loop check went red when `query_company` was absent, then green for initial bounded input, on-demand continuation and no raw internal cursor/handle exposure. Affected focused run: 74 tests / 4 files passed. API typecheck passed.

The initial Spec report's cross-generation pagination concern is addressed in root integration by Company03's dependency/query/person-bound cursor; this ticket forwards the opaque cursor without reconstructing it and avoids stitching independent pages into an unqualified ready view.

### Memory trace regression fix

Standards recheck found the new structured `company.entries[].text` input bypassed the former `passages` key redaction. Following the approved context-contract memory-body policy, added a public redaction seam assertion (red before fix), then omitted Company/companyMemory payload bodies while retaining availability metadata. ADR-0008 now explicitly defers this narrow memory-body policy to ADR-0027 without altering other business tracing. Focused observability/research checks: 14 / 14 passed; API typecheck passed. Operational README now describes actual World/grants/system-person paths, private persistent memory volume and honest health semantics.
