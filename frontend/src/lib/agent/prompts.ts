/**
 * 五段 prompt 装配。对齐自 `tkos-lab/src/tkos_lab/prompt/assembler.py`。
 *
 * ① 输入契约 ② 上下文注入 ③ 认知指令 ④ 输出格式 ⑤ 硬约束。
 *
 * ①②④⑤ 在 `prompts/engineering/<key>.md` 里，是工程的事；③ 由运行时传进来，
 * 缺省回落到 `prompts/cognitive/<key>.md`，是方法部门的事。两边分开放，是为了
 * 让改 prompt 的人不用碰代码，也不会顺手把输出格式改坏 —— 输出格式一改，下游
 * 按字段取值的每一处都会静默拿到 undefined。
 *
 * 用 `.md` 文件而不是 TS 模板字符串：prompt 要能改完就生效、不用重新构建。
 * 代价是它不进 webpack 产物，所以 `next.config.ts` 里要显式追踪。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

const ENG = path.join(process.cwd(), "prompts", "engineering");
const COG = path.join(process.cwd(), "prompts", "cognitive");
/*
 * 方法部门给的技能文档原件放这里，一个文件一份技能。认知段文件用
 * `{{SKILL:<名字>}}` 引它，不抄它。
 *
 * 抄的代价是静默漂移：S01 一份技能同时管四个 prompt key，抄成四份之后，方法
 * 部门给 v0.5 时改三份漏一份 —— 漏的那一个 prompt 照样跑，照样出格式正确的
 * 议题，只是它按上一版的标准在判断，而结果页上看不出任何区别。
 */
const SKILLS = path.join(COG, "skills");

/**
 * 工程段模板不存在。
 *
 * **不回落到空模板。** 回落的话模型拿到的是一份没有输出格式约束的自由作文题，
 * 而它照样会返回一段 JSON —— 于是「prompt 根本没装上」这件事在结果页上完全
 * 看不出来，只表现为「这个 prompt 效果不好」。
 */
export class PromptKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromptKeyError";
  }
}

/*
 * 图谱里没有对应锚点时，塞进 Prompt 第 ② 段（上下文注入）的东西。
 *
 * 这一段不能留空。留空的话模型面对的是一个「上下文位置有个空洞」的 Prompt，
 * 它会去填这个洞——凭常识编出几条听着像公司战略假设的东西，然后正常引用。
 * 那种产出最难发现：格式全对，引用看着也有，只是全是假的。所以这里明确写出
 * 「没有」，并且把「不许编」和「引用必须为空」写成硬约束。
 *
 * **住在这个文件里，是为了让 `FILL.context` 的兜底串就是它。**（原来在 harness.ts，
 * 兜底串是另写的一句「（本次未取到公司上下文）」—— 缺了那两条硬约束，而那两条正是
 * 这段话存在的理由。兜底是防线的最后一层，弱在那里等于没有。）
 */
export const NO_COMPANY_CONTEXT = `（本次没有公司上下文）

GraphKnowledge 里没有与这条输入对应的锚点，因此这次运行**拿不到任何公司内部
信息**：没有战略假设、没有判断链、没有共识记录，也没有任何可引用的 member。

这不代表这条输入与战略无关，而是说明它对公司现有的战略方向来说还太新——
图谱里还没有它的位置。所以你要做的是**纯外部推理**：

- 只依据上面那条输入本身，以及公开可查的通行事实来推理。
- 不要假设公司内部存在任何相关材料，不要写「公司现有战略假设是……」这类句子。
  没有材料就说没有材料，宁可结论更弱，也不许把推测写成公司现状。
- cited_member_ids 必须是空数组 \`[]\`。这次没有任何 member 可引，写进去的一定是
  编的。
`;

/**
 * 锚点没命中、但【公司经营状态】（P0）取到了 —— 塞进第 ② 段的就是这一段。
 *
 * 这是 `NO_COMPANY_CONTEXT` 和完整上下文之间那一档，**必须有自己的说法**。直接把
 * P0 当完整上下文塞进去，模型看到「公司经营状态」四个字就会认为图谱里有这条议题的
 * 既有认识，然后写出「公司现有判断是……」；而继续用 `NO_COMPANY_CONTEXT`，就是明明
 * 手里有 4000 字真实经营状态却告诉模型「什么都没有」。所以这一段说的是三件事：
 * 有什么、没有什么、以及引用照旧必须为空。
 *
 * 引用为空这一条不因为装了 P0 而放松：P0 那条路（`Builder.p0()`）**不产生任何
 * memberId**，连锚定的时候都不产生。所以正文里出现的任何编号都不是可引的 member，
 * 写进 `cited_member_ids` 的一定是编的 —— 跟没有上下文时是同一个结论。
 */
