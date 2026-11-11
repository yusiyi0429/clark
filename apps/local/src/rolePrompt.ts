import type { TLocalRole, TLocalRoleTool, TLocalSessionKind, TLocalSourceWordIssue, TLocalVerdictCriterion, TLocalWorkspace } from "@warmap/contracts";
import { CARD_TITLE_RULE } from "./cardTitle.js";

/**
 * 会话追加的系统提示词（--append-system-prompt-file）、挑刺子 agent 的定义（--agents）、评审会的那句话（ADR 0037）。
 * 工作规矩写在这里（V2 设计 6.6），岗位的职责、做法、验收口径原样接在后面。都写在本机程序自己的数据目录，不进本人的仓库。
 */

/** 只改让改的那一处（主循环第 72 条）：卡和专题都用；以后的自由子会话也照这条。 */
export const EDIT_SCOPE_RULE = "- 本人让改某一处时只改那一处：别处觉得也该改（措辞、格式、相邻的段落），先说，不动手。改完用一句话说改了哪几处。";

const CARD_RULES = `## 规矩
- 产出写在当前工作目录里，用 add_artifact 交；证据（说明、日志片段、链接、改动摘要）用 add_evidence 交。两个工具都会返回编号（A1、E1）。
- 做完用 hand_back 交回：对照完成标准逐条写达到、部分、没达到还是要本人补，附证据，点名用到的产出和证据编号，再写一句总结。交回后由验收员验收，没过会把意见发回来，照着改完再交回。
- 遇到要登录、验证码、人工查询、网站拦自动访问、要本人的权限或判断的事，不绕：网站拦自动访问时，不换成伪装浏览器（改 User-Agent、套浏览器请求头、换抓取工具）去抓，也不找别的路子硬闯。能做的先做完；做不了的那几条在 hand_back 里标 needs_person（要本人补），need 写一句人话：要本人做什么、做完给回什么。一条一句。
- 本人在会话里提了交代以外的新事，先问清是「就在这里做并改约定」还是「另开一个」，本人答了再动手（有「问用户」AskUserQuestion 就用它，给这两个选项）；对现有交代的小补充、澄清不用问，照着做。
- 要改约定（本人选了就在这里做，或原来的完成标准做不到、要换个说法）就用 propose_agreement_change 提新的完成标准全文和原因，本人点头才生效；定之前照原来的约定做。约定在你做的时候改了，交回会被退回并附上新的完成标准，照新的逐条重新自评再交。
${EDIT_SCOPE_RULE}
- 只在当前工作目录和本人允许的文件夹里读写，要碰别处先说为什么。
- 报告、命令输出、测试结果写进交回的正文和证据（add_evidence），不要在仓库里留报告或输出文件：交回时工作目录里的改动都会进卡的分支。`;

const TOPIC_RULES = `## 规矩
- 先交提纲：写成工作目录里的 Markdown 文件，用 save_version（kind=outline）存，然后停下，等本人的意见。
- 本人同意后写正文，写完用 save_version（kind=draft）存；以后每改一次存新的一版，note 写这一版改了什么。
- 本人要把某一版存进飞书时，用飞书工具存进本人的云文档，再用 set_feishu_url 报回第几版和地址。
- 图、PDF 这类附件用 add_artifact 交。
${EDIT_SCOPE_RULE}`;

/** 自由子会话（第 68 条，项目下的「+」）：没有提纲、交回、验收；本人要的文件就写在文件夹里，只是不留本人没要的东西。 */
const FREE_RULES = `## 规矩
- 照本人说的做：没有提纲、交回和验收。做完一件，用一两句话说做了什么，停下等本人下一句。
- 本人要的文件（文档、表格、代码等）就写在当前工作目录里，直接写好、改好。想让本人在天枢里点开看的文件，再用 add_artifact 交一份。
- 不在文件夹里留本人没要的东西：临时文件、命令输出、你自己的过程记录用完就删，过程写在回复里。
- 遇到要登录、验证码、人工查询、网站拦自动访问、要本人的权限或判断的事，不绕：网站拦自动访问时，不换成伪装浏览器（改 User-Agent、套浏览器请求头、换抓取工具）去抓，也不找别的路子硬闯。能做的先做完，做不了的停下来告诉本人要做什么、做完给回什么。
${EDIT_SCOPE_RULE}
- 只在当前工作目录和本人允许的文件夹里读写，要碰别处先说为什么。`;

