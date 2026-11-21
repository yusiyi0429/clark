# 岗位进会话、评审会：实测（11/06）

## 假网关看请求（不调真模型；脚本同目录 `G_fake-gateway.mjs`）

| 试什么 | 参数 | 看到的 |
|-|-|-|
| 岗位进系统提示词 | `--append-system-prompt-file role.md`（内容带标记 ROLE_DUTIES_MARKER） | 第一次请求的 system 里有标记 |
| 挑刺子 agent | `--agents agents.json`（`critic-1`、`critic-2`，描述带标记） | Agent 工具描述里列出 critic-1、critic-2 和描述；子 agent 的 prompt 不在主会话请求里（对） |
| 飞书技能插件 | `--plugin-dir`，`skills/lark-doc` 是复制的目录 | 技能列表里出现 `tianshu-feishu:lark-doc` |
| 同上，目录链接 | `skills/lark-doc` 是指向 `~/.claude/skills/lark-doc` 的 junction | 同样出现（`~/.claude/skills/lark-doc` 本身又链到 `~/.agents/skills`） |
| 本人全局规则 | 带 `claudeMdExcludes` | 没有 `~/.claude/rules` 的内容 |
| Claude Code 怎么连 HTTP MCP | 记录型 MCP 服务 | 依次：POST `server-discover-probe`、POST initialize、POST notifications/initialized、GET（取流）、POST tools/list；不带 Origin |

## 真跑（订阅 haiku；脚本同目录 `J_review-e2e.mjs`，结果 `J_评审会真跑结果.json`）

本机程序（源码）开一个专题：岗位「调研员」（做法：提纲最多 3 条、正文 150 字内），挑刺岗位「反方」「读者视角」（各只说一条），versionBase 0。

1. 第一次跑：提纲写好了，但 `save_version` 用不了——本会话 MCP 第一次连接在本机程序登记会话之前，401，转 OAuth 又 403。修了（启动途中也认密钥），假 `claude` 加了「握手前连一次 MCP」的测试。
2. 第二次跑（44 秒，$0.0096）：
   - 第 1 版 outline「周报改双周报提纲」：3 条；
   - 第 2 版 draft「周报改双周报正文」；
   - 评审会：同时派出 critic-1（反方）、critic-2（读者视角），两次调用都在任何一个返回之前（并行）；
   - 第 3 版 review「第2版评审会分歧和建议」：一致意见、分歧点和各方理由、建议怎么改，正文没改。
