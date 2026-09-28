/** 「连接我的 Agent」：给非技术同事的一份说明文件，发给自己的 Codex 或 Claude Code，由它照着完成设置。 */

export type AgentClient = "codex" | "claude";

export const clientName = (client: AgentClient) => client === "codex" ? "Codex" : "Claude Code";

export const SYNC_INSTRUCTION = "用天枢 MCP 同步我本周的工作进展：先调用 tianshu 的 list_my_items（status=all）看我负责的执行事项；我已知的协作事项用 get_item 核对。再根据我这周实际做过的事（当前目录的提交、文档，以及我们的对话），为每件有进展的事项调用一次 append_progress，写清做了什么、证据链接和下一步；我推进的事项状态有变化时用 update_status 更新。没有进展的事项不要写，不要编造。最后列出你写了哪几条。";

const TOOLS = "mcp__tianshu__list_my_items,mcp__tianshu__get_item,mcp__tianshu__append_progress,mcp__tianshu__update_status";

/** 手动运行或放进定时任务的同步命令。 */
export const syncCommand = (client: AgentClient) => client === "codex"
  ? `codex exec "${SYNC_INSTRUCTION}"`
  : `claude -p "${SYNC_INSTRUCTION}" --allowedTools "${TOOLS}"`;

/** 手动设置用的命令；Claude Code 用 user 作用域，换项目目录也能用。 */
export function connectCommands(client: AgentClient, endpoint: string, token: string) {
  return client === "codex" ? [
    { label: "Windows PowerShell：存令牌", value: `[Environment]::SetEnvironmentVariable("TIANSHU_TOKEN", "${token}", "User")` },
    { label: "macOS / Linux：存令牌（追加到 ~/.zshrc 或 ~/.bashrc）", value: `export TIANSHU_TOKEN=${token}` },
    { label: "添加天枢", value: `codex mcp add tianshu --url ${endpoint} --bearer-token-env-var TIANSHU_TOKEN` },
  ] : [
    { label: "添加天枢", value: `claude mcp add --transport http --scope user tianshu ${endpoint} --header "Authorization: Bearer ${token}"` },
  ];
}

export const GUIDE_FILE_NAME = "天枢连接说明.md";

export function connectionGuide({ client, endpoint, token, expires }: { client: AgentClient; endpoint: string; token: string; expires: string }): string {
  const name = clientName(client);
  const steps = client === "codex" ? [
    "1. 把令牌存成用户级环境变量 `TIANSHU_TOKEN`，按用户的系统选一条：",
    `   - Windows（PowerShell）：\`[Environment]::SetEnvironmentVariable("TIANSHU_TOKEN", "${token}", "User")\``,
    `   - macOS / Linux：把 \`export TIANSHU_TOKEN=${token}\` 追加到 \`~/.zshrc\`（或 \`~/.bashrc\`）`,
    `2. 运行：\`codex mcp add tianshu --url ${endpoint} --bearer-token-env-var TIANSHU_TOKEN\``,
    "3. 请用户完全退出并重新打开 Codex，让环境变量生效。",
  ] : [
    `1. 运行：\`claude mcp add --transport http --scope user tianshu ${endpoint} --header "Authorization: Bearer ${token}"\``,
    "   `--scope user` 让用户的所有项目都能用，不只是当前目录。",
    "2. 请用户重新打开 Claude Code。",
  ];
  return [
    `# 把 ${name} 连到天枢`,
    "",
    "这份文件由天枢生成。拿到它的 Agent：请按下面的步骤帮用户完成连接，每做完一步告诉用户结果；需要用户自己操作的地方（比如重新打开），停下来说清楚。",
    "",
    "> 文件里有用户的个人令牌，等同于用户的身份，只能读写用户自己的执行事项。只在下面的设置里使用它：不要写进任何项目文件，不要提交到 git，不要贴到别处。设置完成后提醒用户删掉这个文件。",
    "",
    "## 连接信息",
    "",
    "- 服务名：`tianshu`",
    `- 地址：\`${endpoint}\``,
    `- 令牌：\`${token}\``,
    `- 有效期：${expires}`,
    "",
    "## 第一步：添加天枢",
    "",
    ...steps,
    "",
    "## 第二步：确认连上了",
    "",
    "重新打开后，调用 `tianshu` 的 `list_my_items`，把用户正在推进的执行事项列给用户看，能列出来就算连好了。失败时把报错原文告诉用户；常见原因是令牌已撤销或过期、还没重新打开、地址打不开。",
    "",
    "## 以后怎么用",
    "",
    "- 推进天枢里的执行事项时：开始前用 `list_my_items` 找到对应事项；收尾时用 `append_progress` 写一条进展（做了什么、证据链接、下一步或阻塞）；做完用 `update_status` 标完成。只写真实做过的事。",
    `- 用户说「同步本周进展」时，照这段做：${SYNC_INSTRUCTION}`,
    "- 可以问用户要不要把上面两条写进常用项目的 AGENTS.md 或 CLAUDE.md（不要写令牌）。",
    "",
    "## 可选：每周自动同步",
    "",
    "如果用户希望每周五 18:00 自动同步，帮用户在系统里建一个每周定时任务（Windows 用任务计划程序 schtasks，macOS / Linux 用 crontab），工作目录设成用户最常用的项目目录，运行：",
    "",
    "```",
    syncCommand(client),
    "```",
    "",
    "建好后把任务名和下次运行时间告诉用户。",
    "",
    "## 最后",
    "",
    "提醒用户删掉这个文件。令牌丢了或不用了，可以在天枢的「账号菜单 → 连接我的 Agent」里撤销再生成。",
    "",
  ].join("\n");
}