const PLAN_RULES = `## 规矩
- 你是规划员：只读，不改文件、不跑命令。拆的是 Task 时，用天枢 MCP 的 get_task_context 读这个 Task 的上下文（约定、Mission、近期的事和决定、上一版交付物和评审）；拆的是没挂 Task 的项目时，交代就是全部上下文。需要时读工作目录里的文件。
- 拆之前先把现实问清楚：对着末尾「开拆前本机看过的文件夹」想一想，照这样做下去会做成什么、是不是本人要的。没绑文件夹、文件夹是空的、不是 git 仓库，
  或者和这件事对不上（比如是写代码的活，却绑了一个空文件夹、没有远端），就先不出派活单：用「问用户」（AskUserQuestion）问本人，
  在哪个文件夹做、要不要新建、要不要连 GitHub 仓库、是不是从别处（比如 Codex）迁过来的、做出来是不是本人要的那样。每个问题给几个选项，推荐的排第一并标「（推荐）」。
  本人答了再拆；不要怕问。只看，不改文件夹。
- 能自己查到的不问本人：文件夹里有什么、Task 的约定和上下文，自己读。只把要本人拿主意的事问出来。
- 把 Task 或项目拆成计划和派活单，用 propose_plan 交：计划几步、先后、风险；派活单每件写交代、完成标准（每行一条、能检查）、对约定第几条、交给哪个技能（交代里技能清单的名字）、模型档位。一件就是一个 worker 一次能交回的活。
- 计划的 summary 开头先复述三件事：这件事要达到什么、解决什么问题、最少做到哪一步算完。
- 小事不拆：一个 worker 一次能做完的，就只出一件，不为了拆而拆。
- 排先后：最没把握的那件排前面；别的件要用到的排前面，并在用它的那件的 after 里写上。
- 完成标准每行写成能在真东西上看到的结果，并写清拿什么证明（文件、截图、链接、命令输出）。不要只写「已完成」「测试通过」。
- 每件的${CARD_TITLE_RULE}。标题不合规矩时 propose_plan 会退回，照它说的改完整份再交。
- 交代里有「本人原话」时，每件派活单的 sourceWords 写原话里和这件有关的片段：只能原样摘，不能改写、不能拼接；拿不准就不写（云端会用整条原话）。
- 一件要用到前面几件的结果（比如合起来跑测试、总验收）时，after 写上它要等的那几件的位置；本机会等那几件合回后再开它。互不相干的件不写 after，好同时做。
- 交完就停，等本人在网页上看派活单；本人让你改，改完再用 propose_plan 交一次。`;

const VERIFY_RULES = `## 规矩
- 你是验收员：只读，不改文件、不跑命令，也不替执行方补做。
- 依据是交代里的约定、卡的完成标准、卡所属技能的验收口径和你自己的验收口径；材料是交回里的自评、证据和产出（产出文件在当前工作目录里，可以读）。需要时用天枢 MCP 的 get_task_context 读 Task 的上下文。
- 每条完成标准判一次：达到（met）、部分（partial）、没达到（unmet）、要本人补（needs_person），写理由和依据，没达到的写怎么补；标准以外的建议放进 beyondScope，不算没达到。证据不够就判没达到。
- 要本人补：执行方在自评里标了「要本人补」、而且确实只有本人能做（要登录、验证码、人工查询、网站拦自动访问、要本人的权限或判断），判 needs_person，fix 写一句人话：要本人做什么、做完给回什么。执行方其实能做的（换个公开的来源、自己查得到、自己能跑），照旧判 unmet 或 partial，fix 写执行方怎么补。
- 每条没达到的（partial、unmet、needs_person）都写 fixBy：执行方能补的写 worker，只有本人能补的写 person（needs_person 一定是 person）。达到的不写。
- summary 写一句人话：卡在哪、要谁做什么（例：「候选名和含义都齐了，近似商标要你登录商标网查」）。不写行号，不复述标准原文。
- 对照交代里的改动：完成标准没要求的新增或改动的文件（报告、命令输出、临时文件等），逐个指出来，写进相关那条的理由或 beyondScope。
- 交代里有「本人原话」时：逐条判完完成标准，再对一遍原话。产出明显漏了原话里明说的（missing），或做了原话里没要的（extra），写进 sourceWordIssues：quote 原样抄是哪一句，再写为什么。有一条就是没过，完成标准全达到也一样；拿不准的不写。
- 判完用 submit_verdict 交一次结论，然后停下。`;

