import type { Pool } from "pg";
import type { TConversationCard, TPersonalReviewGenerationStep, TRequestPerson, TRequestStep, TWeeklyReviewGenerationStep } from "@warmap/contracts";
import { draftRequest, getRequestRow, prepareQuestion } from "./delivery/requests.js";
import type { RequestAgent } from "./delivery/requestAgent.js";
import { listOpenTodos, locateTodo, TODO_KIND_LABELS, type OpenTodo, type TodoPerson } from "./delivery/todoLocator.js";
import type { Query } from "./meetingStore.js";
import type { MonthlyReviewService } from "./monthlyReviewService.js";
import { companyPeriod } from "./monthlyPlans.js";
import { executePersonalReviewAction, getCurrentPersonalReview, getPersonalReview, pendingGenerationSteps, personalReviewHref, type PersonalReviewRow } from "./personalReviews.js";
import type { WeeklyReviewService } from "./weeklyReviewService.js";
import type { CollectionAgent } from "./collectionAgent.js";
import { deadlineLabel, draftCollection, type CollectionDeps } from "./collections.js";
import { getWeeklyReviewRow, weeklyReviewHref, weeklyReviewText } from "./weeklyReviews.js";
import { draftMeeting, draftTimeLabel, type DraftMeetingArgs } from "./meetingDraft.js";

/**
 * 对话里的三个一句话入口（交给主 Agent 的工具，见 piConversationRuntime.ts）：
 * - 生成复盘：复用个人复盘生成服务，四步（读 Mission 卡 → 读每周复盘 → 读采集记录 → 起草）实时显示成步骤，本人改过的段落保留；
 * - 帮我问问：定位待办（todoLocator.ts，确定性规则）→ 查有没有人问过 → 整理问题 → 等你确认，复用送达服务；
 * - 请同事帮忙：送达服务的起草流程（起草请求 → 查歧义 → 等你确认）。
 * - 发起信息收集（③）：判断场景 → 起草收集表 → 等你确认，草稿卡上点「发送」才发出。
 * - 约会议：一句话换成会议卡（meetingDraft.ts，只读不写库），卡上点「约好」才建会、发飞书邀请。
 * 处理中的每一步经 onStep 发给界面；结果卡经 onCard 挂在这一轮回答后面。发出、提交都由本人在卡上点，这里一律不发。
 * 交给模型的结果只有它说话要用的事实（不带 actionId），说法要求写在 note 里。
 */
export type EntryStep = { id: string; label: string; status: "done" | "active" | "pending" | "stopped"; result?: string };
export type ConversationEntries = {
  askAboutTodo(args: { question: string; person?: string; date?: string; about?: string }): Promise<Record<string, unknown>>;
  requestHelp(args: { prompt: string; requestId?: string; answers?: string[] }): Promise<Record<string, unknown>>;
  generateReview(args: { kind: "monthly" | "weekly"; period?: string }): Promise<Record<string, unknown>>;
  startCollection(args: { prompt: string; collectionId?: string }): Promise<Record<string, unknown>>;
  draftMeeting(args: DraftMeetingArgs): Promise<Record<string, unknown>>;
  /** 信息收集开着（配了 collections）才给模型「发起信息收集」这个工具（D-56）。 */
  collections: boolean;
};
export type EntryDeps = {
  pool: Pool;
  agent: RequestAgent;
  secret: string;
  viewer: { personId: string; role: "ceo" | "member" };
  /** 本人这一轮的原话：定位待办按原话，不按模型的转述。 */
  message: string;
  names: Map<string, string>;
  /** 可以发请求的人（不含记录账号）。 */
  people: TRequestPerson[];
  /** 人员目录：认出「说到的人不是任何待办的发起人」。 */
  directory: TodoPerson[];
  now: () => Date;
  /** 个人复盘生成；没配置时生成复盘如实说不可用。 */
  reviews?: MonthlyReviewService;
  /** 周复盘生成（weeklyReviewService.generateFor）；没配置时如实说不可用。 */
  weeklyReviews?: WeeklyReviewService;
  /** ③ 信息收集的起草；没配置时如实说不可用。 */
  collections?: { agent: CollectionAgent; deps: CollectionDeps };
  /** 这一次调用的幂等键（复盘的「重新生成」动作按它去重）。 */
  fingerprint: string;
  onStep: (step: EntryStep) => void;
  onCard: (card: TConversationCard) => void;
};
/** 生成复盘时多久重发一次当前步骤：整轮卡住检测按事件间隔判断，起草可能一两分钟没有新事件。 */
const KEEP_ALIVE_MS = 30_000;

