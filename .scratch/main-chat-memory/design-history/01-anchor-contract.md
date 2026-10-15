# 01 · Anchor 契约与页面同源投影

Type: implementation
Status: ready-for-agent
Blocked by: —

## 工作

- 按 context-contract.md §3–6 定义 AnchorSelection TypeBox 输入、内部 AnchorView、TurnContext。生成 Web OpenAPI 类型。
- 将 routes/cards.ts 首页读取及成员首页相应读取提取为可复用的授权服务，页面和 Anchor 共用，不在聊天中复制 SQL 汇总。
- 明确 field allowlist：页面内容、草稿与历史的语义；不得把完整 Card.payload、actionId、storageKey 直接传模型。
- ConversationHost/useConversation 提交 focus；显式引用篮仍是 Reference。保留 scope、材料工具、SSE 和现有输入外观。
- 实现本轮只读 handle 映射及 read_anchor；目录默认 12 项，先过滤权限再计数，分页游标不能跨人跨 run 使用。

## 完成定义

- 同样的 viewer 与数据库状态得到相同的页面/Anchor 对象集合；成员看不到 CEO 内容，隐含数量也不泄露。
- “改这份草稿”与“当前公司事实”两种场景不混同，World 未配置也不阻止读本地页面。
- focus 过期 409，越权 404，前端保留输入；页面未显式选中时不从 Reference 推断 focus。
- read_anchor 复查授权及资源版本，旧 run 的 A1 无法复用。
- 相关 API/Web 测试、类型检查与生成客户端一致性通过。
