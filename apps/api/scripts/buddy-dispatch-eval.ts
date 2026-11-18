/**
 * 伙伴主线「自己做，还是开会话」的离线评测（真实模型）：`pnpm --filter @warmap/api exec tsx --env-file=<env 文件> scripts/buddy-dispatch-eval.ts [--out 结果.json]`
 *
 * - 读 PI_BASE_URL / PI_API_KEY / HEAVY_MODEL，**不打印任何密钥值**。不开会话、不写库、不碰 3700 的数据：工具全是脚本里的假实现。
 * - 工具 = actionList（完全授权、伙伴主线）的名字、说明、参数原样，加一个假的 web_search。
 * - 系统提示 = driSystemPrompt（同 scripts/buddy-persona-eval.ts 的取法）+ Chat 那段「# 代本人在天枢里做事」（下面 BUDDY_ACTION_RULES，照抄的）。
 * - 9 句本人的话各跑一遍：read_work_home、read_project 回写死的首页（「天枢新版」挂 Task「首页改版」、有一个在跑的会话「首页改版」；
 *   「Chat 服务」挂 Task「答复质量」；「随手」带 scratch）；web_search 回一条假结果。模型第一次调写动作或 ask_user 就记下来、这一句结束；最多 4 轮工具来回。
 * - 逐句结果写 stdout，全部写到 --out（缺省写到系统临时目录）。9 句里判对少于 7 句、或 4 句「自己做」里有一句调了写动作，退出码 1。
 *
 * 局限：系统提示是照抄的近似，不是 Chat 真跑时的全部（Chat 自己的角色提示、伙伴人设、记忆、历史都不在这里）；
 * 只看「第一步选了哪条路」（自己做 / 开会话 / 转给项目 / 问本人），不看回答写得好不好、交代写得对不对。
 */
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { actionList } from "../src/buddyActions.js";
import { driSystemPrompt } from "../src/piConversationRuntime.js";

const OWNER = "孙铭泽";

/**
 * 照抄自晨星的 Chat 仓库 csl-actions `src/prompt.ts:66-72`（BUDDY_ACTION_RULES，2026-11-18 抄），只作评测用；
 * Chat 那边改了这里不会跟着变，跑之前对一眼。
 */
const BUDDY_ACTION_RULES = `# 代本人在天枢里做事

工具里来自天枢的动作（读首页和项目、打开页面、改外观和推送、开工或停掉子会话、建项目和转交、发消息等）由天枢按本人自己的权限执行，不受上面只读限制的约束。本人要你在天枢里做本人能做的事时，直接调用对应动作，不说做不到，也不让本人自己去点。动作做成后照返回的 summary 用一句话告诉本人做了什么；undoable=true 时可以顺带说能撤销。没有成功返回，不说已经做了。
每一轮都要短：先用一句话回应本人，再去做。写代码、长调研这类要花时间的活，用 split_cards 或 start_sub_session 交给项目和子会话去做，不在一轮里自己长时间做；本人插话时，已经派出去的活照常跑。
要做两步以上的事时，先用 update_plan 交一张完整清单，每做完一步再交一次整张清单（做完的标 completed，正在做的标 in_progress）；聊天和只做一步的事不交清单。
用 send_message 给同事发消息时，天枢会先出一张卡让本人确认，本人点「发出」才发；回答里说已经起好、请本人看一眼再发，不说已经发出。
本人没有授权时，动作里只有读和打开页面，只能帮本人看和打开；动作返回 BUDDY_NOT_AUTHORIZED、DAILY_LIMIT 或其他错误时，按返回的错误说明照实告诉本人没做成和原因，不换别的动作绕过。动作没有返回结果（如 NETWORK_ERROR、TOOL_FAILED）时，说这一步结果还没确认，请本人到天枢看一眼，不说做成也不说没做成，不重复调用同一个写动作。`;

const TIANSHU = "3b8f6a52-6d1e-4c1a-9a7e-2f4d1c0b7a11";
const CHAT = "9c2d4e71-0b3a-4f5e-8d6c-1a2b3c4d5e60";
const SCRATCH = "5e7a1c90-2d4b-4e8f-a1b2-c3d4e5f60718";
const RUNNING_TOPIC = "7d1e2f30-4a5b-4c6d-9e8f-0a1b2c3d4e5f";

