# clark-memory-adapter 实际验证台账（2026-08-31）

## 验证边界

- adapter 与 clark 均以真实进程启动，只用进程环境切换 `TKOS_GRAPHKNOWLEDGE_BASE_URL`，未修改 clark 代码或配置文件。
- 数据库使用 workspsce PostgreSQL。隔离链路使用随机 `adapter-test-*` scope，结束后残留为 0；current graph 成功链只读 `local/local-org`，未写 public 数据。
- embedding 调用真实 Ark `/embeddings/multimodal`，返回 2048 维；不是 mock。
- clark check API 通过临时进程内 access password/secret 正常登录取得 cookie，未绕过 `src/proxy.ts`。

## 真实链路结果

1. 随机隔离 scope：真实 uvicorn + PG + HTTP 跑通 `/healthz`、P0、P1 latest、P2 chain、P3；P3 完成真实 embedding 后精确返回 `no_current_context_graph_generation`；finally 后 users/chains 均为 0。
2. current graph：`local/local-org` 的 current generation 上，P3 返回 5 个真实 `CG-{UUID}` seed，`type/score` 完整，来源解析 fail-closed 检查通过；`budget=1200` 时 text 精确不超过 1200，并报告 `narrative_truncated_to_budget`。
3. clark 四层 check：网络、P0、锚点正常分支、P3 全部 `ok=true`。方案 1 的 `CG-*` 不匹配 clark autopick 的 `ISS-/CARD-` 前缀，因此锚点层明确记录 `AnchorNotFound（正常分支：转纯外部）`；P3 仍返回真实 CG seeds。

## 10 条真实 issue 基线

来源为 clark `src/lib/data/seed-cases.ts` 的前 10 条不同 issue title。每条均调用 clark 自己的 `/api/graphknowledge/check`，每次实际经过 adapter P0 与两次 P3。

| # | 真实 issue | check | 锚点 | P3 | top type | text / warning |
|---|---|---|---|---|---|---|
| 1 | 首批客户按行业挑，还是按「一号位是否真正牵引」挑？ | ok | AnchorNotFound | 3 CG seeds | OperatingPrinciple | 1200 / truncated |
| 2 | 对外还没有正式名字，材料却已经在同时用两个说法 —— 现在定还是继续拖？ | ok | AnchorNotFound | 3 CG seeds | OperatingPrinciple | 1200 / truncated |
| 3 | 会后沉淀的判断建立在一份自己都对不上号的转写上，还能不能当依据用？ | ok | AnchorNotFound | 3 CG seeds | OperatingPrinciple | 1200 / truncated |
| 4 | 迁址方向定了、地点成本时间负责人一样没定，这件事此刻归谁？ | ok | AnchorNotFound | 3 CG seeds | OperatingPrinciple | 1200 / truncated |
| 5 | 研发环境与模型资源保障，本月要保障到什么程度 | ok | AnchorNotFound | 3 CG seeds | Outcome | 1200 / truncated |
| 6 | 灯塔首版的「小而完整」，完整到哪一层为止、拿什么验收？ | ok | AnchorNotFound | 3 CG seeds | OperatingPrinciple | 1200 / truncated |
| 7 | 三页纸的材料改稿，能不能自己把一个客户带到下一步？ | ok | AnchorNotFound | 3 CG seeds | OperatingPrinciple | 1200 / truncated |
| 8 | 会前预审拿了约 70 分，下一版要补的是系统性还是理解力？ | ok | AnchorNotFound | 3 CG seeds | OperatingPrinciple | 1200 / truncated |
| 9 | 验证看板要记哪几样，才能证明组织运行真的变了而不只是有人在用？ | ok | AnchorNotFound | 3 CG seeds | OperatingPrinciple | 1200 / truncated |
| 10 | TokenOps 扩张到什么条件为止、占多少资源、和主线撞车时怎么让位？ | ok | AnchorNotFound | 3 CG seeds | Organization | 1200 / truncated |

汇总：10/10 HTTP 200 且 check `ok=true`；10/10 为预期 AnchorNotFound；10/10 返回 3 个 CG seeds；top type 为 OperatingPrinciple 8、Outcome 1、Organization 1。

## 未完成与 GO/NO-GO

- 本机 clark 没有旧 TKOS GraphKnowledge base URL，因此未执行旧后端与 adapter 的双边 renderedMarkdown/memberIds diff；不得把本台账描述成双后端对照。
- 方案 1 明确不提供 `CG-*` 的 P1/P2 解引用，也不会让 clark autopick 生成 ISS/CARD 锚点。因此自动 S01/S02/S03 命中装配未发生；当前只验证了其正常 external-only 分支与独立 P3。
- P0 仍只有 confirmed WM 判断与 viewer；CompanyVision/Outcome 静态段未接。
- `ADAPTER_AUTH` 未执行服务端 Basic Auth；本期只能监听 loopback。

据此：**adapter 的 P0/P1/P2/P3 读接口与 clark P0/P3 灰度链路 GO；把它描述为“完整替代旧后端的自动锚点/整条配方行为”则 NO-GO。**
