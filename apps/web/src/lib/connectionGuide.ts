/** 「连接到外部工具」：给非技术同事的一份说明文件，发给自己的 Codex、Claude Code 或其他 AI 工具，由它照着完成设置。 */

export type AgentClient = "codex" | "claude" | "other";
/** collector 是本机采集器的令牌：只出现在连接列表里，不走 MCP 连接说明。 */
export type TokenClient = AgentClient | "collector";

export const clientName = (client: TokenClient) => client === "codex" ? "Codex" : client === "claude" ? "Claude Code" : client === "collector" ? "本机采集器" : "AI 工具";

/** 用户说「同步本周进展」时照这段做（本人明确要求的同步）。 */
export const SYNC_INSTRUCTION = `用天枢 MCP 同步我本周的工作进展：先调用 tianshu 的 list_my_items（status=all）看我负责的执行事项；我已知的协作事项用 get_item 核对。再根据我这周实际做过的事（当前目录及其下各仓库的提交、文档，以及我们的对话），为每件有进展的事项调用一次 append_progress，写清做了什么、证据链接和下一步；做出来的文档、设计稿、PR 这类有链接的东西，用 add_link 放进对应事项。实际推进了、但天枢里还没有对应事项的工作，不要新建事项，也不要硬写进不相干的事项，最后列给我，由我决定要不要建。我推进的事项已经做完的，用 submit_for_acceptance 提交验收，对照完成标准逐条写明是否达到和依据，完成由我在天枢逐条确认。没有进展的事项不要写，不要编造。最后列出你写了哪几条，以及哪些工作在天枢里还没有对应事项。`;

/** Codex 的天枢配置：令牌直接写请求头（桌面 App、IDE 插件、命令行读同一份，不依赖环境变量）；
 *  放行天枢工具：本人叫 Agent 写的时候不用再点一次确认。 */
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
 *  天枢工具设为免确认：本人叫 Agent 写的时候不用再点一次确认。 */
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
  ].join("\n");
}

/** 说明文件不含令牌：放令牌的地方写占位，由本人自己粘贴，令牌不进 Agent 的对话记录。 */
const TOKEN_PLACEHOLDER = "<你的天枢令牌>";
const PASTE_YOURSELF = "这一处请本人自己粘贴令牌，Agent 不要读取或保存令牌";

export function connectionGuide({ role, client, endpoint, expires }: { role: "ceo" | "member"; client: AgentClient; endpoint: string; expires: string }): string {
  const name = clientName(client);
  const token = TOKEN_PLACEHOLDER;
  const steps = client === "other" ? [
    "天枢是一个远程 MCP 服务（Streamable HTTP，Bearer 令牌）。请按你所在工具自己的方式添加它，名称用 `tianshu`：",
    `- 地址：\`${endpoint}\``,
    `- 请求头：\`Authorization: Bearer ${token}\`（${PASTE_YOURSELF}：把 \`${token}\` 换成天枢网页上复制的令牌）`,
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
    `   ${PASTE_YOURSELF}：写好后请用户打开这个文件，把 \`${token}\` 换成天枢网页上复制的令牌。`,
    "   令牌写在请求头里，Codex 的桌面 App、IDE 插件和命令行都读这一份，不需要环境变量；`default_tools_approval_mode = \"approve\"` 只对天枢生效，用户叫你写天枢时不用再点一次确认。",
    "   这个文件在工作目录之外，写入被沙箱挡住时，申请在沙箱外执行，让用户在批准弹窗里点允许。",
    "2. 请用户完全退出并重新打开 Codex（桌面 App 要从菜单里退出，不只是关窗口）。",
  ] : [
    `1. 请用户自己在终端运行下面这条命令，运行前把 \`${token}\` 换成天枢网页上复制的令牌（${PASTE_YOURSELF}）：\`claude mcp add --transport http --scope user tianshu ${endpoint} --header "Authorization: Bearer ${token}"\``,
    "   `--scope user` 让用户的所有项目都能用，不只是当前目录。",
    "2. 请用户重新打开 Claude Code。",
  ];
  return [
    `# 把 ${name} 连到天枢`,
    "",
    "这份文件由天枢生成。拿到它的 Agent：请按下面的步骤帮用户完成连接，每做完一步告诉用户结果；需要用户自己操作的地方（比如重新打开），停下来说清楚。",
    "",
    role === "ceo"
      ? `> 本说明使用的 CEO 工具只读。凡是写着 \`${token}\` 的地方，${PASTE_YOURSELF}。配置写在用户级，不要写进项目仓库里的文件。`
      : `> 令牌只能读写用户自己的执行事项。凡是写着 \`${token}\` 的地方，${PASTE_YOURSELF}。配置写在用户级，不要写进项目仓库里的文件。`,
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
      "- 只在用户明确要求时才往天枢里写（比如「记一下」「建一件事」「提交验收」），用户没开口就只读：要建事项时先用 `list_my_items` 看有没有同一件，没有再用 `create_item` 建，用户叫建什么就建什么；要记进展时用 `append_progress` 写一条（做了什么、证据链接、下一步或阻塞）；做出来的文档、设计稿、PR 用 `add_link` 放进这件事；用户说做完了，用 `submit_for_acceptance` 提交验收（对照完成标准逐条写明是否达到和依据），由用户在天枢逐条确认完成。只写真实做过的事。",
      "- Task 的约定与对表：`list_my_items` 的 missions[].tasks 里每个 Task 带 criteriaCount（几条验收标准）和 agreementComplete（约定补全了没有）。用户问某个 Task「能交了吗」「还差什么」时，调用 `check_task` 对表，照结果说结论和差的那几条，不自己另判；想看每条用什么证明、谁来认，调用 `get_task_agreement`。用户要你交一版时，才用 `add_deliverable_version` 交做出来的东西的链接（会自动参考评审，文件请用户在天枢网页上传）；交付由用户在天枢点。",
      `- 用户说「同步本周进展」时，照这段做：${SYNC_INSTRUCTION}`,
      "- 月末天枢会请每人对照自己的 Mission Card 做个人复盘，Co-Agent 会先起草一版。用户说「改写我的月度复盘」时：调用 `get_my_review` 看状态、Mission、现有草稿和写作要求，结合用户手边的周复盘、文档和提交记录补充改写四部分，用 `save_review_draft` 保存；不能替用户提交，写完请用户回天枢确认提交。`list_pending` 里出现待提交的个人复盘时，主动提醒用户。",
      "- 可以问用户要不要把上面两条写进常用项目的 AGENTS.md 或 CLAUDE.md（不要写令牌）。",
    ]),
    "",
    "## 最后",
    "",
    "提醒用户删掉这个文件。令牌丢了或不用了，可以在天枢的「账号菜单 → 连接到外部工具」里撤销再生成。",
    "",
  ].join("\n");
}