const PROJECTS = [
  { projectId: TIANSHU, name: "天枢新版",
    goals: [{ taskId: "task-home-redesign", name: "首页改版", dueDate: "2026-11-28", criteria: ["新首页只放「等你」", "全页一种字号"], criteriaMet: 1, criteriaTotal: 2 }],
    subSessions: [{ kind: "topic", id: RUNNING_TOPIC, letter: "A", title: "首页改版", state: "running", waiting: null }],
    feed: [{ at: "2026-11-18T01:20:00Z", kind: "report", text: "「首页改版」做完一轮：首页只留「等你」，字号统一成一种；下一步把本月页挪出去。" }] },
  { projectId: CHAT, name: "Chat 服务",
    goals: [{ taskId: "task-answer-quality", name: "答复质量", dueDate: "2026-11-30", criteria: ["寒暄 2 秒内回", "Chat 验收 75 分以上"], criteriaMet: 0, criteriaTotal: 2 }],
    subSessions: [], feed: [] },
  { projectId: SCRATCH, name: "随手", scratch: true, goals: [], subSessions: [], feed: [] },
];

const HOME = {
  period: "2026-11",
  projects: PROJECTS.map(({ feed: _feed, ...project }) => ({ ...project, pipeline: { conversationId: null, scope: `project:${project.projectId}` }, unseen: false })),
  archivedCount: 0,
  month: { missions: [] },
  other: { subSessions: [], items: [] },
  waiting: [],
};

type Args = Record<string, unknown>;
const fake = (name: string, args: Args): unknown => {
  if (name === "read_work_home") return { summary: "读了首页", result: HOME };
  if (name === "read_project") {
    const project = PROJECTS.find((entry) => entry.projectId === args.projectId);
    if (!project) return { error: { code: "NOT_FOUND", message: "找不到这个项目" } };
    const { feed, subSessions, ...rest } = project;
    return { summary: "读了这个项目", result: { project: rest, feed: { items: feed }, subSessions } };
  }
  if (name === "web_search") return { results: [{ title: "示例来源：相关公开报道", url: "https://example.com/news/1", snippet: "（评测用的假结果）这里是一条和检索词有关的摘要。" }] };
  if (name === "find_people") return { summary: "人员目录里没有这个名字", result: { people: [] } };
  if (name === "read_partner_inbox") return { summary: "读了本人的伙伴收件记录", result: { items: [], total: 0, nextOffset: null } };
  return { summary: "好了" };
};

const SPECS = actionList({ authority: "full", grantedAt: null }, false);
const WRITES = new Set(SPECS.filter((spec) => spec.kind === "write").map((spec) => spec.name as string));
const TOOLS = [
  ...SPECS.map((spec) => ({ type: "function", name: spec.name, description: spec.description, parameters: spec.parameters, strict: false })),
  { type: "function", name: "web_search", description: "检索公开来源，返回来源标题、URL 与摘要。", strict: false,
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false } },
];

const CONTRACT_A = "合同甲：乙方于 2026 年 12 月 31 日前交付全部软件，验收合格后 30 日内付清尾款 30%；逾期每日按合同额千分之一计违约金；争议提交上海仲裁委员会。";
const CONTRACT_B = "合同乙：乙方于 2027 年 1 月 15 日前交付全部软件，验收合格后 60 日内付清尾款 20%；逾期每日按合同额万分之五计违约金，上限 10%；争议由甲方所在地法院管辖。";

/** 第一步落在哪：none 是没调写动作也没问（自己做）；别的是第一次调的写动作或 ask_user 的名字。 */
type First = { name: string; args: Args } | null;
type Case = { id: number; message: string; expect: string; self: boolean; pass: (first: First) => boolean };
const CASES: Case[] = [
  { id: 1, message: "查一下 ANT 适不适合打新", expect: "不调写动作", self: true, pass: (first) => first === null },
  { id: 2, message: "把大陆首发玩 GTA 6 的路线查清楚，出一份方案", expect: "不调写动作，或 ask_user", self: false,
    pass: (first) => first === null || first.name === "ask_user" },
  { id: 3, message: "帮我写封邮件回绝这家供应商", expect: "不调写动作", self: true, pass: (first) => first === null },
  { id: 4, message: `比对这两份合同\n\n${CONTRACT_A}\n\n${CONTRACT_B}`, expect: "不调写动作", self: true, pass: (first) => first === null },
  { id: 5, message: "比对桌面「合同」文件夹里那十几份", expect: "open_session 带 scratch", self: false,
    pass: (first) => first?.name === "open_session" && first.args.scratch === true && !first.args.projectId },
  { id: 6, message: "改一下 Chat 服务里流式断掉不重试的 bug", expect: "open_session 带「Chat 服务」的 projectId", self: false,
    pass: (first) => first?.name === "open_session" && first.args.projectId === CHAT && !first.args.scratch },
  { id: 7, message: "做一版登录页设计稿", expect: "open_session 带「天枢新版」的 projectId，或 ask_user", self: false,
    pass: (first) => (first?.name === "open_session" && first.args.projectId === TIANSHU && !first.args.scratch) || first?.name === "ask_user" },
  { id: 8, message: "天枢新版进度怎么样", expect: "不调写动作", self: true, pass: (first) => first === null },
  { id: 9, message: "让首页改版那个会话把按钮改成蓝的", expect: "message_project 带「天枢新版」的 projectId", self: false,
    pass: (first) => first?.name === "message_project" && first.args.projectId === TIANSHU },
];
const MAX_TOOL_ROUNDS = 4;