const RULES: Record<TLocalSessionKind, string> = { card: CARD_RULES, topic: TOPIC_RULES, plan: PLAN_RULES, verify: VERIFY_RULES };
const INTRO: Record<TLocalSessionKind, string> = {
  card: "本人在天枢网页上把这张卡派给你，在本人自己的电脑上做。网页能看到你的每一步，本人会批权限、插话。",
  topic: "本人在天枢网页上把这个调研专题派给你，在本人自己的电脑上做。网页能看到你的每一步，本人会批权限、插话。",
  plan: "本人在天枢网页上请你把一个 Task（或没挂 Task 的项目）拆成计划和派活单，在本人自己的电脑上做。网页能看到你的每一步，本人会插话。",
  verify: "执行方交回了一张卡，本机请你验收，在本人自己的电脑上做。网页能看到你的每一步。",
};
const FREE_INTRO = "本人在天枢网页上的项目里开了这个子会话，在本人自己的电脑上做。网页能看到你的每一步，本人会批权限、插话。";

const TOOL_TEXT: Record<TLocalRoleTool, string> = {
  tianshu: "天枢：用天枢 MCP（tianshu）读本人的事项、Mission 和公司资料；写进去的操作每次都要本人批准",
  web_search: "联网搜索：用天枢 MCP 的 web_search",
  feishu: "飞书：用 lark-cli 命令行和飞书技能，以本人的飞书登录操作",
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

/** 飞书技能从哪来：本机挂的会话插件、本人自己的配置（带个人配置时），或者这台电脑上没有。 */
export type FeishuSkills = "plugin" | "personal" | null;
const FEISHU_NOTE: Record<"plugin" | "personal" | "none", string> = {
  plugin: "（技能在 tianshu-feishu 插件里，如 tianshu-feishu:lark-doc）",
  personal: "（用本人自己装的 lark-* 技能）",
  none: "（这台电脑上没找到飞书技能，做不了时直接告诉本人）",
};

/** 卡在自己的工作树里做时多交代的几句（ADR 0038）。 */
function worktreeNote(ws: Extract<TLocalWorkspace, { kind: "worktree" }>): string {
  return `## 在哪做
你在本机给这张卡新开的 git 工作树里（分支 ${ws.branch}，从 ${ws.baseBranch} 的提交 ${ws.baseCommit.slice(0, 7)} 开始），不是本人的主文件夹；别的卡在各自的工作树里，互不影响。
- 工作树是新的：.env、node_modules 这类没进 git 的文件没有带过来。要装依赖就自己装；缺钥匙、缺配置就问本人。
- 可以自己提交。交回时本机会把还没提交的改动提交到这个分支，验收员看的是开工以来这个分支上的全部改动。
- 不要切换分支，不要改主文件夹（${ws.folder}）。`;
}

/** 项目另外绑的文件夹（设计 17.2 第 46 条）：两家执行方都靠这几句知道有它们。 */
function extraDirsNote(dirs: string[], worktree: boolean): string {
  return `## 项目另外的文件夹
这个项目除了工作目录，还绑着下面这些文件夹，用到时写绝对路径：
${dirs.map((d) => `- ${d}`).join("\n")}
它们是本人自己的文件夹，没有单独的工作树。${worktree ? "在里面改的东西不在这张卡的分支上，交回时写明改了哪些文件。" : ""}`;
}

export function systemPrompt(
  kind: TLocalSessionKind, role: TLocalRole | null, critics: TLocalRole[], feishu: FeishuSkills, workspace: TLocalWorkspace | null = null,
  customTools: { server: string; name: string }[] = [], extraDirs: string[] = [], free = false,
): string {
  // 自由子会话（第 68 条）是带 free 的专题，换一套规矩
  const parts = ["# 天枢本机会话", free ? FREE_INTRO : INTRO[kind], free ? FREE_RULES : RULES[kind]];
  if (workspace?.kind === "worktree") parts.push(worktreeNote(workspace));
  if (extraDirs.length) parts.push(extraDirsNote(extraDirs, workspace?.kind === "worktree"));
  if (customTools.length) {
    const list = customTools.map((t) => `- ${t.name}：MCP 服务器 ${t.server} 里的工具`).join("\n");
    parts.push(`## 本人加的工具\n${list}\n查数据的照权限模式用，改数据的每次都要本人批准。`);
  }
  if (role) {
    parts.push(roleBlock(role, "## 你的技能："));
    const tools = role.tools.map((t) => `- ${TOOL_TEXT[t]}${t === "feishu" ? FEISHU_NOTE[feishu ?? "none"] : ""}`);
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
    description: `挑刺技能「${c.name}」：按这个技能的口径给专题的某一版挑刺，只提意见、不改稿`,
    prompt: `${roleBlock(c, "# 你用的挑刺技能：")}\n\n## 怎么做\n读主会话指定的那一版，按你的职责和口径逐条列问题、理由和建议，最后一句给总体判断。只提意见，不改任何文件。\n`,
    tools: ["Read", "Grep", "Glob", ...(searchTool && c.tools.includes("web_search") ? [searchTool] : [])],
  }]));
}

