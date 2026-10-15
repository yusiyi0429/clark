# 03 — 主私聊按需读取 World 公司事实与 Company

Type: implementation
Status: ready-for-agent

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
