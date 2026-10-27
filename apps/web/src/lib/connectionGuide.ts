/** 「连接到外部工具」：给非技术同事的一份说明文件，发给自己的 Codex、Claude Code 或其他 AI 工具，由它照着完成设置。 */

export type AgentClient = "codex" | "claude" | "other";
/** collector 是本机采集器的令牌：只出现在连接列表里，不走 MCP 连接说明。 */
export type TokenClient = AgentClient | "collector";

export const clientName = (client: TokenClient) => client === "codex" ? "Codex" : client === "claude" ? "Claude Code" : client === "collector" ? "本机采集器" : "AI 工具";

const syncInstruction = (span: "本周" | "今天") => `用天枢 MCP 同步我${span}的工作进展：先调用 tianshu 的 list_my_items（status=all）看我负责的执行事项；我已知的协作事项用 get_item 核对。再根据我${span === "本周" ? "这周" : "今天"}实际做过的事（当前目录及其下各仓库的提交、文档，以及我们的对话），为每件有进展的事项调用一次 append_progress，写清做了什么、证据链接和下一步；做出来的文档、设计稿、PR 这类有链接的东西，用 add_link 放进对应事项。实际推进了、但天枢里还没有对应事项的工作，够一件执行事项（Mission 卡上一个带 ◆ 关口的 Activity，一般 1–2 周）才用 create_item 建一条（必须挂到对应的 Mission，实在对不上就写清为什么，交给我处理）再写进展；过程步骤、修小问题、配置、一次会、一次问答、跑完一个子任务都只写进展，不新建。我推进的事项已经做完的，用 submit_for_acceptance 提交验收，对照完成标准逐条写明是否达到和依据，完成由我在天枢逐条确认。没有进展的事项不要写，不要编造。最后列出你写了哪几条、新建了哪几条。`;
export const SYNC_INSTRUCTION = syncInstruction("本周");
/** 每日补漏：会话里漏写的进展、漏建的事项，每天定时补一次。 */
export const DAILY_SYNC_INSTRUCTION = syncInstruction("今天");

const TOOLS = "mcp__tianshu__list_my_items,mcp__tianshu__create_item,mcp__tianshu__get_item,mcp__tianshu__append_progress,mcp__tianshu__add_link,mcp__tianshu__submit_for_acceptance";

/** 手动运行或放进定时任务的同步命令；其他工具没有统一的命令行，用各自的非交互模式。Codex 默认只在 git 仓库里运行，工作目录常是装着多个仓库的上级目录。 */
export const syncCommand = (client: "codex" | "claude", instruction = SYNC_INSTRUCTION) => client === "codex"
  ? `codex exec --skip-git-repo-check "${instruction}"`
  : `claude -p "${instruction}" --allowedTools "${TOOLS}"`;

/** Codex 的天枢配置：令牌直接写请求头（桌面 App、IDE 插件、命令行、定时任务读同一份，不依赖环境变量）；
 *  放行天枢工具，否则无人值守的 codex exec 会拒绝调用 MCP 工具（2026-09-30 实测）。 */
export const codexConfig = (endpoint: string, token: string) => [
  "[mcp_servers.tianshu]",
  `url = "${endpoint}"`,
  `http_headers = { Authorization = "Bearer ${token}" }`,
  'default_tools_approval_mode = "approve"',
].join("\n");

/** 手动设置用的命令；Claude Code 用 user 作用域，换项目目录也能用。 */
export function connectCommands(client: AgentClient, endpoint: string, token: string) {
  if (client === "other") return [
    { label: "服务名", value: "tianshu" },
    { label: "地址（远程 MCP，Streamable HTTP）", value: endpoint },
    { label: "请求头", value: `Authorization: Bearer ${token}` },
  ];
  return client === "codex" ? [
    { label: "追加到 ~/.codex/config.toml（Windows：%USERPROFILE%\\.codex\\config.toml）", value: codexConfig(endpoint, token) },
  ] : [
    { label: "添加天枢", value: `claude mcp add --transport http --scope user tianshu ${endpoint} --header "Authorization: Bearer ${token}"` },
  ];
}

export const GUIDE_FILE_NAME = "天枢连接说明.md";

/** OAuth 步骤可直接分享：没有令牌，登录与权限由本人在浏览器确认。
 *  天枢工具设为免确认：Agent 按 MCP 说明主动建事项、写进展，每次都弹窗问就谈不上自动。 */
