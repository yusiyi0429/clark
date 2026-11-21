/**
 * 伙伴主线的端到端离线评测：`pnpm --filter @warmap/api exec tsx --env-file=<env 文件> scripts/buddy-dispatch-eval.ts [--runs N] [--out 结果.json] [--baseline 上次的结果.json] [--model 模型名|fake] [--regrade 已存的结果.json]`
 *
 * - 真模型读 PI_BASE_URL / PI_API_KEY / HEAVY_MODEL（--model 可另指模型名），**不打印、不写出任何密钥值和地址**（调模型出错只记固定文案和 HTTP 状态）。
 *   不开会话、不写库、不碰 3700 的数据：工具全是脚本里的假实现。
 *   `--model fake` 不连模型：按每条用例预设的工具调用和回话走一遍，用来证明流程和判定是通的。
 *   `--regrade <结果.json>` 不调模型：读那份结果里每条每遍的工具轨迹和回话，用现在的判定重判，写出同样格式的 JSON（遍数、模型名照原结果，
 *   commit 是现在判定代码的提交，另带 regradedFrom）；--out、--baseline 照常用，--runs、--model 不看。
 * - 工具 = actionList（完全授权、伙伴主线）的名字、说明、参数原样，加一个假的 web_search。
 * - 系统提示 = driSystemPrompt（同 scripts/buddy-persona-eval.ts 的取法）+ Chat 那段「# 代本人在天枢里做事」（下面 BUDDY_ACTION_RULES，照抄的）。
 * - 13 句本人的话（用例和判定在 scripts/buddy-dispatch-judge.ts，测试 test/buddyDispatchJudge.test.ts），每句跑 --runs 遍（缺省 2），每遍单独判：
 *   模型一直调工具，直到给出最后回话或 8 轮工具来回用完。读的动作回写死的假首页和项目（形状照 read_work_home / read_project 的真实返回，
 *   启动时按契约校验）；写动作回成功，summary 照 api 的口径；照 api 原文回 409 的只有两处：对从没开过工的「登录页」卡 tell_session（NOT_STARTED），
 *   对在跑或停着等下一句的会话 start_sub_session（ALREADY_RUNNING）。第 7、8、9 条的「不能出现」只算做成了的调用，撞了 409 再改对算过。
 *   参数不合契约（INVALID_ARGS）、id 对不上（NOT_FOUND）也照 api 回错，这是模型自己调错了。
 * - 假首页：「天枢新版」挂 Task「首页改版」，子会话有在跑的「首页改版」（A）、出错停下的「清点 md 文件」（B）和「写 hello.py」（C）、从没开过工的卡「登录页」（D）；
 *   「Chat 服务」挂 Task「答复质量」；「随手」带 scratch。
 * - 结果写 stdout，全部写到 --out（缺省写到系统临时目录）：时间、模型名、git 提交、每条每遍的过没过、原因、调过的工具和参数、回话，各条通过遍数。
 *   带 --baseline 时按用例号打印翻转（上次每遍都过、这次有没过的；上次有没过的、这次每遍都过的）。任何一条任何一遍没过，退出码 1。
 *
 * 局限：系统提示是照抄的近似，不是 Chat 真跑时的全部（Chat 自己的角色提示、伙伴人设、记忆、历史都不在这里）；
 * 回话规矩（省略号、许诺以后回报、没做成说已经）按字面判，见 judge 文件里的说明。
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  BuddyActionParams, ProjectDetailResponse, ProjectFeedResponse, WorkHomeResponse,
  type THomeProject, type TProjectDetailResponse, type TProjectFeedItem, type TSubSession, type TWorkHomeResponse,
} from "@warmap/contracts";
import { actionList } from "../src/buddyActions.js";
import { driSystemPrompt } from "../src/piConversationRuntime.js";
import { CASES, IDS, flips, judge, type Attempt, type CaseTally, type ToolCall } from "./buddy-dispatch-judge.js";

const OWNER = "孙铭泽";

/**
 * 照抄自晨星的 Chat 仓库 csl-actions `src/prompt.ts:66-72`（BUDDY_ACTION_RULES，2026-11-18 抄，11-19 对过没变），只作评测用；
 * Chat 那边改了这里不会跟着变，跑之前对一眼。
 */
