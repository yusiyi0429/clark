# 发布方来源：容量修复与三链路接入证据

日期：2026-09-18。方案 A（用户选定）。

## 1. 容量边界

| 项 | 值 |
| --- | --- |
| 单家上限 | 3 条 |
| 全局硬上限 | 20 条 |
| assess 批大小 | 5（`ASSESS_BATCH_SIZE`） |
| 理论上限 | 4 个 assess 批 |

超限时截断并写 warning；每个 assess 批启动前检查 `abort.signal.aborted`，timeout 后不再排队新批。

## 2. 真实扫描（staging）

配置：`site-web-all.enabled=false`、`outlet-global-finance.enabled=true`，含 `bbc`、`bloomberg`、`reuters`、`ft`、`cnbc`、`economist`（排除 WSJ）。

### 2.1 修复前（20 条/家）

- 单批 171.6 秒仍被 180 秒 timeout 截断，报 `Candidate agent did not call submit_candidate`。
- 根因：模型在无关键条目上悬停，未提交空候选。
- 输入体积仅 4.2 KB，与上下文大小无关。

### 2.2 修复后

第一次尝试（仅加 `abort` 检查 + 硬上限）：

- 只启动 1 个批，171 秒仍被截断。

第二次（补充提示词：无合格候选也必须 `submit_candidate({"candidates":[]})`）：

```json
{"trigger":"manual","status":"completed","companyDay":"2026-09-18","createdSignals":0,"warnings":[]}
```

- assess 批：4 个，全部 `succeeded`，耗时 22.6s / 10.9s / 8.6s / 83.9s。
- 整次 scan：135 秒（180 秒预算内）。
- `last_run.warnings` 为空。
- `createdSignals: 0`：CompanyMemory 对比后判定当前 20 条财经消息与公司战略无关，属预期筛选结果，不是失败。

### 2.3 恢复 48h 窗口后的真实端到端

`lookback_hours` 由 168 改回 48（`version` → 6），`site-web-all.enabled` 保持 `false`。

```json
{"trigger":"manual","status":"completed","companyDay":"2026-09-18","createdSignals":1,"warnings":[]}
```

- assess 批：4 个全部 `succeeded`（14.0s / 9.2s / 33.3s / 12.1s）。
- Signal：`source_type=outlet`、`outletName=CNBC`、标题 `A Chinese AI company just connected its model to Wall Street's leading data providers`。
- 自动升级 Issue `d3a00ec3-1bab-4339-b50b-3f086e0eb16b`（`signals.promoted_issue_id` 已写）。
- 预研 `issue-research` run `acd74afd-03bd-46d3-b06f-f1a376d66534`，31 秒后 `research.status=ready`，4 个选项。
- 预研 `sources` 引用了 feed 返回的真实 CNBC URL：`https://www.cnbc.com/2026/09/17/china-moonshot-kimi-financial-services.html`。

即：发布方 feed → outlet Signal → 自动 Issue → 预研 ready 整条链路已由真实数据走通（包括之前缺失的落库验证）。

## 3. 数据库约束缺口（已修）

`signals.source_type` 的 CHECK 只允许 `('web','wechat-account')`，outlet Signal 无法落库。

- 新增 `apps/api/migrations/013_signal_outlet_source.sql` 放开 `outlet`。
- staging 已应用（`schema_migrations` 最新为 `013_signal_outlet_source.sql`）。
- 回归：`radar.test.ts` 新增「发布方 feed 条目按 `source_type=outlet` 落库且不回落全网检索」，断言 `source_type='outlet'` 且 `webCalls=0`。

## 4. 预研接入

`apps/api/src/researchAgent.ts`：

- 无参数只读工具 `read_outlet_feed`，仅当 Radar 配置存在启用发布方时暴露。
- 与 Radar 共用同一 `RadarOutletAdapter`；`outletIds` 由配置解析，不由模型指定。
- `outletSources.ts` 新增 `resolveConfiguredOutletIds`：拒绝未启用与不存在的 outletId。

回归 `apps/api/test/researchAgent.test.ts`：启用时工具进白名单并读取到 `lookbackHours=48`；未启用时工具不暴露且 adapter 零调用。

