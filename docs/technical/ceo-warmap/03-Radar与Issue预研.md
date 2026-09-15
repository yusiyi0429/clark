# 03 Radar 与 Issue 预研

## 1. 职责

实现真实外部来源到 Signal、自动 Issue、ResearchDoc 和 CEO 直接决定的闭环。

不包含 Meeting、月度计划或多 Provider 平台。

## 2. RadarConfig

保存 timezone、anchors、sources、lastScheduledAt 和 lastRun。配置更新走 Card Action，GET 只读。

来源仅两类：

```text
site
wechat-account
```

公众号必须走真实账号渠道，不能用站点搜索冒充。

## 3. Scheduler

配置 `RADAR_DAILY_CRON` 和 `Asia/Shanghai`。

scheduled 流程：

1. 计算公司日期；
2. 获取 Radar advisory lock；
3. 锁 RadarConfig；
4. 当天已启动则退出；
5. 写 running 与日期；
6. 异步运行；
7. 写 lastRun。

manual 补扫共用同一 lock 和 pipeline，但不占 scheduled 日期。

## 4. Source Adapter

MVP 只有：

```text
WebSearchProvider.search
WechatAccountProvider.fetchLatest
```

Provider 由 `.env` 固定。统一输出 title、URL、publishedAt、excerpt、sourceRef。API 负责 URL canonicalization、时间窗和 fingerprint。

## 5. Radar Plan

输入 anchors 和启用 site sources，使用 LIGHT_MODEL 生成有限查询。公众号不经过查询规划。

输出只含 anchorId 和 query。代码限制数量、长度和合法 anchorId。

## 6. Radar Assess

内容按小批送入临时 Pi Session。Agent 输出摘要、影响、未知、维度分和可选 Issue 候选。

代码重新检查：

- 分值范围和最终聚合；
- CEO decision kind；
- 2–4 个去重选项；
- quote 连续存在 excerpt；
- source URL；
- location；
- red decisionBy/reason；
- Radar red 的 decisionByQuote 连续存在来源 excerpt，并能解析出时间窗口；
- promotion fingerprint。

promotion fingerprint 固定为 `SHA-256(v1 + decisionKind + normalizedDecisionQuestion + normalizedLocation)`。问题文本执行 Unicode NFKC、trim、合并空白和移除句末标点；多战场 ID 排序后进入 location。该规则只保证确定性，不承诺识别所有语义改写；真实重复率成为问题时再升级。

模型不能输出最终门槛结论。

## 7. 自动升级事务

门槛通过后单事务：

1. 插入 Signal；
2. 检查 promotion fingerprint；
3. 创建 pending Issue；
4. 写 Signal.promotedIssueId；
5. Issue.research.status=pending，并写 pendingSince；
6. 提交。

提交后立即可查询 Issue Card，再启动 pre-research。无需 CEO 点击“形成议题”。若进程在提交后、启动前崩溃，启动恢复把超过阈值的 pending research 标为 failed，错误码 `trigger_not_started`，等待 CEO 显式重试，不自动调用模型。

## 8. DRI Issue

服务 API 最低输入：externalId、submitterPersonId、title、whyNow、sourceRef、location。red 额外要求 decisionBy 和 reason。

CompanyMemory MCP 验证人员，TypeBox 验证结构，domain 验证 location。相同 externalId 同内容返回原对象，不同内容返回 409。

## 9. Issue 数据与状态

```text
origin: radar | dri
status: pending | decided | dismissed
research: pending | running | ready | failed
```

一个 Issue 一个主 location。多个战场归 company，并保存 relatedBattlefieldIds。

创建后立即投影；Research 未完成只显示真实状态，不显示占位判断。

## 10. PreResearch

输入 Issue、origin source、CompanyMemory passages 和 Web Search Tool。使用 HEAVY_MODEL 和严格 ResearchDoc candidate schema。

并发保护：

- `pending/failed/ready → running` 使用 version 条件；
- 同一 Issue 同时一个 run；
- 完成时确认 runId 仍是当前 run；
- 旧 run 不能覆盖新 run。

成功整份写 ResearchDoc；失败写 error。没有自动 retry 或自动升档。

## 11. 重新预研

仅 pending Issue 暴露。当前 runId 加入 previousRunIds，新 run 整份替换 doc；旧输出在 AgentRun 保留。Conversation 不能触发或局部合并。

## 12. CEO 决定

普通 decide 要求 research ready。CEO 可选择 option 后编辑最终 decisionText。

Research Override：research 未 ready 时使用单独 Action，Web 二次确认。Receipt 保存 researchStatusAtDecision 和 runId。

事务写 Receipt、Issue.decided、version。重复 Action 不生成第二 Receipt。

## 13. 移出议题

仅 pending 可执行。要求简短 reason，写 dismissedAt，保留 originRef 和 promotion fingerprint。dismissed 不再进入通知或首页待判断，但不物理删除。

## 14. Receipt 撤回

按 receiptId 撤回：标 revokedAt，按最新有效 Receipt 重算 Issue；没有有效 Receipt 回 pending。撤回不删除历史。

## 15. Card

- Radar overview：lastRun、未读、manual scan；
- Signal list/detail：来源、研判、read/save/dismiss；
- Issue detail：research 状态、doc、Receipt、decide/override/dismiss/retry；
- red notice：只投影 pending + red。

## 16. 失败

- 部分 Source 失败：保存有效结果与 warning；
- 全部 Source 失败：scan failed；
- assess 批失败：该批不保存候选；
- pre-research 失败：Issue 保持 pending + failed；
- API 重启：stale running 标 failed；超过阈值且从未启动的 pending 标 `trigger_not_started`；
- GET 不触发补偿。

## 17. 测试 seam

通过 API/Card 验证：

- scheduled/manual 防重；
- URL 和 promotion 去重；
- 选项、quote、location、red deadline quote 门槛；
- promotion fingerprint 的规范化与 dismissed 防重；
- pending trigger 丢失转 failed；
- 自动 Issue 原子性；
- 立即投影；
- Research ready/failed/retry；
- 旧 run 不覆盖；
- normal decide/override；
- dismissed 防重；
- Receipt 精确撤回；
- Signal 三个独立状态；
- GET 无副作用。

## 18. 完成条件

一条真实来源完成 Signal → 自动 Issue → ResearchDoc → CEO decide → Receipt；一个 dismissed Issue 不被再次升级；Radar 未配置公众号时如实显示未配置。