const BUDDY_ACTION_RULES = `# 代本人在天枢里做事

工具里来自天枢的动作（读首页和项目、打开页面、改外观和推送、开工或停掉子会话、建项目和转交、发消息等）由天枢按本人自己的权限执行，不受上面只读限制的约束。本人要你在天枢里做本人能做的事时，直接调用对应动作，不说做不到，也不让本人自己去点。动作做成后照返回的 summary 用一句话告诉本人做了什么；undoable=true 时可以顺带说能撤销。没有成功返回，不说已经做了。
每一轮都要短：先用一句话回应本人，再去做。写代码、长调研这类要花时间的活，用 split_cards 或 start_sub_session 交给项目和子会话去做，不在一轮里自己长时间做；本人插话时，已经派出去的活照常跑。
要做两步以上的事时，先用 update_plan 交一张完整清单，每做完一步再交一次整张清单（做完的标 completed，正在做的标 in_progress）；聊天和只做一步的事不交清单。
用 send_message 给同事发消息时，天枢会先出一张卡让本人确认，本人点「发出」才发；回答里说已经起好、请本人看一眼再发，不说已经发出。
本人没有授权时，动作里只有读和打开页面，只能帮本人看和打开；动作返回 BUDDY_NOT_AUTHORIZED、DAILY_LIMIT 或其他错误时，按返回的错误说明照实告诉本人没做成和原因，不换别的动作绕过。动作没有返回结果（如 NETWORK_ERROR、TOOL_FAILED）时，说这一步结果还没确认，请本人到天枢看一眼，不说做成也不说没做成，不重复调用同一个写动作。`;

// ───────────────────────── 假首页 ─────────────────────────

const PERIOD = "2026-11";
const DEVICE = "1f2e3d4c-5b6a-4789-a0b1-c2d3e4f5a6b7";
const at = (time: string) => `2026-11-19T${time}:00.000Z`;
const subSession = (fields: Pick<TSubSession, "id" | "kind" | "letter" | "title" | "state" | "updatedAt"> & Partial<TSubSession>): TSubSession =>
  ({ unseen: false, waiting: null, queueReason: null, role: null, sessionId: null, deviceId: null, autoStart: false, merge: null, holdUntil: null, ...fields });
const TIANSHU_SUBS: TSubSession[] = [
  subSession({ id: IDS.topicA, kind: "topic", letter: "A", title: "首页改版", state: "running", updatedAt: at("06:40"),
    sessionId: "a1b2c3d4-0001-4aaa-8bbb-000000000001", deviceId: DEVICE }),
  // 出错停下：本机会话 idle，最后一轮报的 stopped 是 error（首页上是 waiting、waiting=null、stopWhy=error，同 workHome.ts）。
  subSession({ id: IDS.topicB, kind: "topic", letter: "B", title: "清点 md 文件", state: "waiting", unseen: true, stopWhy: "error", updatedAt: at("05:10"),
    sessionId: "a1b2c3d4-0002-4aaa-8bbb-000000000002", deviceId: DEVICE }),
  subSession({ id: IDS.topicC, kind: "topic", letter: "C", title: "写 hello.py", state: "waiting", unseen: true, stopWhy: "error", updatedAt: at("05:30"),
    sessionId: "a1b2c3d4-0003-4aaa-8bbb-000000000003", deviceId: DEVICE }),
  // 从没开过工的卡：没有本机执行，state=queued、queueReason=not_dispatched。
  subSession({ id: IDS.loginCard, kind: "card", letter: "D", title: "登录页", state: "queued", queueReason: "not_dispatched", updatedAt: at("02:00") }),
];
const summary = (subs: TSubSession[]) => ({ running: subs.filter((sub) => sub.state === "running").length,
  waiting: subs.filter((sub) => sub.state === "waiting" || sub.state === "failed").length, queued: subs.filter((sub) => sub.state === "queued").length,
  done: subs.filter((sub) => sub.state === "done").length, doneToday: 0, needsYou: 0 });