export const wrapCompanyStateOnly = (p0: string): string =>
  `（本次只有公司经营状态，没有这条议题的既有认识）

下面这一段是**公司当前的经营状态**，来自 GraphKnowledge，是真实的公司内部信息，
可以据此推理。但 GraphKnowledge 里没有与这条输入对应的锚点，所以**这条议题本身**
在图谱里没有位置：没有针对它的判断链、没有它的版本演进、没有相关的共识记录。

因此：

- 关于公司整体状况（本期要达成什么、哪些判断在版、当前处在什么阶段），依据下面
  这一段来写。
- 关于**这条输入**，做纯外部推理。不要写「公司现有判断是……」「公司已有研究表明……」
  这类句子 —— 图谱里没有这条议题的既有认识，那种句子一定是从经营状态里推想出来的。
  宁可结论更弱，也不许把推测写成公司现状。
- cited_member_ids 必须是空数组 \`[]\`。这一段不带任何可引用的 member，正文里出现的
  编号也不是 —— 写进去的一定是编的。

---

${p0}
`;

/**
 * 本体叙述接口那一支填第 ② 段的东西。
 *
 * ## 本体里有两层，这一支只拿得到其中一层
 *
 * · **语义记忆**：跟公司有关的内容 —— 愿景、本期 Outcome、八个 Domain、各条 Mission、
 *   经营原则。这一层**拿得到**，下面这段就是它。
 * · **工作记忆**：存进本体的议题，以及它挂着的判断与共识。这一层**本体还没建到**，
 *   所以这一次一条都没有。
 *
 * 这个区分是这一整段话存在的理由。少了工作记忆，下面这些东西这一轮**一句都没有**：
 * 这条议题以前被讨论过没有、围绕它形成过哪些判断、哪些已经确认、被什么推翻过。
 * 而模型手上拿着一整段真实的公司材料，最顺手的写法恰恰是从那段材料里推想出一句
 * 「公司现有判断是……」—— 格式完整、语气笃定、没有一处报错，也没有一处是真的。
 *
 * ## 「与当前问题直接相关的节点是……」那句话要单独拆掉
 *
 * 上游的叙述里常带这么一句。它说的是**公司层材料与这条输入的挂靠关系**（本体自己算的），
 * 不是「公司讨论过这条输入」。不点破的话，模型读到的就是一个恒为真的相关性断言 ——
 * 拿一句跟公司毫无关系的话去问（实测「日本北海道的滑雪场雪质如何」），它照样会写出
 * 「与当前问题直接相关的节点有二」。
 *
 * ## 为什么不能复用另外两档任何一句
 *
 * 跟 `wrapCompanyContext` 的差别是**没有可引编号**：那一段整段在教模型「短码可以照原样
 * 引用，屏幕会把它变成可点开的」，而这一支一个短码都不回。跟 `wrapCompanyStateOnly` 的
 * 差别是**这一段挂得上这条输入**（本体算过挂靠关系），那一段说的是「关于这条输入做纯外部
 * 推理」，照抄过来就是把手上真有的挂靠关系判成不相关。
 */