export function oauthConnectionGuide(role: "ceo" | "member", client: AgentClient, endpoint: string): string {
  const setup = client === "codex" ? [
    `codex mcp add tianshu --url ${endpoint}`,
    "codex mcp login tianshu",
    '在 ~/.codex/config.toml 的 [mcp_servers.tianshu] 里加一行 default_tools_approval_mode = "approve"，天枢的工具不用每次确认。',
  ] : client === "claude" ? [
    `claude mcp add --transport http --scope user tianshu ${endpoint}`,
    "claude mcp login tianshu（旧版本可在 Claude Code 里输入 /mcp，选择天枢并登录）",
    '在 ~/.claude/settings.json 的 permissions.allow 里加 "mcp__tianshu"，天枢的工具不用每次确认。',
  ] : [`在工具的远程 MCP 设置里添加：${endpoint}，名称用 tianshu，然后选择登录或授权；把天枢的工具设为不用每次确认。`];
  return [
    "请帮我把 AI 工具连到天枢，使用浏览器授权：", ...setup,
    "已有同名配置时更新地址，移除旧的 Authorization 请求头，再登录；保留其他服务配置。",
    "请让我在浏览器里登录天枢并点“允许连接”，不要代替我确认授权。",
    `登录后按工具要求重新加载连接，用 ${role === "ceo" ? "list_pending" : "list_my_items"} 验证能读取。`,
    "这里只设置连接；每天定时补漏需要单独配置。",
  ].join("\n");
}