const goal = (taskId: string, missionId: string, name: string, dueDate: string, criteria: string[], criteriaMet: number) =>
  ({ taskId, missionId, name, period: PERIOD, dueDate, dueDateSource: "mission" as const, criteria, criteriaMet, criteriaTotal: criteria.length, completedAt: null, responsible: null });
const homeProject = (projectId: string, name: string, goals: THomeProject["goals"], subs: TSubSession[], scratch?: true): THomeProject =>
  ({ projectId, name, goals, budget: null, lastActivityAt: subs[0]?.updatedAt ?? at("01:00"), summary: summary(subs),
    pipeline: { conversationId: null, scope: `project:${projectId}` }, planning: false, subSessions: subs, items: [], transfer: null, unseen: false, ...(scratch ? { scratch } : {}) });

const PROJECTS: THomeProject[] = [
  homeProject(IDS.tianshu, "天枢新版", [goal(IDS.homeTask, "mission-new-home", "首页改版", "2026-11-28", ["新首页只放「等你」", "全页一种字号"], 1)], TIANSHU_SUBS),
  homeProject(IDS.chat, "Chat 服务", [goal(IDS.qualityTask, "mission-chat-quality", "答复质量", "2026-11-30", ["寒暄 2 秒内回", "Chat 验收 75 分以上"], 0)], []),
  homeProject(IDS.scratch, "随手", [], [], true),
];
const HOME: TWorkHomeResponse = { period: PERIOD, projects: PROJECTS, archivedCount: 0, month: { missions: [] }, other: { subSessions: [], items: [] }, waiting: [] };

const report = (id: string, sub: TSubSession, time: string, why: "turn_done" | "error", text: string | null, blocker: string | null): TProjectFeedItem =>
  ({ kind: "sub_session_report", id, at: at(time), afterSequence: null, sub: { kind: sub.kind, id: sub.id, letter: sub.letter!, title: sub.title },
    why, summary: text, blocker, outputs: [] });
const FEEDS: Record<string, TProjectFeedItem[]> = {
  [IDS.tianshu]: [
    report("b0c1d2e3-0001-4f00-8a00-000000000001", TIANSHU_SUBS[0]!, "01:20", "turn_done", "首页只留「等你」，字号统一成一种；下一步把本月页挪出去。", null),
    report("b0c1d2e3-0002-4f00-8a00-000000000002", TIANSHU_SUBS[1]!, "05:10", "error", null, "本机会话出错退出：读目录时权限不够，这一轮没做完。"),
    report("b0c1d2e3-0003-4f00-8a00-000000000003", TIANSHU_SUBS[2]!, "05:30", "error", null, "本机会话出错退出：模型接口返回 500，这一轮没做完。"),
  ],
};
/** read_project 的真实返回：GET /api/me/projects/:id 的详情，加 feed 和首页上的 subSessions（buddyActions.ts 的 read_project）。 */
const detail = (project: THomeProject): TProjectDetailResponse => ({
  project: { projectId: project.projectId, name: project.name, archivedAt: null, createdAt: "2026-11-01T01:00:00.000Z", lastActivityAt: project.lastActivityAt,
    transfer: null, permissionMode: "auto", autoRelayLimit: 20, ...(project.scratch ? { scratch: true as const } : {}) },
  period: PERIOD,
  goals: project.goals.map((entry) => ({ taskId: entry.taskId, taskName: entry.name, missionId: entry.missionId, missionTitle: null, period: entry.period,
    verdict: "open" as const, source: "owner" as const, linkedAt: "2026-11-02T01:00:00.000Z", dueDate: null })),
});

