import type { TLocalRole, TLocalRoleTool, TLocalSessionKind } from "@warmap/contracts";

/**
 * 会话追加的系统提示词（--append-system-prompt-file）、挑刺子 agent 的定义（--agents）、评审会的那句话（ADR 0033）。
 * 工作规矩写在这里（V2 设计 6.6），岗位的职责、做法、验收口径原样接在后面。都写在本机程序自己的数据目录，不进本人的仓库。
 */

const CARD_RULES = `## 规矩
- 产出写在当前工作目录里，用 add_artifact 交；证据（说明、日志片段、链接、改动摘要）用 add_evidence 交。两个工具都会返回编号（A1、E1）。
- 做完用 hand_back 交回：对照完成标准逐条写达到、部分还是没达到，附证据，点名用到的产出和证据编号，再写一句总结。交回后由验收员验收，没过会把意见发回来，照着改完再交回。
- 只在当前工作目录和本人允许的文件夹里读写，要碰别处先说为什么。`;

const TOPIC_RULES = `## 规矩
- 先交提纲：写成工作目录里的 Markdown 文件，用 save_version（kind=outline）存，然后停下，等本人的意见。
- 本人同意后写正文，写完用 save_version（kind=draft）存；以后每改一次存新的一版，note 写这一版改了什么。
- 本人要把某一版存进飞书时，用飞书工具存进本人的云文档，再用 set_feishu_url 报回第几版和地址。
- 图、PDF 这类附件用 add_artifact 交。`;

const TOOL_TEXT: Record<TLocalRoleTool, string> = {
  tianshu: "天枢：用天枢 MCP（tianshu）读本人的事项、Mission 和公司资料；写进去的操作每次都要本人批准",
  web_search: "联网搜索：用天枢 MCP 的 web_search",
  feishu: "飞书：用 lark-cli 命令行和 tianshu-feishu 里的飞书技能，以本人的飞书登录操作",
  github: "GitHub：用 gh 命令行",
  browser: "浏览器：这台电脑上没有给会话用的浏览器插件，要用时先问本人",
};

function roleBlock(role: TLocalRole, heading: string): string {
  const parts = [`${heading}${role.name}`];
  if (role.dutiesMd.trim()) parts.push(`### 职责\n${role.dutiesMd.trim()}`);
  if (role.practiceMd.trim()) parts.push(`### 做法\n${role.practiceMd.trim()}`);
  if (role.acceptanceMd.trim()) parts.push(`### 验收口径\n${role.acceptanceMd.trim()}`);
  return parts.join("\n\n");
}

/** 挑刺子 agent 在会话里的名字：critic-1、critic-2…（Agent 工具的 subagent_type）。 */
export const criticAgentName = (i: number) => `critic-${i + 1}`;

export function systemPrompt(kind: TLocalSessionKind, role: TLocalRole | null, critics: TLocalRole[], feishuMounted: boolean): string {
  const parts = [
    "# 天枢本机会话",
    `本人在天枢网页上把这${kind === "card" ? "张卡" : "个调研专题"}派给你，在本人自己的电脑上做。网页能看到你的每一步，本人会批权限、插话。`,
    kind === "card" ? CARD_RULES : TOPIC_RULES,
  ];
  if (role) {
    parts.push(roleBlock(role, "## 你的岗位："));
    const tools = role.tools.map((t) => `- ${TOOL_TEXT[t]}${t === "feishu" && !feishuMounted ? "（这台电脑上没找到飞书技能，做不了时直接告诉本人）" : ""}`);
    parts.push(`### 能用的工具\n${tools.length ? tools.join("\n") : "- 只用 Claude Code 自带的读写和命令"}`);
  }
  if (kind === "topic" && critics.length) {
    parts.push(`## 评审会\n本人点「评审会」时，并行调用下面这几个挑刺子 agent（Agent 工具，subagent_type 就是名字），各自读最新一版挑刺；都回来以后合成一份「分歧和建议」，用 save_version（kind=review）存一版，不改正文。\n${
      critics.map((c, i) => `- ${criticAgentName(i)}：${c.name}`).join("\n")}`);
  }
  return parts.join("\n\n") + "\n";
}

/** --agents 的定义：每个挑刺岗位一个只读的子 agent。 */
export function criticAgents(critics: TLocalRole[], searchTool: string | null): Record<string, { description: string; prompt: string; tools: string[] }> {
  return Object.fromEntries(critics.map((c, i) => [criticAgentName(i), {
    description: `挑刺岗位「${c.name}」：按这个岗位的口径给专题的某一版挑刺，只提意见、不改稿`,
    prompt: `${roleBlock(c, "# 你是挑刺岗位：")}\n\n## 怎么做\n读主会话指定的那一版，按你的职责和口径逐条列问题、理由和建议，最后一句给总体判断。只提意见，不改任何文件。\n`,
    tools: ["Read", "Grep", "Glob", ...(searchTool && c.tools.includes("web_search") ? [searchTool] : [])],
  }]));
}

/** 网页点「评审会」时本机替本人说的那句话。 */
export function reviewMessage(critics: TLocalRole[], latest: { number: number; path: string } | null, extra?: string): string {
  const who = critics.map((c, i) => `${criticAgentName(i)}（${c.name}）`).join("、");
  const target = latest ? `第 ${latest.number} 版（文件 ${latest.path}）` : "最新一版";
  return `开评审会：请同时调用挑刺子 agent ${who}，让它们各自读${target}挑刺。都回来以后，把意见合成一份「分歧和建议」（各方一致的意见、分歧点和各方理由、建议怎么改），写成工作目录里的 Markdown 文件，用 save_version（kind=review）存一版。不要改正文。${
    extra ? `\n\n本人补充：${extra}` : ""}`;
}
