# Ticket 15 · 确定性 CI 门槛与付费上线验收门槛

本文件固定两类门槛：常规 CI 只跑确定性检查；真实 Provider、模型与备份恢复属于 staging gate（Ticket 16），
必须有成本上限且失败不自动重试。

## 1. 确定性 CI（`.github/workflows/ci.yml`）

| 门槛 | 命令 | 确定性来源 |
|---|---|---|
| 契约/领域/API/Pi-MCP/Web 测试 | `pnpm test` | 一次性测试 PostgreSQL（`TEST_PG_URL`）+ stub Provider（`provider.invalid`） |
| 类型检查 | `pnpm typecheck` | 无外部依赖 |
| 生产构建 | `pnpm build` | 无外部依赖 |
| OpenAPI 生成客户端无漂移 | `pnpm --filter @warmap/web gen:client && git diff --exit-code -- apps/web/src/lib/api` | 仓库内快照 |

CI 不包含：真实模型、真实 Web Search/公众号、LangSmith 发送、备份与恢复。

## 2. 付费/staging 上线验收（Ticket 16，带成本上限）

| 验收 | 次数上限 | 成本上限 | 失败处理 |
|---|---|---|---|
| 真实 Web Search 一次查询 + Pi 自主 Tool loop | 3 次 query | 按 provider 当期单价 ×3，超过即中止 | 记录失败，不自动重试 |
| 真实公众号账号拉取 | 1 个账号 1 轮 | 按 provider 配额，不额外重试 | 保留未配置/失败如实状态 |
| light / heavy / compaction 模型各一次 | 每个槽位 1 次 | 单次 ≤ 32k tokens；整轮验收费用 ≤ 约定预算（建议 $3 / ¥20），超出中止 | 不自动换档、不自动重跑 |
| Pi compaction/recovery | 1 次 | 含在上述模型预算内 | 显式重试才发生 |
| 合法 Transcript 导入 + Outcome 抽取 | 1 份 | 含在 heavy 预算内 | 保留 Transcript，显式重试 |
| 加密备份 + 真实恢复 | 每日 1 次 dump；上线前 1 次 restore | 存储 ≤ 现库大小 ×1.1；异机保留 ≥7 天 | restore 失败阻止 cutover |
| LangSmith 观测 | 跟随上述 run | 无额外调用成本（可选，未配置 no-op） | 只写 warning，不阻断 |

成本上限是中止条件，不是目标用量；任何自动重试、批量回放或压力测试都需要额外授权。