/** 假数据先按契约校验一遍，免得编出真接口里没有的字段。 */
function checkFakes() {
  if (!FormatRegistry.Has("date-time")) FormatRegistry.Set("date-time", (value) => !Number.isNaN(Date.parse(value)));
  const check = (what: string, schema: Parameters<typeof Value.Check>[0], value: unknown) => {
    const first = Value.Errors(schema, value).First();
    if (first) throw new Error(`假数据 ${what} 不合契约：${first.path} ${first.message}`);
  };
  check("read_work_home", WorkHomeResponse, HOME);
  for (const project of PROJECTS) {
    check(`项目「${project.name}」详情`, ProjectDetailResponse, detail(project));
    check(`项目「${project.name}」动态`, ProjectFeedResponse, { items: FEEDS[project.projectId] ?? [] });
  }
}

// ───────────────────────── 假工具 ─────────────────────────

type Args = Record<string, unknown>;
type ToolReply = { ok: true; output: unknown } | { ok: false; code: string; message: string };
const SPECS = actionList({ authority: "full", grantedAt: null }, false);
const WRITES = new Set(SPECS.filter((spec) => spec.kind === "write").map((spec) => spec.name as string));
const TOOLS = [
  ...SPECS.map((spec) => ({ type: "function", name: spec.name, description: spec.description, parameters: spec.parameters, strict: false })),
  { type: "function", name: "web_search", description: "检索公开来源，返回来源标题、URL 与摘要。", strict: false,
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false } },
];
const LATER = "（本人电脑上开着天枢网页时马上交给它）";

const fail = (code: string, message: string): ToolReply => ({ ok: false, code, message });
/** 成功照 runAction 的返回：summary、result、auditId（写动作才有）、undoable。 */
const ok = (name: string, summaryText: string, result: unknown = null, undoable = false): ToolReply =>
  ({ ok: true, output: { summary: summaryText, result, auditId: WRITES.has(name) ? randomUUID() : null, undoable } });
const projectOf = (projectId: unknown) => PROJECTS.find((project) => project.projectId === projectId);
const subOf = (args: Args) => PROJECTS.flatMap((project) => project.subSessions).find((sub) => sub.kind === args.kind && sub.id === args.id);

