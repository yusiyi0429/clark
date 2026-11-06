# 本机会话默认不带个人配置

2026-11-06 决定。适用于 `apps/local` 拉起的 Claude Code 会话（卡和调研专题）。

## 背景

本人全局配置（`~/.claude/settings.json`、个人 MCP、插件、hooks）会作用到每个 Claude Code 会话。11/05 实测时，本人配置里的 hooks（openviking 等）默认会跑，一次 `initialize` 就触发了 6 个 SessionStart 钩子。这会让每张卡的环境不一样、结果不可比，也可能把卡的内容带进个人的记忆服务。

## 决定

- 默认用 `--setting-sources project,local --strict-mcp-config`：只读项目自己的 `.claude/settings.json` 和本地设置，不读本人全局设置；MCP 只带本机程序给这个会话配的那份（`--mcp-config`）。
- 本机程序给每个会话配的 MCP：本会话 MCP（`tianshu-session`，HTTP，挂在本机程序自己的 `/internal/sessions/:id/mcp`）交产出物、交证据、交回，这几个工具用 `--allowedTools` 预先放行；关联了云端时再挂天枢 MCP（`tianshu`，经本机程序转发到 `/mcp/me`），联网搜索由它提供，只读的搜索工具预先放行，其余工具每次都要网页批准。
- 留一个开关：设置里的 `includePersonalConfigByDefault`，或开会话时的 `includePersonalConfig`。打开后不加上面两个参数，本人全局配置照常生效，本会话 MCP 照样带上。
- 每个会话都加 `skipWebFetchPreflight: true`（WebFetch 抓网页前不再连 api.anthropic.com 做域名检查，国内网络连不上会整个失败）；网关模型的会话另加 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`，默认不给自带的 WebSearch（`--disallowedTools WebSearch`），因为不支持服务端搜索的模型不报错还会编结果，实测能搜的模型在配置里打开 `webSearch`。
- 用本人默认的 Claude 配置目录（不设 `CLAUDE_CONFIG_DIR`），这样本人在终端里用 Claude Code 和本机程序共用一个登录，不用再登一次。
- 主目录这一层的记忆文件也排除（11/06 第二轮补）：工作目录在主目录下时，Claude Code 往上逐级找 `CLAUDE.md` 和 `.claude/rules/`，会把 `~/.claude/rules/*.md`、`~/.claude/CLAUDE.md` 当成「项目规则」读进来，`--setting-sources` 管不住，换 `CLAUDE_CONFIG_DIR` 也不行（假网关实测看到的上下文）。干净会话加 `--settings` 的 `claudeMdExcludes: ["<主目录>/.claude/**", "<主目录>/CLAUDE.md", "<主目录>/CLAUDE.local.md"]`，仓库自己的 CLAUDE.md 照常读；带个人配置时不加。允许的文件夹也不能是主目录或它的上级（ADR 0031）。

## 代价

- 本人在全局里配的好用的插件、MCP，默认在卡里用不上；要用就打开开关，或者写进项目的 `.claude/settings.json`。
- 项目级配置（仓库里的 `.claude/settings.json`、CLAUDE.md）照常生效，这是有意的：卡在哪个仓库干活，就守那个仓库的规矩。代价是 `-p` 模式没有「信任这个文件夹」的确认，项目里的 hooks 和放行规则不经网页就生效——所以允许的文件夹只应该是本人信得过的仓库。