## 5. 全局对话接入

`apps/api/src/piConversationRuntime.ts`：

- 同一无参数 `read_outlet_feed`，每轮最多读一次；失败不消耗额度。
- System prompt 明确：问及配置媒体时必须先用该工具，不得用 `web_search` 的 `site:` 冒充发布方来源。

### 5.1 首次真实对话暴露的问题

模型猜 `outletIds: ["financial-times"]` 被拒，且失败调用占用了唯一额度，最终没有任何来源。

修复：去掉 `outletIds` 参数，工具始终返回全部当前启用媒体（模型猜不出内部 id，猜错即报错会白烧额度）。

### 5.2 修复后真实对话

提问：彭博、金融时报、路透最近是否报道美债或能源价格。

- 工具调用：1 次 `read_outlet_feed`（started + completed）。
- 回答按发布方分列实际读到的条目，并给出 FT 真实 URL；对不合目标的条目明确说明「未出现聚焦美债或能源价格的条目」。
- 未虚构来源，未使用 `site:` 冒充。

## 6. 检查结果

| 检查 | 结果 |
| --- | --- |
| `@warmap/contracts` test | 28/28 |
| `@warmap/api` test | 251/251（20 文件） |
| `@warmap/web` typecheck + test | 通过，13/13 |
| `@warmap/api` typecheck | 通过 |
| `git diff --check` | 无空白错误 |

## 7. 来源 URL 只允许 http(s)（方案 1）

背景：`ResearchDocSource.url` 与 `ResearchDocEvidence.sourceUrl` 原来接受任意字符串，模型在真实预研里自编了 `file:///repo/apps/api/CompanyMemory.md` 与 `urn:issue:...`。该行为在 2026-09-16 更早的 run 里已存在，Web 会把它渲染成链接，既虚构证据又暴露内部路径。

改动：

- `packages/contracts/src/issues.ts`：新增 `ResearchSourceUrl = Type.String({ pattern: "^https?://\\S+$" })`，同时用于 `sources[].url` 与 `evidence.sourceUrl`。两处是同一个漏洞，只堵一处会留下同样的假来源。
- `apps/api/src/researchAgent.ts`：提示词明确内部材料改写 `sourceTitle` 并省略 `sourceUrl`，没有外部链接时写进 `unknowns`。
- `apps/web/src/cards/IssueCard.tsx`：旧数据可能已带 `file://`，非 http(s) 时渲染纯文本而不是链接。

旧数据不被破坏：`research.doc` 只在 `research.ts` 校验新提交的候选，投影路径不做 schema 校验。

### 7.1 真实回归

对同一 Issue 触发显式重跑（`issue.retry_research`，version → 4），预研 `ready`。

```json
sources: [{"url": "https://www.cnbc.com/2026/09/17/china-moonshot-kimi-financial-services.html", "title": "CNBC：..."}]
```

- `$.**.sourceUrl` 提取结果全部为 `https://www.cnbc.com/...`，无 `file://`、无 `urn:`。
- 模型主动在 `unknowns` 里写明：「CompanyMemory 片段没有可核验的外部链接，因此未列入外部证据」。

即约束不仅挡住了假来源，还把“缺链接”这件事变成 CEO 可见的限制，而不是静默丢弃。

### 7.2 检查

- `@warmap/contracts` test 28/28（新增 2 条 URL 约束用例）。
- `@warmap/api` test 251/251；`@warmap/web` test 13/13 + typecheck 通过。

## 8. 仍未完成 / 限制

- 48h 窗口下只有 1 条入选 Signal（CNBC）。窗口内条目仍以与公司战略无关为主，命中率取决于 feed 内容，不是故障。
- 预研 `sources` / `evidence.sourceUrl` 曾出现模型自编的非 http 来源 URL，已按方案 1 修复，见第 7 节。
- Reuters 只有标题，红色紧迫度所需的日期引文通常无法满足。
- WSJ 已停止更新（内容停在 2025-01-27），目录保留、运行配置排除。
- 公众号真实文章仍受 `ret=200013 err_msg=freq control` 阻塞（已风险豁免）。