/** 假工具：参数先按契约查（同 runAction），再照 buddyActions.ts 各动作的口径回。 */
function tool(name: string, args: Args): ToolReply {
  if (name === "web_search") return { ok: true, output: { results: [{ title: "示例来源：相关公开报道", url: "https://example.com/news/1", snippet: "（评测用的假结果）这里是一条和检索词有关的摘要。" }] } };
  const schema = (BuddyActionParams as Record<string, Parameters<typeof Value.Check>[0]>)[name];
  if (!schema || !SPECS.some((spec) => spec.name === name)) return fail("UNKNOWN_ACTION", `没有 ${name} 这个动作`);
  const first = Value.Errors(schema, args).First();
  if (first) return fail("INVALID_ARGS", `参数不对：${first.path || "/"} ${first.message}`);
  switch (name) {
    case "read_work_home": return ok(name, "读了首页", HOME);
    case "read_project": {
      const project = projectOf(args.projectId);
      if (!project) return fail("NOT_FOUND", "找不到这个项目");
      return ok(name, "读了这个项目", { ...detail(project), feed: { items: FEEDS[project.projectId] ?? [] }, subSessions: project.subSessions });
    }
    case "find_people": return ok(name, "人员目录里没有这个名字", { people: [] });
    case "read_partner_inbox": return ok(name, "读了本人的伙伴收件记录", { items: [], total: 0, nextOffset: null });
    case "open_page": return ok(name, "打开了");
    case "update_plan": return ok(name, (args.entries as unknown[]).length < 2 ? "少于两步，不出清单" : "清单更新了");
    case "ask_user": return ok(name, "选项框出给本人了。这一轮到这里结束，等本人回答（下一条消息）；本人先聊别的就照新的话办。", { questionId: randomUUID() });
    case "tell_session": {
      const sub = subOf(args);
      if (!sub) return fail("NOT_FOUND", "没有这个子会话");
      if (!sub.sessionId) return fail("NOT_STARTED", `「${sub.title}」还没开过工，先用 start_sub_session 开工`);
      return ok(name, `把话转给了「${sub.title}」${LATER}`, { kind: sub.kind, id: sub.id, title: sub.title, commandId: randomUUID() });
    }
    case "start_sub_session": {
      const sub = subOf(args);
      if (!sub) return fail("NOT_FOUND", "没有这个子会话");
      // 开过工的：在跑的、停着等下一句的（本机 run 是 idle），同 buddyActions.ts 在伙伴主线里的原文。
      if (sub.state === "running") return fail("ALREADY_RUNNING", `「${sub.title}」已经在跑了`);
      if (sub.sessionId) return fail("ALREADY_RUNNING", `「${sub.title}」停着等下一句，用 tell_session 对它说一句就能续上。`);
      return ok(name, `让「${sub.title}」开工了，本人电脑上开着的网页接下后就开始`, null, true);
    }
    case "message_project": {
      const project = projectOf(args.projectId);
      if (!project) return fail("NOT_FOUND", "找不到这个项目");
      const now = new Date().toISOString();
      return ok(name, `已把这条要求排进项目「${project.name}」的对话`, { id: randomUUID(), scope: `project:${project.projectId}`, message: `【伙伴转来】${args.text as string}`,
        createdAt: now, updatedAt: now, state: "queued", priority: false, error: null });
    }
    case "open_session": {
      if (Boolean(args.projectId) === Boolean(args.scratch)) return fail("INVALID_ARGS", "projectId 和 scratch 带且只带一个");
      const title = (args.title as string).trim();
      if (!title) return fail("INVALID_ARGS", "title 不能全是空白");
      const project = args.scratch ? projectOf(IDS.scratch) : projectOf(args.projectId);
      if (!project) return fail("NOT_FOUND", "找不到这个项目");
      return ok(name, `${args.scratch ? "开了会话" : `在项目「${project.name}」里开了`}「${title}」，本人电脑上开着的网页接下后就开始`,
        { dispatchId: randomUUID(), projectId: project.projectId, projectName: project.name, kind: "topic", id: randomUUID(), title });
    }
    case "set_task_due_date": {
      const project = projectOf(args.projectId);
      if (!project) return fail("NOT_FOUND", "找不到这个项目");
      const target = project.goals.find((entry) => entry.taskId === args.taskId);
      if (!target) return fail("NOT_FOUND", "这件 Task 没挂在这个项目上");
      return ok(name, args.dueDate ? `把「${target.name}」的验收截止日定成 ${args.dueDate as string}` : `「${target.name}」不再单独存截止日，按 Mission 的节点算`, null, true);
    }
    default: return ok(name, "好了");
  }
}

// ───────────────────────── 模型 ─────────────────────────

type Item = { type?: string; name?: string; arguments?: string; call_id?: string; content?: { type: string; text?: string }[] };
type Respond = (input: unknown[]) => Promise<Item[]>;
const MAX_TOOL_ROUNDS = 8;

const env = (key: string) => {
  const value = process.env[key];
  if (!value) throw new Error(`缺少 ${key}`);
  return value;
};
/** 调模型出错：只留固定文案和 HTTP 状态，不带原始报错（里面可能有地址）。 */
class ModelFailure extends Error {}
const realModel = (model: string, instructions: string): Respond => {
  const url = env("PI_BASE_URL");
  const key = env("PI_API_KEY");
  return async (input) => {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, instructions, input, tools: TOOLS, stream: false }),
        signal: AbortSignal.timeout(180_000),
      });
    } catch (error) {
      throw new ModelFailure(error instanceof Error && error.name === "TimeoutError" ? "模型请求超时" : "模型请求没连上");
    }
    if (!response.ok) throw new ModelFailure(`模型请求失败 HTTP ${response.status}`);
    try { return ((await response.json()) as { output?: Item[] }).output ?? []; } catch { throw new ModelFailure("模型的回复没读完整"); }
  };
};