/** weeklySync：用户在生成前打开了「每周五自动同步」，设定时任务就是必做的一步。 */
export function connectionGuide({ role, client, endpoint, token, expires, weeklySync }: { role: "ceo" | "member"; client: AgentClient; endpoint: string; token: string; expires: string; weeklySync: boolean }): string {
  const name = clientName(client);
  const steps = client === "other" ? [
    "天枢是一个远程 MCP 服务（Streamable HTTP，Bearer 令牌）。请按你所在工具自己的方式添加它，名称用 `tianshu`：",
    `- 地址：\`${endpoint}\``,
    `- 请求头：\`Authorization: Bearer ${token}\``,
    "- 配置写在用户级（所有项目都能用），不要写进项目仓库里的配置文件。",
    "- 以你工具当前的官方文档为准。常见写法供参考：OpenCode 在 `opencode.json` 的 `mcp` 里加一项 `type: \"remote\"`、`url`、`headers`；Cursor 在 `~/.cursor/mcp.json` 的 `mcpServers` 里加 `url` 和 `headers`。",
    "- 添加后按工具要求重新加载或重启。",
  ] : client === "codex" ? [
    "1. 在用户的 Codex 配置文件末尾追加下面这段（macOS / Linux：`~/.codex/config.toml`；Windows：`%USERPROFILE%\\.codex\\config.toml`；没有就新建）。已有 `[mcp_servers.tianshu]` 时只替换这一段，不动其他内容：",
    "",
    "```toml",
    codexConfig(endpoint, token),
    "```",
    "",
    "   令牌直接写在请求头里，Codex 的桌面 App、IDE 插件、命令行和定时任务都读这一份，不需要环境变量；`default_tools_approval_mode = \"approve\"` 只对天枢生效，让定时同步无人值守时也能调用天枢的工具。",
    "   这个文件在工作目录之外，写入被沙箱挡住时，申请在沙箱外执行，让用户在批准弹窗里点允许；不要让用户自己去改文件。",
    "2. 请用户完全退出并重新打开 Codex（桌面 App 要从菜单里退出，不只是关窗口）。",
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
    role === "ceo"
      ? "> 文件里有用户的个人令牌，等同于用户的身份；本说明使用的 CEO 工具只读。只在下面的设置里使用它：不要写进任何项目文件，不要提交到 git，不要贴到别处。设置完成后提醒用户删掉这个文件。"
      : "> 文件里有用户的个人令牌，等同于用户的身份，只能读写用户自己的执行事项。只在下面的设置里使用它：不要写进任何项目文件，不要提交到 git，不要贴到别处。设置完成后提醒用户删掉这个文件。",
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
    role === "ceo"
      ? "重新打开后，调用 `tianshu` 的 `list_pending`，把待用户处理的事列给用户看，能列出来就算连好了。失败时把报错原文告诉用户；常见原因是令牌已撤销或过期、还没重新打开、地址打不开。"
      : "重新打开后，调用 `tianshu` 的 `list_my_items`，把用户正在推进的执行事项列给用户看，能列出来就算连好了。失败时把报错原文告诉用户；常见原因是令牌已撤销或过期、还没重新打开、地址打不开。",
    "",
    "## 以后怎么用",
    "",
    ...(role === "ceo" ? [
      "- 用户问「今天有什么要我拍板？」时，调用 `list_pending`，按紧急程度排好列给用户。",
      "- 用户问某个议题、某场会或某张任务卡「现在什么情况」时，先用 `list_pending` 找到它的 id，再调用 `get_issue`、`get_meeting` 或 `get_mission_card`。",
      "- 用户问「这周各战场进展怎样？」时，调用 `company_progress`；可以按周、战场或人筛选。",
      `- 这些工具只读。要拍板、签发、确认，把结果里的 \`href\` 拼成完整链接给用户（天枢网址是 \`${endpoint.replace(/\/mcp\/me$/, "")}\`，例如 \`${endpoint.replace(/\/mcp\/me$/, "")}/issues/<id>\`），让用户回天枢网页处理。`,
    ] : [
      "- 不用等用户开口，主动把用户正在推进的工作同步进天枢：开始一件新工作时用 `list_my_items` 找到对应事项，没有、而且够一件执行事项（Mission 卡上一个带 ◆ 关口的 Activity，一般 1–2 周，一个 Task 下 2–5 件）才用 `create_item` 建一条（过程步骤、修小问题、配置、一次会、一次问答、跑完一个子任务都只写进展）；做出阶段成果（提交、PR、文档）或告一段落时用 `append_progress` 写一条进展（做了什么、证据链接、下一步或阻塞）；做出来的文档、设计稿、PR 用 `add_link` 放进这件事；做完用 `submit_for_acceptance` 提交验收（对照完成标准逐条写明是否达到和依据），由用户在天枢逐条确认完成。只写真实做过的事。",
      `- 用户说「同步本周进展」时，照这段做：${SYNC_INSTRUCTION}`,
      "- 月末天枢会请每人对照自己的 Mission Card 做个人复盘，Co-Agent 会先起草一版。用户说「改写我的月度复盘」时：调用 `get_my_review` 看状态、Mission、现有草稿和写作要求，结合用户手边的周复盘、文档和提交记录补充改写四部分，用 `save_review_draft` 保存；不能替用户提交，写完请用户回天枢确认提交。`list_pending` 里出现待提交的个人复盘时，主动提醒用户。",
      "- 可以问用户要不要把上面两条写进常用项目的 AGENTS.md 或 CLAUDE.md（不要写令牌）。",
    ]),
    "",
    ...(role === "member" && weeklySync ? [
      "## 第三步：设好每周五自动同步（用户已选择开启）",
      "",
      ...(client === "other" ? [
        "帮用户在系统里建一个每周五 18:00 运行的定时任务，用你所在工具的非交互（命令行）方式，带着上面「同步本周进展」那段指令运行。你的工具不支持非交互运行的话，告诉用户改成每周五手动说一次「同步本周进展」。",
      ] : [
        "帮用户在系统里建一个每周五 18:00 运行的定时任务，运行：",
        "",
        "```",
        syncCommand(client),
        "```",
      ]),
      "",
      "- 工作目录设成用户放项目的目录；可以是装着多个仓库的上级目录，它本身不必是 git 仓库。",
      "- Windows 用任务计划程序（`schtasks`）；macOS 用 LaunchAgent（`~/Library/LaunchAgents` 里的 plist，`StartCalendarInterval`，电脑休眠错过的会在唤醒后补跑），不要用 crontab；Linux 用 crontab。",
      "- 写 plist、`launchctl`、`schtasks`、`crontab` 这类命令多半会被你的沙箱拦住：直接申请在沙箱外执行，让用户在批准弹窗里点允许。用户多半不是技术人员，不要让用户自己去终端敲命令；确实无法申请时，才把要执行的那一条命令给用户，并说清怎么打开终端、粘贴、回车。",
      "- 定时任务不会读用户的 shell 配置，终端里能找到的命令它可能找不到：用一个小脚本包起来，脚本开头先加载用户的 shell 配置（例如 macOS 上 `source ~/.zshrc`），输出写进日志文件。",
      "- 建好后用调度器立即触发一次（macOS：`launchctl kickstart gui/$(id -u)/<Label>`；Windows：`schtasks /run /tn <任务名>`），看日志，再请用户打开天枢「账号菜单 → 连接到外部工具」，这条连接显示「最近同步」就说明写进了天枢。不要只在终端里直接跑命令，那样测不出定时环境缺了什么。",
      "- 最后把任务名、下次运行时间和日志位置告诉用户。",
      "",
    ] : []),
    "## 最后",
    "",
    "提醒用户删掉这个文件。令牌丢了或不用了，可以在天枢的「账号菜单 → 连接到外部工具」里撤销再生成。",
    "",
  ].join("\n");
}