export const wrapCompanyNarrative = (text: string): string =>
  `（本次公司上下文：**公司层**的经营脉络，没有这条议题自己的历史）

下面这一段是本体里的**公司层内容**：愿景、本期 Outcome、各个 Domain 与 Mission、
经营原则。它是真实的公司内部信息，可以据此推理。

**它不包含这条议题自己的历史。** 本体里另有一层是「议题 + 它挂着的判断 + 已有共识」，
那一层现在还没建起来，所以这一轮**拿不到**：这条议题以前有没有被讨论过、围绕它形成过
哪些判断、哪些判断已经确认、被什么推翻过 —— 一句都没有。

因此：

- 关于**公司整体**（本期要达成什么、哪些 Mission 在跑、公司的经营原则是什么），依据下面
  这一段写，它是准的。
- 关于**这条输入本身**，不要写「公司现有判断是……」「公司已有研究表明……」「我们之前
  认为……」。那一层这次不在你手上，这种句子只可能是从公司层材料里推想出来的。宁可结论
  更弱，也不许把推测写成公司已有的判断。
- 下面那段里若写着「与当前问题直接相关的节点是……」，那是**本体算出来的挂靠关系**，
  不是「公司讨论过这件事」。当挂靠关系读，不要当既有结论读。
- **要做的一件事：把这条输入挂到下面这段里的某个 Mission 或 Outcome 上。** 每一条战略
  议题都从属于某一条当前的 Mission —— 说清它挂在哪一条、会怎么影响那一条。挂不上就明说
  挂不上，**那本身是一条结论**：要么这条输入不在当前的战略路径上，要么当前这组 Mission
  没有覆盖它。两种都值得写出来。
- 这一段**没有任何可引用的编号**。正文里出现的是对象的名字（像「8月Outcome-01方向与
  经营选择」），不是可点开的短码。所以 cited_member_ids 必须是空数组 \`[]\`，
  写进去的一定是编的。
- 它是**一段转写，不是原话**。本体把内容压成了这段叙述，复述其中一句时按意思写，
  不要说成「公司原话是……」。

---

${text}
`;

export const PROMPT_SYSTEM =
  "你是使用 GraphKnowledge 公司上下文的 TKOS 专用 Agent。" +
  "严格按给定的输出格式作答，只输出 JSON，不要任何解释性文字、不要 Markdown 代码围栏。" +
  "上下文里没有的事实一律不要写。";

/** runtime = 这次跑传进来的；default = 用了 `prompts/cognitive/<key>.md`；empty = 两者都没有。 */
export type CognitiveSource = "runtime" | "default" | "empty";

export type AssembledPrompt = {
  key: string;
  system: string;
  user: string;
  cognitiveUsed: string;
  cognitiveSource: CognitiveSource;
  chars: number;
};

// 读盘之后缓存。一次 A4 有十几次模型调用，每次都读盘等于十几次同步 IO，而
// prompt 在一次运行里是不变的。改了 md 重启 dev server 生效。
const cache = new Map<string, string | null>();

async function readOnce(file: string): Promise<string | null> {
  const hit = cache.get(file);
  if (hit !== undefined) return hit;
  let text: string | null = null;
  try {
    text = await readFile(file, "utf8");
  } catch {
    text = null;
  }
  cache.set(file, text);
  return text;
}

/*
 * key 会被拼进文件路径，所以先校字符。
 *
 * 今天不可达（`callPrompt` 的四个 key 全是字面量），但 `Harness.callPrompt(key: string)`
 * 是公开方法：哪天有人把外部传来的值接到这里，`../../` 就是任意文件读。校验放在这一层
 * 而不是调用方，是因为拼路径的动作发生在这里。
 */
const KEY_OK = /^[a-z0-9][a-z0-9.\-]*$/;

export async function engineeringFrame(key: string): Promise<string> {
  if (!KEY_OK.test(key)) {
    throw new PromptKeyError(`prompt key 不合法: ${JSON.stringify(key)}（只许小写字母、数字、. 和 -）`);
  }
  const text = await readOnce(path.join(ENG, `${key}.md`));
  if (text === null) {
    throw new PromptKeyError(`没有工程段模板: ${key}（找的是 prompts/engineering/${key}.md）`);
  }
  return text;
}

/*
 * 技能文档原件带 YAML frontmatter（name / version / owner / status）。那是登记
 * 信息，不是给模型看的，装进 prompt 只会多几十 token 并且让它以为要遵守
 * `status: Calibration Draft`。版本号在正文第一行的标题里，所以剥掉不丢溯源。
 */
function stripFrontmatter(md: string): string {
  return md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trimStart();
}

const SKILL_TOKEN = /\{\{SKILL:([^}]*)\}\}/g;

/**
 * 技能文档不存在 / 名字不合法。
 *
 * **不换成空串。** 换空串的话，那份 prompt 的第 ③ 段只剩下几行「这一次做哪一步」
 * 的引子，认知标准整段消失 —— 而模型照样会产出格式完整的结果。跟
 * `PromptKeyError` 同一个道理：装没装上，必须在跑起来的那一刻就炸。
 */
export class SkillNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillNotFoundError";
  }
}