/** --model fake：每条预设的几步（一步是同一轮里的几个工具调用，或最后回话），按次序吐出，回话照假工具的 summary 写。 */
type Step = { calls: [string, Args][] } | { reply: string };
const HOME_READ: Step = { calls: [["read_work_home", {}]] };
const FAKE_STEPS: Record<number, Step[]> = {
  1: [{ calls: [["web_search", { query: "ANT 打新" }]] }, { reply: "按查到的公开信息看，ANT 这次估值偏高、首日波动会比较大，想参与的话小额申购更稳妥（评测用的假回答）。" }],
  2: [{ reply: "可以这样写：\n\n您好，感谢贵司这段时间的报价和配合。经过内部评估，我们这次决定不继续推进合作，希望以后还有机会。祝好。" }],
  3: [{ reply: "两份主要差在三处：交付期乙晚两周；尾款甲是 30 日内付 30%，乙是 60 日内付 20%；违约金甲每日千分之一不封顶，乙每日万分之五、上限 10%，争议解决也不同。" }],
  4: [HOME_READ, { calls: [["open_session", { scratch: true, title: "比对合同文件夹", brief: "比对桌面「合同」文件夹里那十几份合同，列出彼此的差异。" }]] },
    { reply: "开了会话「比对合同文件夹」去看，本人电脑上开着的网页接下后就开始。" }],
  5: [HOME_READ, { calls: [["open_session", { projectId: IDS.chat, title: "修流式断开不重试", brief: "改一下 Chat 服务里流式断掉不重试的 bug。" }]] },
    { reply: "在项目「Chat 服务」里开了「修流式断开不重试」，本人电脑上开着的网页接下后就开始。" }],
  6: [HOME_READ, { calls: [["read_project", { projectId: IDS.tianshu }]] },
    { reply: "天枢新版：「首页改版」在跑，上一轮把首页改成只留「等你」、字号统一成一种，验收标准达到 1/2；「清点 md 文件」和「写 hello.py」都出错停下了；「登录页」还没开工。" }],
  7: [HOME_READ, { calls: [["tell_session", { kind: "topic", id: IDS.topicA, text: "把按钮改成蓝的" }]] }, { reply: `把话转给了「首页改版」${LATER}。` }],
  8: [HOME_READ, { calls: [["start_sub_session", { kind: "topic", id: IDS.topicB }], ["start_sub_session", { kind: "topic", id: IDS.topicC }]] }, { calls: [["tell_session", { kind: "topic", id: IDS.topicB, text: "再跑一次" }], ["tell_session", { kind: "topic", id: IDS.topicC, text: "再跑一次" }]] },
    { reply: `让「清点 md 文件」和「写 hello.py」各再跑一次，话都转过去了${LATER}。` }],
  9: [HOME_READ, { calls: [["message_project", { projectId: IDS.tianshu, text: "首页改版的完成标准加一条「手机上也要能用」" }]] },
    { reply: "已把这条要求排进项目「天枢新版」的对话，由它去改「首页改版」的约定。" }],
  10: [HOME_READ, { calls: [["set_task_due_date", { projectId: IDS.tianshu, taskId: IDS.homeTask, dueDate: "2026-11-25" }]] },
    { reply: "把「首页改版」的验收截止日定成 2026-11-25，能撤销。" }],
  11: [HOME_READ, { calls: [["open_session", { projectId: IDS.tianshu, title: "做登录页设计稿", brief: "做一版登录页设计稿。" }]] },
    { reply: "在项目「天枢新版」里开了「做登录页设计稿」，本人电脑上开着的网页接下后就开始。" }],
  12: [{ reply: "这件事牵涉的面比较广，我先给个短版：首发版本、账号区服和合规渠道是三件要先查清的事（评测用的假回答）。要不要开个会话做完整的方案？" }],
  13: [HOME_READ, { calls: [["tell_session", { kind: "card", id: IDS.loginCard, text: "接着做" }]] }, { calls: [["start_sub_session", { kind: "card", id: IDS.loginCard }]] },
    { reply: "「登录页」还没开过工，改成让它开工了，本人电脑上开着的网页接下后就开始。" }],
};
const fakeModel = (caseId: number): Respond => {
  const steps = [...FAKE_STEPS[caseId]!];
  return async () => {
    const step = steps.shift() ?? { reply: "" };
    if ("reply" in step) return [{ type: "message", content: [{ type: "output_text", text: step.reply }] }];
    return step.calls.map(([name, args]) => ({ type: "function_call", name, arguments: JSON.stringify(args), call_id: randomUUID() }));
  };
};