const env = (key: string) => {
  const value = process.env[key];
  if (!value) throw new Error(`缺少 ${key}`);
  return value;
};

type Item = { type?: string; name?: string; arguments?: string; call_id?: string; content?: { type: string; text?: string }[] };
async function respond(model: string, instructions: string, input: unknown[]): Promise<Item[]> {
  const response = await fetch(env("PI_BASE_URL"), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env("PI_API_KEY")}` },
    body: JSON.stringify({ model, instructions, input, tools: TOOLS, stream: false }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!response.ok) throw new Error(`模型请求失败 HTTP ${response.status}`);
  return ((await response.json()) as { output?: Item[] }).output ?? [];
}
const textOf = (output: Item[]) => output.flatMap((item) => item.content ?? []).filter((part) => part.type === "output_text").map((part) => part.text ?? "").join("").trim();
const parse = (raw: string | undefined): Args => { try { return JSON.parse(raw ?? "{}") as Args; } catch { return { _raw: raw }; } };

/** 跑一句：读的动作回假结果接着问，第一次调写动作或 ask_user 就停。 */
async function run(model: string, instructions: string, message: string) {
  const input: unknown[] = [{ role: "user", content: JSON.stringify({ anchor: null, currentObject: null, references: [], message }) }];
  const trace: { name: string; args: Args }[] = [];
  for (let round = 0; ; round++) {
    const output = await respond(model, instructions, input);
    const calls = output.filter((item) => item.type === "function_call");
    for (const call of calls) trace.push({ name: call.name!, args: parse(call.arguments) });
    const stop = calls.find((call) => WRITES.has(call.name!) || call.name === "ask_user");
    if (stop) return { first: { name: stop.name!, args: parse(stop.arguments) } as First, trace, text: textOf(output), exhausted: false };
    if (!calls.length) return { first: null as First, trace, text: textOf(output), exhausted: false };
    if (round === MAX_TOOL_ROUNDS) return { first: null as First, trace, text: textOf(output), exhausted: true };
    for (const call of calls) {
      input.push({ type: "function_call", call_id: call.call_id, name: call.name, arguments: call.arguments ?? "{}" });
      input.push({ type: "function_call_output", call_id: call.call_id, output: JSON.stringify(fake(call.name!, parse(call.arguments))) });
    }
  }
}

async function main() {
  const outIndex = process.argv.indexOf("--out");
  const out = outIndex > 0 ? resolve(process.argv[outIndex + 1]) : join(tmpdir(), `buddy-dispatch-eval-${Date.now()}.json`);
  const model = env("HEAVY_MODEL");
  const instructions = `${driSystemPrompt(OWNER)}\n\n${BUDDY_ACTION_RULES}`;
  const results: unknown[] = [];
  let right = 0;
  const selfWrites: number[] = [];
  for (const item of CASES) {
    const result = await run(model, instructions, item.message);
    const ok = item.pass(result.first);
    right += ok ? 1 : 0;
    if (item.self && result.first && WRITES.has(result.first.name)) selfWrites.push(item.id);
    const took = result.first ? `${result.first.name} ${JSON.stringify(result.first.args)}` : `没调写动作${result.exhausted ? `（${MAX_TOOL_ROUNDS} 轮工具来回用完）` : ""}`;
    console.log(`\n${item.id}「${item.message.split("\n")[0]}」 ${ok ? "对" : "错"}`);
    console.log(`  算对：${item.expect}`);
    console.log(`  实际：${took}`);
    console.log(`  调过：${result.trace.map((call) => call.name).join(" → ") || "无"}`);
    if (result.text) console.log(`  回话：${result.text.replace(/\n+/g, " ").slice(0, 200)}`);
    results.push({ ...item, ok, ...result });
  }
  const failed = right < 7 || selfWrites.length > 0;
  writeFileSync(out, JSON.stringify({ model, right, total: CASES.length, selfWrites, results }, null, 2));
  console.log(`\n${right}/${CASES.length} 句判对${selfWrites.length ? `；「自己做」的第 ${selfWrites.join("、")} 句调了写动作` : ""}；结果在 ${out}`);
  process.exitCode = failed ? 1 : 0;
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
