# 03 — 主私聊按需读取 World 公司事实与 Company

Type: implementation
Status: claimed

**What to build:** 用户询问公司方向、责任或目标时，主 Agent 能查询 World 并消费可读 Company 片段；读取失败时如实说明，不拿本地旧目标或旧 Markdown 补事实。

**Blocked by:** 01（独立人员目录，避免公司事实查询与身份权限混在旧仓储里）。

- [ ] 从完整 World 响应到有界正文、Company 更新与主聊只读工具形成可验证链路。
- [ ] 不提供 World 写入工具；消除主聊中同用途的本地公司事实工具，页面信息由 Anchor 承担。
- [ ] 不发布部分失败的残缺投影，不跨访问范围消费 Company，不注入协议哈希或来源模板。
- [ ] World 未配置不阻止个人问题与已有页面讨论；明确区分没有对象和覆盖不足。

**TDD seams:** 主 Runtime 的公开 run/工具接口、Company 公开读写治理接口；HTTP transport 是外部桩边界，使用现有响应样例及人工指定预期。

**外部依赖:** 离线可交付与完整契约测试可以执行；真实实例读取授权、覆盖与最新响应形状尚未验证，不能报告生产联通已验收。

## Execution

Each ticket uses one implement subagent in an isolated worktree; red/green evidence and Standards/Spec review evidence must be recorded before resolution. User-approved public seams and fixed point are in ticket-breakdown.md.

## Implementation checkpoint

- Read-only World transport and deterministic Company governance: complete authorized list/detail read, bilingual keyword/Chinese-bigram retrieval, clean sections, deduplicated block/component prose, status/date retention, authorized relation titles, per-person explicit grants (default deny), dependency recheck and atomic generation publication.
- Main private runtime exposes `query_company`, `search_memory`, `read_reference`, direct stable directory lookup. Main scopes no longer instantiate CompanyMemory MCP or query local company-fact board tools. Company/tool handles are mapped to per-turn C1; Personal P1 mapping is prepared for Ticket04. Mission-card-specific editing tools remain.
- TDD red/green: full World fixture initially rejected because domain is absent in detail but present in list; validated list-scoped adapter now passes. Chinese query initially returned no entries; bigram ranking + bounded fallback passes. Runtime initially invoked local globalContext (test intentionally throws); main scopes now pass only World queries. Mid-read revocation initially returned `ready`; rechecking explicit grants before publication now returns `coverage_unavailable` with no content.
- HTTP external transport and public runtime test seam, no real provider or World credentials used. Tool response UTF-8 budget <=8 KiB verified with long Chinese text.
- Worktree install: offline install lacked cached metadata; normal independent workspace installation completed. `pnpm test -- file` selected more than requested and was interrupted; focused checks now invoke Vitest with explicit file path.
- Formal Standards/Spec review is pending root's concurrency slot grant. This checkpoint is not ticket resolution.