const textOf = (output: Item[]) => output.flatMap((item) => item.content ?? []).filter((part) => part.type === "output_text").map((part) => part.text ?? "").join("").trim();
const parse = (raw: string | undefined): Args => { try { return JSON.parse(raw ?? "{}") as Args; } catch { return { _raw: raw }; } };

/** 跑一遍：工具回假结果接着问，直到模型不再调工具（最后回话）或 8 轮工具来回用完。回话是这一遍模型说过的全部文字。 */
async function run(respond: Respond, message: string): Promise<Attempt & { error?: string }> {
  const input: unknown[] = [{ role: "user", content: JSON.stringify({ anchor: null, currentObject: null, references: [], message }) }];
  const calls: ToolCall[] = [];
  const texts: string[] = [];
  const reply = () => texts.filter(Boolean).join("\n");
  for (let round = 0; ; round++) {
    let output: Item[];
    try { output = await respond(input); } catch (error) {
      return { calls, reply: reply(), stop: "error", error: error instanceof ModelFailure ? error.message : "模型请求失败" };
    }
    texts.push(textOf(output));
    const pending = output.filter((item) => item.type === "function_call");
    if (!pending.length) return { calls, reply: reply(), stop: "reply" };
    if (round === MAX_TOOL_ROUNDS) return { calls, reply: reply(), stop: "rounds" };
    for (const call of pending) {
      const args = parse(call.arguments);
      const result = tool(call.name!, args);
      calls.push({ name: call.name!, args, write: WRITES.has(call.name!), ok: result.ok, code: result.ok ? null : result.code });
      input.push({ type: "function_call", call_id: call.call_id, name: call.name, arguments: call.arguments ?? "{}" });
      input.push({ type: "function_call_output", call_id: call.call_id, output: JSON.stringify(result.ok ? result.output : { error: { code: result.code, message: result.message } }) });
    }
  }
}

