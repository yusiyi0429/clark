# Codex／Claude Code 接入天枢执行事项 · 方案（已确认，工单 05 之后实施）

日期：2026-09-27。
- 依据：[codex-integration-survey.md](codex-integration-survey.md)，本机 Codex CLI 0.156.1 实测加官方文档。
- 前提：工单 05 的执行事项模型，见 [design-05.md](design-05.md)。

## 要解决的事

员工平时在 Codex 或 Claude Code 里推进项目，推进到哪一步，要能同步进自己天枢账号里对应的执行事项。这样本人、拍板人和 CEO 在天枢里都看得到进展，不用另外手写。

## 结论：做「个人 MCP 端点」，不做自动猜测

- **同一个端点两边通用**：天枢 API 新开一个按人鉴权的 MCP 端点 `/mcp/me`，用 streamable HTTP。
  - Codex 用 `codex mcp add tianshu --url https://<天枢>/mcp/me --bearer-token-env-var TIANSHU_TOKEN`。
  - Claude Code 用 `claude mcp add --transport http tianshu https://<天枢>/mcp/me --header "Authorization: Bearer …"`。
  - 一个端点两边都能接，所以「只做 Codex」和「顺带支持 Claude Code」工作量一样。
- **写进展靠显式调用**：由员工说一句，或由代理在收尾时主动调用 `append_progress` 写进展。
  - 不靠 Codex 的「一轮结束」钩子自动上报：一轮结束不等于做完了，自动报容易把普通对话记成进展。
  - 钩子（Codex 的 `Stop`、`notify`）留作第二期可选的「收尾提醒」。
- **身份用个人令牌**：在天枢「个人菜单 → 连接 Codex」里生成，只显示一次，可以命名、设到期、随时撤销。
  - 库里只存散列，令牌格式 `tsm_<id>_<随机>`。
  - 和现有的公司记忆服务令牌完全分开，个人令牌不能读公司记忆。
- **权限每次重查**：工具每次调用都按当前数据库重新检查，只能动本人推进的事项；协作者只能追加进展。
  - 不能靠「模型刚才在列表里看到过」就放行。

## 第一期范围（建议）

**工具**
- `list_my_items`：本人推进的执行事项，默认只列未完成的。每条带所属个人任务、第几步、起止和状态。
- `get_item`：一件事项的详情，加最近的进展记录。
- `append_progress`：追加一条进展。
  - 输入：`{itemId, text, links?, clientEventId?}`。
  - `text` 写做了什么、证据、下一步或阻塞。
  - `links` 放 PR、提交等链接。
  - 同一个 `clientEventId` 重复提交只记一次。
- `update_status`：改成未启动、进行中或完成，要带 version；不能改成退回。

**进展记录**
- 新表 `task_progress`：谁、什么时候、来源（`web | codex | claude | github`）、正文、链接。
- 在执行事项详情里按时间列出，来源用小标注明。
- 天枢网页里自己手写的进展也记进这张表。

**连接页**
- 个人菜单里加「连接 Codex」：生成令牌，并给出两条可以直接复制的命令（Codex 和 Claude Code）。
- 已有令牌列出名称、创建、到期、最后使用时间，可以撤销。

**安全**
- 令牌和写工具分别限流；正文限长。
- 审计记录令牌 id、人、工具、事项、结果，不记令牌本身。
- 撤销后下一次请求立即拒绝。

## 第二期（按需要再定）

- 从 Codex 里拆步骤、新建执行事项（`create_item`，只能建给自己）。
- 收尾提醒：用 Codex 的 `Stop` 钩子提示「要不要把这轮进展记进天枢」，由人确认后再写。
- GitHub webhook：PR 或提交信息里带执行事项短编号时，把 PR、提交作为「代码证据」追加到进展里。只追加证据，不自动标完成。
- OAuth 登录，免手动令牌。Codex 和 Claude Code 都支持 MCP OAuth，但服务端要实现完整的授权流程。
- Codex 云端：它在云端容器里运行，要单独确认网络能不能到达天枢、令牌怎么传进去。

## 已定（用户 2026-09-27 选定）

- 第一期按上面的范围做：个人令牌、4 个工具、进展记录、连接页，不做自动钩子。工单 05 验收提交后接着做。
- 连接页同时给 Codex 和 Claude Code 的命令和说明。
- 进展记录谁能看：推进人、协作者、事项所属战场的拍板人、CEO。独立事项没有所属战场，只有成员和 CEO 能看。
