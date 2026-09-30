# 10 · 复盘与 LTO 审视 → 本体事件

Type: implementation
Status: ready-for-agent
Blocked by: 01（world 客户端）、02（Mission 外部引用）、personal-review/02（个人复盘 API）

用户 2026-09-30 决定：个人复盘、战场复盘、LTO 审视结果都要存进本体，作为公司记忆。world 0.2 没有对应对象，用外部事件记录；范围同工单 04，只限 E&O 域（委托只登记了 E&O）。

## 要做什么

沿用 04 会议事件的写法（`world_record_event`，prepare → commit，同步台账，失败按键重放，异步不阻塞天枢动作）。`category: "other"`，`declaration.human_acceptance.required = false`，`scene` = 第一个主体，`occurred_at` = 天枢里动作发生的时刻（+08:00）。

| 触发 | 主体 `subject_refs` | `content.text` | 幂等键 |
|-|-|-|-|
| 个人复盘 **提交**（`personal-review.submit`） | 本人被复盘月份、已链接（`mission:<编号>`）的 Mission；没有已链接的就用 E&O 单元（`capability:05` 查回）；本人不在人员映射（非 E&O）→ 不推 | 「<姓名> <月> 月个人复盘」+ 四部分正文 | `tianshu:personal-review:<id>` |
| 战场 / 能力域复盘项 **确认**（`monthly-review-item.confirm`） | 只推能力域 05（E&O）那一项，主体 E&O 单元；其余不推 | 「<单元> <月> 月复盘（CEO 已确认）」+ 四部分正文 | `tianshu:monthly-review-item:<id>` |
| LTO 审视 **决定**（`monthly-review.decide_ltco`） | E&O 单元 | 公司 LTO 与各战场 LTO 的决定（保持 / 修订前后原文）、窗口起止、CEO 决定时刻；另附已确认的公司复盘四部分 | `tianshu:lto-decision:<reviewId>` |

- `content.artifacts` 放天枢对应页面的完整链接（`PUBLIC_ORIGIN` + 页面路径）。
- 正文超过契约长度时截断并在末尾注明「全文见天枢」+ 链接，不拆条。
- 更正：个人复盘提交后不可改，无更正；复盘项确认后只读，无更正。

## 完成定义

- 桩 HTTP 测试（用 `examples-24e6202.md` §3、§4 的 `other` / `meeting` 事件请求／返回形状）：三种触发各一条；非 E&O 的人或单元不推；同键重放不重复；失败进台账并可重放。
- 真实写入由 Claude 在 world-02 重建、换好凭证后执行并核对（按主体查回事件）。