// ───────────────────────── 主流程 ─────────────────────────

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} 后面要跟值`);
  return value;
}

function commit(): string | null {
  try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dirname(fileURLToPath(import.meta.url)), encoding: "utf8" }).trim(); } catch { return null; }
}

function readBaseline(path: string): CaseTally[] {
  const data = JSON.parse(readFileSync(path, "utf8")) as { cases?: { id: number; passed: number; runs: unknown[] }[] };
  if (!Array.isArray(data.cases)) throw new Error("--baseline 不是这个脚本写出来的结果（没有 cases）");
  return data.cases.map((entry) => ({ id: entry.id, passed: entry.passed, runs: entry.runs.length }));
}

type Graded = Attempt & { error?: string };
const FIXED_ERRORS = new Set(["模型请求没连上", "模型请求超时", "模型的回复没读完整", "模型请求失败"]);
/** 旧结果里的 error 按现在的口径清成固定文案：HTTP 状态照留，超时写超时，别的（可能带地址的原始报错）一律「模型请求失败」。 */
const cleanError = (raw: string) => FIXED_ERRORS.has(raw) || /^模型请求失败 HTTP \d{3}$/.test(raw) ? raw : /timeout|timed out|超时/i.test(raw) ? "模型请求超时" : "模型请求失败";
/** --regrade：读已存的结果，取每条每遍的工具轨迹、回话和结束方式，不调模型。 */
function readSaved(path: string): { model: string; runs: number; attempt: (id: number, index: number) => Graded } {
  const data = JSON.parse(readFileSync(path, "utf8")) as { model?: string; runs?: number; cases?: { id: number; runs: Graded[] }[] };
  if (typeof data.model !== "string" || !Number.isInteger(data.runs) || !Array.isArray(data.cases)) throw new Error("--regrade 不是这个脚本写出来的结果");
  return { model: data.model, runs: data.runs!, attempt: (id, index) => {
    const saved = data.cases!.find((entry) => entry.id === id)?.runs[index - 1];
    if (!saved) throw new Error(`--regrade 的结果里没有第 ${id} 条第 ${index} 遍`);
    return { calls: saved.calls, reply: saved.reply, stop: saved.stop, ...(saved.error ? { error: cleanError(saved.error) } : {}) };
  } };
}

async function main() {
  const regradePath = option("--regrade");
  const saved = regradePath ? readSaved(resolve(regradePath)) : null;
  const runs = saved?.runs ?? Number(option("--runs") ?? 2);
  if (!Number.isInteger(runs) || runs < 1) throw new Error("--runs 要是正整数");
  const outArg = option("--out");
  const out = outArg ? resolve(outArg) : join(tmpdir(), `buddy-dispatch-eval-${Date.now()}.json`);
  const baselinePath = option("--baseline");
  const baseline = baselinePath ? readBaseline(resolve(baselinePath)) : null;
  const model = saved?.model ?? option("--model") ?? env("HEAVY_MODEL");
  checkFakes();
  const real = saved || model === "fake" ? null : realModel(model, `${driSystemPrompt(OWNER)}\n\n${BUDDY_ACTION_RULES}`);
  const short = (args: Args) => ["kind", "id", "projectId", "scratch", "taskId", "dueDate"].filter((key) => key in args).map((key) => `${key}=${String(args[key])}`).join(" ");

  const cases = [];
  for (const item of CASES) {
    const attempts = [];
    for (let index = 1; index <= runs; index++) {
      const attempt = saved ? saved.attempt(item.id, index) : await run(real ?? fakeModel(item.id), item.message);
      const verdict = judge(item, attempt);
      console.log(`\n${item.id}「${item.message.split("\n")[0]}」第 ${index} 遍 ${verdict.pass ? "过" : "没过"}${verdict.reasons.length ? `：${verdict.reasons.join("；")}` : ""}`);
      console.log(`  调过：${attempt.calls.map((call) => `${call.name}${call.ok ? "" : `（${call.code}）`}${short(call.args) ? ` ${short(call.args)}` : ""}`).join(" → ") || "无"}`);
      if (attempt.reply) console.log(`  回话：${attempt.reply.replace(/\n+/g, " ")}`);
      if (attempt.error) console.log(`  出错：${attempt.error}`);
      attempts.push({ run: index, pass: verdict.pass, reasons: verdict.reasons, ...attempt });
    }
    const passed = attempts.filter((attempt) => attempt.pass).length;
    cases.push({ id: item.id, message: item.message, expect: item.expect, forbid: item.forbid, passed, runs: attempts });
  }

  const tallies = cases.map((entry) => ({ id: entry.id, passed: entry.passed, runs }));
  const flipped = baseline ? flips(baseline, tallies) : null;
  const failed = cases.some((entry) => entry.passed < runs);
  writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), model, commit: commit(), ...(regradePath ? { regradedFrom: regradePath } : {}), runs, maxToolRounds: MAX_TOOL_ROUNDS,
    passedCases: cases.filter((entry) => entry.passed === runs).length, total: cases.length, cases, ...(flipped ? { baseline: baselinePath, flips: flipped } : {}) }, null, 2));

  console.log(`\n每遍都过：${cases.filter((entry) => entry.passed === runs).length}/${cases.length} 条；各条通过遍数：${cases.map((entry) => `${entry.id}:${entry.passed}/${runs}`).join(" ")}`);
  if (flipped) {
    console.log(flipped.regressed.length || flipped.fixed.length
      ? `翻转：上次过这次没过 ${flipped.regressed.length ? `第 ${flipped.regressed.join("、")} 条` : "无"}；上次没过这次过 ${flipped.fixed.length ? `第 ${flipped.fixed.join("、")} 条` : "无"}`
      : "翻转：没有");
  }
  console.log(`结果在 ${out}`);
  process.exitCode = failed ? 1 : 0;
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