/*
 * 导出只为了能直接测它。测不到的替代方案是在 `prompts/cognitive/` 里放一个引了
 * 不存在技能的夹具文件 —— 那个目录是方法部门在编辑的生产目录，往里塞测试用的
 * 坏文件，早晚有人把它当真实 prompt。
 */
export async function expandSkills(text: string): Promise<string> {
  const names = [...text.matchAll(SKILL_TOKEN)].map((m) => m[1].trim());
  let out = text;
  for (const name of names) {
    // 名字要拼进文件路径，跟 prompt key 同一条规矩（见下方 KEY_OK 那段注释）。
    if (!KEY_OK.test(name)) {
      throw new SkillNotFoundError(`技能名不合法: ${JSON.stringify(name)}（只许小写字母、数字、. 和 -）`);
    }
    const md = await readOnce(path.join(SKILLS, `${name}.md`));
    if (md === null) {
      throw new SkillNotFoundError(`没有这份技能文档: ${name}（找的是 prompts/cognitive/skills/${name}.md）`);
    }
    const body = stripFrontmatter(md);
    out = out.replace(new RegExp(`\\{\\{SKILL:\\s*${name}\\s*\\}\\}`, "g"), () => body);
  }
  return out;
}

export async function defaultCognitive(key: string): Promise<string> {
  const text = await readOnce(path.join(COG, `${key}.md`));
  return text === null ? "" : await expandSkills(text);
}

/**
 * 这次跑用哪一段认知指令：运行时传的优先，否则 `prompts/cognitive/<key>.md`。
 *
 * 独立导出，是因为 A3 预研没走五段装配（它的 user 段是手写的一整份，见
 * `a3/prompt.ts`），但认知段必须和 A1a 走同一条取值路径 —— 两条路径的话，
 * 「A3 的认知段到底装上了没有」得单独查一遍。
 */
export async function cognitiveFor(
  key: string,
  runtime?: string
): Promise<{ text: string; source: CognitiveSource }> {
  if (!KEY_OK.test(key)) {
    throw new PromptKeyError(`prompt key 不合法: ${JSON.stringify(key)}（只许小写字母、数字、. 和 -）`);
  }
  const rt = (runtime ?? "").trim();
  if (rt) return { text: rt, source: "runtime" };
  const fallback = (await defaultCognitive(key)).trim();
  return { text: fallback, source: fallback ? "default" : "empty" };
}

const FILL = {
  input: "（无）",
  // 兜底就是那段带硬约束的话本身。今天四处调用都传了 context，所以走不到这里 ——
  // 但走到这里的那天，「不许编」「引用必须为空」两条必须还在。
  context: NO_COMPANY_CONTEXT,
  evidence: "（本次无外部材料）",
  challenges: "（本次无红队挑战）",
  cognitive: "（本条 Prompt 的认知指令段尚未提供）",
} as const;

/*
 * 替换一律用**函数形式**的 replacer。
 *
 * `String.replace(re, str)` 会把替换串里的 `$&` / `$'` / `$1` 当成引用展开 ——
 * 图谱正文里真出现一次 `$&`，那一处就会被换回 `{{CONTEXT}}` 这五个字符，
 * 而 prompt 看起来只是「有一处怪字符」，没人会往替换语义上想。
 */
function fill(frame: string, token: string, value: string): string {
  return frame.replace(new RegExp(`\\{\\{${token}\\}\\}`, "g"), () => value);
}

export async function assemble(
  key: string,
  parts: {
    input?: string;
    context?: string;
    evidence?: string;
    challenges?: string;
    cognitive?: string;
  }
): Promise<AssembledPrompt> {
  const frame = await engineeringFrame(key);
  const { text: cognitiveUsed, source: cognitiveSource } = await cognitiveFor(key, parts.cognitive);

  let user = frame;
  user = fill(user, "INPUT", (parts.input ?? "").trim() || FILL.input);
  user = fill(user, "CONTEXT", (parts.context ?? "").trim() || FILL.context);
  user = fill(user, "EVIDENCE", (parts.evidence ?? "").trim() || FILL.evidence);
  user = fill(user, "CHALLENGES", (parts.challenges ?? "").trim() || FILL.challenges);
  user = fill(user, "COGNITIVE", cognitiveUsed || FILL.cognitive);

  return {
    key,
    system: PROMPT_SYSTEM,
    user,
    cognitiveUsed,
    cognitiveSource,
    chars: PROMPT_SYSTEM.length + user.length,
  };
}