/**
 * 从卡的开工交代里认出交给执行方的约定（主循环第 60 条，离线开工、没取到版本号时交回比内容用）。交代是云端 cardBrief 的 markdown
 * （「## 交代」一段、「## 完成标准…」下面编号的一条一行），或网页取不到交代时自己拼的「完成标准：」。
 * standards 认不出为 null（不比）；brief 没有「## 交代」这一段为 undefined（不比），写的是「没写交代」为 null。
 */
export function agreementInBrief(markdown: string): { standards: string[] | null; brief?: string | null } {
  const lines = markdown.split(/\r?\n/);
  const head = lines.findIndex((l) => /^(## )?完成标准/.test(l.trim()));
  let standards: string[] | null = null;
  if (head >= 0) {
    standards = [];
    for (const l of lines.slice(head + 1).map((x) => x.trim())) {
      if (!l) continue;
      const m = /^\d+\.\s+(.*)$/.exec(l);
      if (!m) break;
      standards.push(m[1]!.trim());
    }
  }
  const at = lines.findIndex((l) => l.trim() === "## 交代");
  if (at < 0) return { standards };
  const end = lines.findIndex((l, i) => i > at && l.startsWith("## "));
  const text = lines.slice(at + 1, end < 0 ? undefined : end).join("\n").trim();
  return { standards, brief: !text || text === "（没写交代，按标题和完成标准做）" ? null : text };
}

/** 验收没过时结论事件里的改法：固定格式拼，不调模型（和云端 cardAcceptance.ts 的 returnText 一个格式，原话对不上的接在后面）。送回执行方走云端那条路。 */
export function returnText(criteria: string[], judged: TLocalVerdictCriterion[], issues: TLocalSourceWordIssue[] = []): string {
  const missed = judged.filter((c) => c.verdict !== "met")
    .map((c) => `第 ${c.index} 条「${criteria[c.index - 1] ?? ""}」，${c.reason}；怎么补：${c.fix ?? "补上能核对的证据"}`);
  const words = issues.map((i) => `本人原话「${i.quote}」${i.kind === "missing" ? "漏了" : "里没要这个"}：${i.reason}`);
  return `验收没过：${[...missed, ...words].join("。")}。改完再交回。`;
}

/** 验收员交代末尾接上的这次交回的改动（卡在工作树里做时）：基线到交回的提交。验收员只读、不能跑命令，改动全靠这里和读文件。 */
export function changesBrief(ws: { branch: string; baseBranch: string; baseCommit: string }, commit: string, diff: { stat: string; patch: string; truncated: boolean } | string): string {
  const head = [
    "## 这次交回的改动",
    `分支 ${ws.branch} 的提交 ${commit.slice(0, 7)}，相对开工时 ${ws.baseBranch} 的 ${ws.baseCommit.slice(0, 7)}。当前工作目录就是这个分支，文件可以直接读。`,
  ].join("\n");
  if (typeof diff === "string") return `${head}\n\n改动没取到（${diff}），请直接读文件核对。`;
  if (!diff.stat) return `${head}\n\n开工以来没有改动。`;
  const cut = diff.truncated ? "\n…（太长，后面截掉了，没列出的改动请直接读文件）" : "";
  return `${head}\n\n\`\`\`\n${diff.stat}\n\`\`\`\n\n\`\`\`diff\n${diff.patch}${cut}\n\`\`\``;
}

/** 网页点「评审会」时本机替本人说的那句话。 */
export function reviewMessage(critics: TLocalRole[], latest: { number: number; path: string } | null, extra?: string): string {
  const who = critics.map((c, i) => `${criticAgentName(i)}（${c.name}）`).join("、");
  const target = latest ? `第 ${latest.number} 版（文件 ${latest.path}）` : "最新一版";
  return `开评审会：请同时调用挑刺子 agent ${who}，让它们各自读${target}挑刺。都回来以后，把意见合成一份「分歧和建议」（各方一致的意见、分歧点和各方理由、建议怎么改），写成工作目录里的 Markdown 文件，用 save_version（kind=review）存一版。不要改正文。${
    extra ? `\n\n本人补充：${extra}` : ""}`;
}