const ASK_STEPS = [["todo-locate", "定位待办"], ["todo-check", "查有没有人问过"], ["todo-organize", "整理问题"], ["todo-confirm", "等你确认"]] as const;
const REQUEST_STEPS: Record<string, string> = { 起草请求: "request-draft", 查歧义: "request-clarify", 等你确认: "request-confirm" };
const COLLECTION_STEPS: Record<string, string> = { 判断场景: "collection-scenario", 起草收集表: "collection-draft", 等你确认: "collection-confirm" };
const REVIEW_STATUS: Record<TPersonalReviewGenerationStep["status"] | TWeeklyReviewGenerationStep["status"], EntryStep["status"]> = { pending: "pending", running: "active", done: "done", failed: "stopped" };

const short = (at: Date) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(at).map((part) => [part.type, part.value]));
  return `${Number(parts.month)}/${Number(parts.day)} ${parts.hour}:${parts.minute}`;
};
const requestHref = (id: string, isCeo: boolean) => `${isCeo ? "" : "/me"}/requests/${encodeURIComponent(id)}`;
const todoFact = (todo: OpenTodo) => ({ title: todo.title, from: todo.initiatorName, sentAt: short(todo.sentAt), kind: TODO_KIND_LABELS[todo.kind] });
const plain = (text: string) => text.replace(/\[([^\]\n]+)\]\(([^()\s]+)\)/g, "").replace(/[ \t]+([。，；])/g, "$1").trim();

/** 每轮带进上下文的「我手上没完成的待办」：只带标题、发起人、发出时间、类型。 */
export async function openTodoContext(q: Query, personId: string, names: Map<string, string>, limit = 20) {
  return (await listOpenTodos(q, personId, names, limit)).map(todoFact);
}

/** 「10 月」「2026-10」「10」都认；只说月份时取最近的那个（还没到的月份算去年）。 */
export function reviewPeriod(raw: string | undefined, now: Date): string | null {
  const text = raw?.trim();
  if (!text) return null;
  const full = /^(\d{4})-(\d{1,2})$/.exec(text);
  const month = full ? Number(full[2]) : Number(/^(\d{1,2})\s*月?(?:份)?$/.exec(text)?.[1] ?? Number.NaN);
  if (!(month >= 1 && month <= 12)) return null;
  const [year, current] = companyPeriod(now).split("-").map(Number);
  const resolved = full ? Number(full[1]) : month > current ? year - 1 : year;
  return `${resolved}-${String(month).padStart(2, "0")}`;
}

export function createConversationEntries(deps: EntryDeps): ConversationEntries {
  const q: Query = (sql, params) => deps.pool.query(sql, params);
  const isCeo = deps.viewer.role === "ceo";
  const step = (id: string, label: string, status: EntryStep["status"], result?: string) => deps.onStep({ id, label, status, ...(result ? { result } : {}) });
  /** 送达服务给的步骤（done / current / pending）换成对话的步骤状态。 */
  const relay = (steps: TRequestStep[], ids: (label: string) => string) => {
    for (const item of steps) step(ids(item.label), item.label, item.status === "current" ? "active" : item.status, item.result ?? undefined);
  };
  const askStepId = (label: string) => ASK_STEPS.find(([, name]) => name === label)?.[0] ?? `todo-${label}`;
  const pendingAfter = (index: number) => { for (const [id, label] of ASK_STEPS.slice(index)) step(id, label, "pending"); };

  /** 本周周复盘：六步（读 Mission 卡 → 读进展 → 读会议结论 → 读采集记录 → 读上周复盘 → 起草）实时显示，完成后挂周复盘卡；本人改过的段落保留。 */
  async function generateWeekly(): Promise<Record<string, unknown>> {
    if (!deps.weeklyReviews) return { generated: false, reason: "周复盘生成服务没有配置", note: "如实告诉本人这次生成不了。" };
    let current: TWeeklyReviewGenerationStep[] = [];
    const show = (steps: TWeeklyReviewGenerationStep[]) => {
      current = steps;
      for (const item of steps) step(`weekly-${item.id}`, item.label, REVIEW_STATUS[item.status], item.result);
    };
    const keepAlive = setInterval(() => {
      const running = current.find((item) => item.status === "running");
      if (running) step(`weekly-${running.id}`, running.label, "active", running.result);
    }, KEEP_ALIVE_MS);
    (keepAlive as { unref?: () => void }).unref?.();
    let id: string;
    try {
      const started = await deps.weeklyReviews.generateFor(deps.viewer.personId, { onStep: show });
      id = started.weeklyReviewId;
      if (started.status === "drafting") {
        const row = await getWeeklyReviewRow(q, id);
        if (row?.generation_steps.length && !current.length) show(row.generation_steps);
      }
      await started.done;
    } finally { clearInterval(keepAlive); }
    const row = await getWeeklyReviewRow(q, id);
    if (!row) return { generated: false, reason: "这一周的周复盘找不到了", note: "如实告诉本人没生成成。" };
    deps.onCard({ kind: "weekly_review", weeklyReviewId: row.id, href: weeklyReviewHref(row.id, isCeo) });
    if (row.generation_steps.length) show(row.generation_steps);
    const week = `${Number(row.week_start.slice(5, 7))}/${Number(row.week_start.slice(8))} 这一周`;
    if (row.status === "submitted") return { generated: false, week, reason: `${week}的周复盘已经提交，不能再重新生成`, note: "如实告诉本人原因，界面已附周复盘卡。" };
    if (row.status !== "draft" || !row.body) return { generated: false, week, reason: row.draft_error?.message ?? "这次没有生成成", note: "如实告诉本人没生成成和原因，可以在卡上打开周复盘页重试。" };
    const missing = row.generation_steps.filter((item) => item.result === "缺少记录").map((item) => item.label.replace(/^读/, ""));
    return {
      generated: true, week, draft: plain(weeklyReviewText(row.body)).slice(0, 800), keptYourEdits: row.edited_fields.length, ...(missing.length ? { missingRecords: missing } : {}),
      note: "周复盘草稿已生成，界面在回答下面附了周复盘卡（摘要和「打开修改」）。回答用一两句话说草稿的要点；keptYourEdits 大于 0 时说明本人改过的段落原样保留；有 missingRecords 时说明缺了哪类记录。不复述全文，不说已经提交。",
    };
  }

  return {
    collections: Boolean(deps.collections),
    async askAboutTodo(args) {
      const question = args.question?.trim() || deps.message;
      step("todo-locate", "定位待办", "active");
      pendingAfter(1);
      const todos = await listOpenTodos(q, deps.viewer.personId, deps.names);
      const located = locateTodo({ message: deps.message, hints: args, todos, people: deps.directory, now: deps.now() });
      if (located.status === "none") {
        step("todo-locate", "定位待办", "done", located.person ? `天枢里没有${located.person}发来的这件待办` : "天枢里没有对上的待办");
        return {
          found: "none", person: located.person, openTodos: todos.length,
          ...(located.nearMisses.length ? { otherTodosFromThisPerson: located.nearMisses.map(todoFact) } : {}),
          note: "天枢里没有对上的待办。如实告诉本人天枢里没找到（说到了人就带上人名），不猜是哪一件，也不替本人换成别的待办；有 otherTodosFromThisPerson 时一句话列出来，问是不是其中一件。",
        };
      }
      if (located.status === "many") {
        step("todo-locate", "定位待办", "active", `对上 ${located.total} 件，等你选`);
        deps.onCard({ kind: "todo_pick", question, candidates: located.todos.map((todo) => ({
          requestId: todo.requestId, title: todo.title, initiatorId: todo.initiatorId, initiatorName: todo.initiatorName, sentAt: todo.sentAt.toISOString(), href: requestHref(todo.requestId, isCeo),
        })) });
        return {
          found: "choose", total: located.total, candidates: located.todos.map(todoFact),
          note: "对上不止一件，界面已在回答下面列出这几件让本人点选，点选后再查有没有人问过、整理问题。回答只用一句话说对上了几件、请本人选，不替本人选，不列清单。",
        };
      }
      const todo = located.todo;
      step("todo-locate", "定位待办", "done", `${todo.initiatorName}：${todo.title}`);
      step("todo-check", "查有没有人问过", "active");
      const prepared = await prepareQuestion(q, deps.agent, todo.requestId, deps.viewer.personId, question, deps.names);
      if ("error" in prepared) {
        step("todo-check", "查有没有人问过", "stopped");
        return { found: "error", message: prepared.error.message, note: "如实告诉本人这一步没做成，可以稍后再试或在待办卡上直接问。" };
      }
      relay(prepared.steps.slice(1), askStepId);
      const href = requestHref(todo.requestId, isCeo);
      if (prepared.answer) {
        deps.onCard({ kind: "todo_answer", requestId: todo.requestId, href, question: prepared.question, answer: prepared.answer.text,
          source: prepared.answer.source, questionId: prepared.answer.questionId });
        return {
          found: "answered", todo: todoFact(todo), answer: prepared.answer.text,
          source: prepared.answer.source === "question" ? `${todo.initiatorName}在待办卡上答过` : "请求说明里写了",
          note: "已经有答案，不用再问。直接告诉本人答案，并说明出处（谁答的或说明里写的）；界面已附出处卡，本人仍要问可以在卡上点。不要说已经发出了问题。",
        };
      }
      deps.onCard({ kind: "todo_ask", requestId: todo.requestId, question: prepared.question, href });
      return {
        found: "preview", todo: todoFact(todo), to: todo.initiatorName, question: prepared.question,
        note: `问题已整理好，放在回答下面的预览里，本人点「发送」才会发给${todo.initiatorName}。回答只用一句话说要问谁、问什么，不复述卡上的内容，不教本人怎么点；不要说已经发出。`,
      };
    },

    async requestHelp(args) {
      for (const [label, id] of Object.entries(REQUEST_STEPS)) step(id, label, label === "起草请求" ? "active" : "pending");
      const existing = args.requestId ? await getRequestRow(q, args.requestId) : null;
      // 本人在对话里回答了上一版的歧义问题：按顺序对上还没回答的那几个。
      const answers = (args.answers ?? []).map((answer) => answer.trim());
      let pending = 0;
      const clarifications = existing && answers.length
        ? existing.clarifications.map((item) => item.answer ? item : { question: item.question, answer: answers[pending++] || null })
        : undefined;
      const result = await draftRequest(deps.pool, deps.agent, { prompt: args.prompt, ...(args.requestId ? { requestId: args.requestId } : {}),
        ...(clarifications ? { clarifications } : {}) }, deps.viewer.personId, deps.names, deps.people, deps.secret);
      if ("error" in result) {
        step("request-draft", "起草请求", "stopped");
        return { drafted: false, message: result.error.message, note: "如实告诉本人没起草成和原因。" };
      }
      relay(result.steps, (label) => REQUEST_STEPS[label] ?? `request-${label}`);
      const request = result.request;
      deps.onCard({ kind: "request_draft", requestId: request.id, href: requestHref(request.id, isCeo) });
      const open = request.clarifications.filter((item) => item.answer === null).map((item) => item.question);
      return {
        drafted: true, requestId: request.id, title: request.title, suggestedRecipients: request.candidates.map((person) => person.displayName),
        ...(open.length ? { questionsForYou: open } : {}),
        note: open.length
          ? "草稿和要本人定的问题都在回答下面的卡里，没定之前发不出去。回答一句话说起草了什么、还有几处要本人定（可以在卡里填，也可以直接在对话里回答），不逐条复述问题；本人在对话里回答后，带上 requestId 和按 questionsForYou 顺序写的 answers 再调用一次重写。不要说已经发出。"
          : "草稿已放在回答下面，本人在卡上确认收件人、点「发送」才发出。回答一句话说明发给谁、请对方做什么；收件人没定下来时请本人在卡上选。不要说已经发出。",
      };
    },

    async startCollection(args) {
      if (!deps.collections) return { drafted: false, reason: "信息收集没有配置", note: "如实告诉本人这次起草不了。" };
      for (const [label, id] of Object.entries(COLLECTION_STEPS)) step(id, label, label === "判断场景" ? "active" : "pending");
      const result = await draftCollection(deps.pool, deps.collections.agent, { prompt: args.prompt, ...(args.collectionId ? { collectionId: args.collectionId } : {}) },
        { viewerId: deps.viewer.personId, names: deps.names, people: deps.people, secret: deps.secret, now: deps.now() });
      if ("error" in result) {
        if (result.steps) relay(result.steps, (label) => COLLECTION_STEPS[label] ?? `collection-${label}`);
        else step("collection-scenario", "判断场景", "stopped");
        return result.error.code === "COLLECTION_SCENARIO_UNSUPPORTED"
          ? { drafted: false, reason: "只能收每周开销和每周进展两类", note: "如实告诉本人天枢里的信息收集只做这两类（财务每周开销、方法部门每周进展），这次说的不在里面，没有起草。不教本人怎么改说法。" }
          : { drafted: false, reason: result.error.message, note: "如实告诉本人没起草成和原因。" };
      }
      relay(result.steps, (label) => COLLECTION_STEPS[label] ?? `collection-${label}`);
      const view = result.collection;
      deps.onCard({ kind: "collection_draft", collectionId: view.id });
      return {
        drafted: true, collectionId: view.id, title: view.title, fields: view.fields.map((field) => field.label),
        suggestedRecipients: view.candidates.map((person) => person.displayName), deadline: deadlineLabel(new Date(view.deadlineAt)), weekly: view.weekly,
        note: "收集表草稿已放在回答下面的卡里：收件人、截止、每周固定都能在卡上改，本人点「发送」才发出。回答一句话说收什么、发给谁、什么时候截止；收件人没定下来时请本人在卡上选。本人在对话里要改时，带上 collectionId 和新的原话再调用一次。不要说已经发出。",
      };
    },

    async draftMeeting(args) {
      const result = await draftMeeting({ q, viewer: deps.viewer, people: deps.directory, now: deps.now() }, args);
      if ("reason" in result) {
        return { drafted: false, reason: result.reason,
          note: "没有出会议卡。日期或时间认不出、而你能确定是哪天几点时，把 date 写成 YYYY-MM-DD、time 写成 HH:mm 再调用一次；否则如实告诉本人原因，请本人说清楚。" };
      }
      const { card } = result;
      deps.onCard(card);
      return {
        drafted: true, title: card.title, time: draftTimeLabel(new Date(card.scheduledAt), new Date(card.endsAt)),
        host: card.host?.displayName ?? null, participants: card.participants.map((person) => person.displayName),
        ...(card.unresolved.length ? { unresolved: card.unresolved.map((item) => `${item.name}（${item.reason === "ambiguous" ? "对上不止一个人" : "人员目录里没有"}${item.host ? "，主持人" : ""}）`) } : {}),
        anchor: card.anchor?.title ?? null, ...(result.hostNote ? { hostNote: result.hostNote } : {}),
        note: "会议卡已放在回答下面，本人点「约好」才建会、发飞书邀请，点「修改」可以改。回答只用一句话复述名称、时间和参会人；有 unresolved 时说清哪几个名字没对上、请本人点「修改」补上，不替本人猜是谁；anchor 为 null 时说请在卡上选择所属；有 hostNote 时照实说。不要说已经约好或已经发出邀请。",
      };
    },

    async generateReview(args) {
      if (args.kind === "weekly") return generateWeekly();
      if (!deps.reviews) return { generated: false, reason: "复盘生成服务没有配置", note: "如实告诉本人这次生成不了。" };
      const period = reviewPeriod(args.period, deps.now());
      const row = period
        ? (await q("SELECT * FROM personal_reviews WHERE person_id = $1 AND period = $2 ORDER BY created_at DESC LIMIT 1",
          [deps.viewer.personId, period])).rows[0] as PersonalReviewRow | undefined ?? null
        : await getCurrentPersonalReview(q, deps.viewer.personId);
      const label = `${Number((period ?? row?.period ?? companyPeriod(deps.now())).slice(5))} 月`;
      if (!row) return { generated: false, reason: `${label}的个人复盘还没开始收（月底前三天开始，有 Mission 的人才有）`, note: "如实告诉本人现在还没有这一期的个人复盘可以生成。" };
      const card = () => deps.onCard({ kind: "review", personalReviewId: row.id, href: personalReviewHref(row.id, isCeo) });
      if (row.status === "submitted" || row.status === "skipped") {
        card();
        return { generated: false, period: row.period, reason: row.status === "submitted" ? `${label}的复盘已经提交，不能再重新生成` : `${label}的复盘已被跳过`, note: "如实告诉本人原因。" };
      }

      let version = row.version;
      if (row.status !== "drafting") {
        const outcome = await executePersonalReviewAction(deps.pool, deps.viewer,
          { actionType: "personal-review.draft_with_co_agent", objectType: "personal-review", objectId: row.id, objectVersion: row.version }, {}, `${deps.fingerprint}:${row.version}`, deps.now());
        if ("conflict" in outcome) return { generated: false, reason: "复盘刚被改过，请再说一次", note: "如实告诉本人请再试一次。" };
        if ("error" in outcome) return { generated: false, reason: outcome.error.message, note: "如实告诉本人原因。" };
        const started = outcome.effects.find((effect) => effect.type === "personal_draft");
        version = started && "version" in started ? started.version : row.version + 1;
      }
      // 四步实时显示；起草要一两分钟，期间按间隔重发当前步骤，整轮不被当成卡住。
      let current = row.status === "drafting" && row.generation_steps.length ? row.generation_steps : pendingGenerationSteps();
      const show = (steps: TPersonalReviewGenerationStep[]) => {
        current = steps;
        for (const item of steps) step(`review-${item.id}`, item.label, REVIEW_STATUS[item.status], item.result);
      };
      show(current);
      const keepAlive = setInterval(() => {
        const running = current.find((item) => item.status === "running");
        if (running) step(`review-${running.id}`, running.label, "active", running.result);
      }, KEEP_ALIVE_MS);
      (keepAlive as { unref?: () => void }).unref?.();
      try {
        await deps.reviews.startPersonalDraft(row.id, version, undefined, undefined, show);
      } finally { clearInterval(keepAlive); }

      const done = await getPersonalReview(q, row.id);
      card();
      if (!done || done.status !== "draft" || !done.self_review) {
        if (done?.generation_steps.length) show(done.generation_steps);
        return { generated: false, period: row.period, reason: done?.draft_error?.message ?? "这次没有生成成", note: "如实告诉本人没生成成和原因，可以在卡上打开复盘页重试。" };
      }
      if (done.generation_steps.length) show(done.generation_steps);
      const review = done.self_review;
      const missing = done.generation_steps.filter((item) => item.result === "缺少记录").map((item) => item.label.replace(/^读/, ""));
      return {
        generated: true, period: done.period,
        draft: { overall: plain(review.overall.text).slice(0, 600), judgments: plain(review.judgments.text).slice(0, 400), nextFocus: plain(review.nextFocus.text).slice(0, 300) },
        keptYourEdits: done.edited_fields.length, ...(missing.length ? { missingRecords: missing } : {}),
        note: "草稿已生成，界面在回答下面附了复盘卡（摘要和「打开修改」）。回答用一两句话说草稿的要点；keptYourEdits 大于 0 时说明本人改过的段落原样保留；有 missingRecords 时说明缺了哪类记录。不复述全文，不说已经提交。",
      };
    },
  };
}
