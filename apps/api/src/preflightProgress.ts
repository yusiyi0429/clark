import type { TPreflightProgress, TPreflightProgressStep } from "@warmap/contracts";
import type { CandidateAgentEvent } from "./candidateAgentRuntime.js";
import type { PreflightGroupMaterialInput, PreflightAgentInput } from "./meetingPreflight.js";

/**
 * 会前预审的过程可见（v4）：每一步由系统按实际发生的事生成——读了哪份材料、找到了哪场同战场的会、查了哪一节企业知识、
 * 模型正在写第几道待决题、已经形成了哪一条结论。没有估算的百分比，也不按时间假装推进。
 *
 * 写进 meetings.preflight.progress（同一次预审才写，见 pendingSince 条件），所以页面刷新或离开再回来能接着看；
 * 写入不加 meetings.version，不打断一号位在预审期间的勾选与草稿（这些操作按 version 防冲突）。
 */

export type ProgressEvent = {
  key: string;
  kind: TPreflightProgressStep["kind"];
  label: string;
  detail?: string;
  state?: TPreflightProgressStep["state"];
};

/** 写进库的步骤上限；超出时合并掉最早的企业知识查阅步骤。 */
export const PROGRESS_MAX_STEPS = 80;
/** 两次写库之间至少隔多久（毫秒）；完成、失败时立即写。 */
export const PROGRESS_WRITE_INTERVAL_MS = 700;

const clip = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
};

const SHANGHAI_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric" });
/** 「7/12」：北京时间的月 / 日。 */
export function monthDay(iso: string): string {
  const parts = Object.fromEntries(SHANGHAI_DAY.formatToParts(new Date(iso)).map((part) => [part.type, part.value]));
  return `${Number(parts.month)}/${Number(parts.day)}`;
}

/** 过程记录：按 key 原地更新，节流写库，写库串行。 */
export class PreflightProgressRecorder {
  private progress: TPreflightProgress;
  private timer: NodeJS.Timeout | null = null;
  private writing: Promise<void> = Promise.resolve();
  private dirty = false;
  private closed = false;

  constructor(
    private readonly persist: (progress: TPreflightProgress) => Promise<void>,
    private readonly now: () => Date = () => new Date(),
    private readonly intervalMs = PROGRESS_WRITE_INTERVAL_MS,
  ) {
    const at = this.now().toISOString();
    this.progress = { startedAt: at, updatedAt: at, steps: [] };
  }

  snapshot(): TPreflightProgress {
    return structuredClone(this.progress);
  }

  /** 新增或更新一步；label、detail、state 有变化才算更新。 */
  step(event: ProgressEvent): void {
    if (this.closed) return;
    const at = this.now().toISOString();
    const label = clip(event.label, 300);
    const detail = event.detail ? clip(event.detail, 600) : undefined;
    const state = event.state ?? "done";
    const existing = this.progress.steps.find((step) => step.key === event.key);
    if (existing) {
      if (existing.label === label && existing.detail === detail && existing.state === state) return;
      existing.label = label;
      if (detail) existing.detail = detail; else delete existing.detail;
      existing.state = state;
      existing.updatedAt = at;
    } else {
      this.progress.steps.push({ key: event.key, kind: event.kind, label, ...(detail ? { detail } : {}), state, at, updatedAt: at });
      this.trim();
    }
    this.progress.updatedAt = at;
    this.schedule();
  }

  /** 把某一步标为完成（可换一句完成后的说法）。 */
  done(key: string, label?: string, detail?: string): void {
    const existing = this.progress.steps.find((step) => step.key === key);
    if (!existing) return;
    this.step({ key, kind: existing.kind, label: label ?? existing.label, detail: detail ?? existing.detail, state: "done" });
  }

  has(key: string): boolean {
    return this.progress.steps.some((step) => step.key === key);
  }

  /** 去掉一步（只用于「接下来在做什么」这类占位步骤：真正的下一步出现时让位）。 */
  remove(key: string): void {
    const index = this.progress.steps.findIndex((step) => step.key === key);
    if (index < 0 || this.closed) return;
    this.progress.steps.splice(index, 1);
    this.progress.updatedAt = this.now().toISOString();
    this.schedule();
  }

  /** 把一步移到最后、按现在重新计时（同一件事又开始了一轮）。 */
  restart(event: ProgressEvent): void {
    this.remove(event.key);
    this.step(event);
  }

  /** 最近一条中文思考要点。 */
  thought(text: string): void {
    if (this.closed || this.progress.thought === text) return;
    this.progress.thought = clip(text, 120);
    this.progress.updatedAt = this.now().toISOString();
    this.schedule();
  }

  /** 结束：所有进行中的步骤标完成，写 finishedAt，立即写库。之后不再接受新步骤。 */
  async finish(): Promise<TPreflightProgress> {
    const at = this.now().toISOString();
    for (const step of this.progress.steps) if (step.state === "active") { step.state = "done"; step.updatedAt = at; }
    this.progress.finishedAt = at;
    this.progress.updatedAt = at;
    delete this.progress.thought;
    this.closed = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    await this.writing;
    return this.snapshot();
  }

  /** 立即写一次（等前面的写完）。 */
  async flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.dirty = true;
    this.write();
    await this.writing;
  }

  private schedule(): void {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.write(); }, this.intervalMs);
    this.timer.unref?.();
  }

  private write(): void {
    if (!this.dirty) return;
    this.dirty = false;
    const value = this.snapshot();
    this.writing = this.writing.then(() => this.persist(value)).catch(() => undefined);
  }

  private trim(): void {
    while (this.progress.steps.length > PROGRESS_MAX_STEPS) {
      const index = this.progress.steps.findIndex((step) => step.kind === "knowledge" && step.state === "done");
      this.progress.steps.splice(index >= 0 ? index : 0, 1);
    }
  }
}

/** 过程步骤里的材料名只写原始标题：去掉资料包文字层抽取件的内部后缀「（PDF 文字版）.md」。 */
export function materialTitle(fileName: string): string {
  const title = fileName.replace(/\s*[（(][^（）()]*文字版[^（）()]*[）)]\s*(?:\.[A-Za-z0-9]{1,5})?\s*$/, "").trim();
  return title || fileName;
}

/** 一份群材料读了什么：版本、段数、是否只读到前面一部分。 */
export function materialStepLabel(material: Pick<PreflightGroupMaterialInput, "fileName" | "version" | "state" | "truncated"> & { paragraphCount: number }): string {
  const name = `《${materialTitle(material.fileName)}》第 ${material.version} 版`;
  if (material.state === "link_only") return `${name}是外部链接，只读取了标题与地址`;
  if (material.state === "unreadable") return `${name}没有可读文字，未纳入预审`;
  if (material.truncated) return `已读取${name}前 ${material.paragraphCount} 段（全文超出长度，后文未读）`;
  return `已读取${name}，共 ${material.paragraphCount} 段`;
}

const MATCH_LABEL: Record<string, string> = { shared_issue: "同一议题", battlefield: "同一战场", unit: "同一单元" };

/** 输入阶段的步骤：材料、群讨论、议题历史、对照的近期会议与同战场决定。 */
export function inputProgressEvents(input: Pick<PreflightAgentInput, "groupMaterials" | "materials" | "discussions" | "decisionHistory" | "relatedMeetings" | "battlefieldDecisions">,
  paragraphCounts: Map<string, number>): ProgressEvent[] {
  const events: ProgressEvent[] = [];
  for (const material of input.groupMaterials) {
    events.push({ key: `material:${material.sourceRef}`, kind: "input",
      label: materialStepLabel({ ...material, paragraphCount: paragraphCounts.get(material.sourceRef) ?? 0 }) });
  }
  for (const material of input.materials) {
    events.push({ key: `legacy:${material.id}`, kind: "input", label: `已读取会前材料《${materialTitle(material.fileName)}》` });
  }
  if (input.discussions.length) events.push({ key: "discussions", kind: "input", label: `已读取群讨论 ${input.discussions.length} 条` });
  const effective = input.decisionHistory.reduce((sum, history) => sum + history.effective.length, 0);
  const changes = input.decisionHistory.reduce((sum, history) => sum + history.changes.length, 0);
  if (input.decisionHistory.length) {
    events.push({ key: "decision_history", kind: "history",
      label: effective ? `已读取议题历史：${effective} 条有效决定，之后 ${changes} 项变化` : "已读取议题历史：暂无已确认的决定" });
  }
  for (const meeting of input.relatedMeetings) {
    const how = meeting.matchedBy.map((match) => MATCH_LABEL[match]).filter(Boolean).join("、");
    const confirmed = meeting.confirmedDecisions.length;
    const pending = meeting.pendingDecisions.length;
    const decisions = confirmed && pending ? `${confirmed} 条已确认决定、${pending} 条待确认`
      : confirmed ? `${confirmed} 条已确认决定` : pending ? `${pending} 条会后决定待确认` : "没有会后决定";
    events.push({ key: `meeting:${meeting.id}`, kind: "history",
      label: `已找到${how}的近期会议：${monthDay(meeting.scheduledAt)}《${meeting.title}》，${decisions}` });
  }
  if (input.battlefieldDecisions.length) {
    events.push({ key: "battlefield_decisions", kind: "history", label: `已找到同一战场其他议题的 ${input.battlefieldDecisions.length} 条有效决定` });
  }
  return events;
}

/** 模型开始分析时的那一步：有对照会议时写明在对照哪一场。 */
export function analysisLabel(input: Pick<PreflightAgentInput, "relatedMeetings">, done = false): string {
  const meeting = input.relatedMeetings[0];
  if (!meeting) return done ? "已分析材料与议题" : "正在分析材料与议题";
  return `${done ? "已对照" : "正在对照"} ${monthDay(meeting.scheduledAt)}《${clip(meeting.title, 24)}》的会后决定${done ? "分析材料" : "，分析材料"}`;
}

// ── 思考要点：推理摘要只取中文要点；英文小标题可交给快模型译成中文（与对话同一做法的最小副本）。

// 不上屏的字眼按字符码拼：称呼与运行环境字眼。
const FORBIDDEN_WORDS = [[0x738b, 0x603b], [0x9886, 0x5bfc], [0x8001, 0x677f], [0x60a8, 0x597d], [0x6f14, 0x793a], [0x672c, 0x573a], [0x573a, 0x6b21], [0x64, 0x65, 0x6d, 0x6f]]
  .map((codes) => String.fromCharCode(...codes));
const FORBIDDEN_IN_THOUGHT = new RegExp(`(${FORBIDDEN_WORDS.join("|")}|[一-龥]总(?![体结部量额])|用户)`, "i");

/** 一句思考要点能不能上屏：中文为主、至少两个汉字、不含称呼和运行环境字眼；不超过 30 字。 */
export function cleanThought(text: string): string | undefined {
  const value = text.split(/\n/)[0].trim().replace(/^[「『“"'*]+|[」』”"'*]+$/g, "").replace(/[。.！!；;，,]+$/, "").trim();
  const cjk = value.match(/[一-龥]/g)?.length ?? 0;
  const latin = value.match(/[A-Za-z]/g)?.length ?? 0;
  if (cjk < 2 || cjk < latin || FORBIDDEN_IN_THOUGHT.test(value)) return undefined;
  return value.length > 30 ? `${value.slice(0, 30)}…` : value;
}

/** 推理摘要里最新的一个完整小标题（「**标题**」）。 */
export function latestHeading(summary: string): string | undefined {
  return [...summary.matchAll(/\*\*([^*\n]{2,80})\*\*/g)].map((match) => match[1].trim()).at(-1);
}

/**
 * Claude 的思考摘要没有「**标题**」，是一段段英文：取最近一段写完的（后面已有空行）段落的第一句，交给翻译。
 * 还在写的那一段不取，免得译半句。
 */
export function latestParagraphLead(summary: string): string | undefined {
  const parts = summary.split(/\n\s*\n/);
  const done = parts.slice(0, -1).map((part) => part.trim()).filter(Boolean).at(-1);
  if (!done) return undefined;
  const lead = done.split(/(?<=[.!?。！？])\s+/)[0].replace(/\s+/g, " ").trim();
  return lead.length >= 8 ? lead.slice(0, 120) : undefined;
}

/** 预审 Agent 的两个阶段性结论工具（定义在 preflightAgent.ts）：模型边分析边交出，界面先显示。 */
export const REPORT_MATERIAL_QUESTIONS = "report_material_questions";
export const REPORT_HISTORY_CHECK = "report_history_check";

export type ThoughtTranslator = (heading: string, signal?: AbortSignal) => Promise<string | null>;

// ── 模型写候选的过程：从工具的流式参数里读出已写完的待决题判断、历史对照与条目。

const VERDICT_LABEL: Record<string, string> = { ceo: "需要一号位判断", owner: "负责人职责内可定", monitor: "事实不足，转监测" };
const KIND_LABEL: Record<string, string> = {
  core_judgment: "核心判断", meeting_question: "会议问题", leader_lens: "一号位追问", risk_calibration: "风险与待校准",
  next_step: "推动建议", positive_signal: "积极信号", strategic_alignment: "战略一致性判断",
};
const DIVERGENCE_LABEL: Record<string, string> = { fact_gap: "事实不足", judgment: "判断分歧", value_tradeoff: "价值取舍" };
const RELATION_LABEL: Record<string, string> = { consistent: "一致", tension: "存在张力", conflict: "冲突" };
/** 逐条出现在过程里的条目类别（其余只计数）。 */
const LISTED_KINDS = new Set(["core_judgment", "meeting_question", "leader_lens"]);

type PartialQuestion = { question?: unknown; verdict?: unknown; reason?: unknown };
type PartialEntry = { kind?: unknown; title?: unknown };
type PartialCandidate = { materialQuestions?: { total?: unknown; items?: unknown }; entries?: unknown; divergences?: unknown };
type PartialCheck = { ref?: unknown; relation?: unknown; note?: unknown };

const str = (value: unknown) => (typeof value === "string" ? value : "");

/** 某个字段之后是否已经开始写别的字段（按模型实际写出的顺序；说明这个字段已写完）。 */
function startedAfter(value: Record<string, unknown>, key: string): boolean {
  const present = Object.keys(value);
  const index = present.indexOf(key);
  return index >= 0 && index < present.length - 1;
}

/** 数组里已写完的项数：后面已经开始写下一项，或整个数组已写完。 */
const completedCount = (items: unknown[], finished: boolean) => (items.length ? items.length - 1 + (finished ? 1 : 0) : 0);

/**
 * 把模型写的流式参数变成过程步骤；只在有新内容时更新。
 * - materialQuestions：材料自带待决题（单独的 report_material_questions，或 submit_candidate 里的同名字段）；
 * - historyCheck：对照近期会议决定的结论（report_history_check）；refLabels 给出每条决定的原文，用于写「哪一条」；
 * - candidate：submit_candidate 的条目与分歧。
 */
export function createCandidateProgress(recorder: PreflightProgressRecorder, refLabels: Map<string, string> = new Map()) {
  let questionsJudged = 0;
  /** 待决题已由阶段性结论工具完整交出：最终候选里的同名字段不再改动过程。 */
  let questionsDelivered = false;
  let checksDone = 0;
  let entriesDone = 0;
  let writingStarted = false;
  const kindCounts = new Map<string, number>();

  const materialQuestions = (raw: unknown, finished: boolean, fromCandidate = false) => {
    if (!raw || typeof raw !== "object" || (fromCandidate && questionsDelivered)) return;
    if (finished && !fromCandidate) questionsDelivered = true;
    const questions = raw as { total?: unknown; items?: unknown } & Record<string, unknown>;
    const items = Array.isArray(questions.items) ? questions.items as PartialQuestion[] : [];
    // total 可能写在 items 之后：没有 total 时只写已判断几道。
    const itemsFinished = finished || startedAfter(questions, "items");
    const total = typeof questions.total === "number" ? questions.total : null;
    const judged = Math.min(completedCount(items, itemsFinished), items.length);
    for (let index = questionsJudged; index < judged; index += 1) {
      const item = items[index];
      const verdict = VERDICT_LABEL[str(item.verdict)];
      if (!verdict || !str(item.question)) continue;
      recorder.step({ key: `material_question:${index + 1}`, kind: "material_question",
        label: `第 ${index + 1} 题「${clip(str(item.question), 40)}」：${verdict}`, ...(str(item.reason) ? { detail: str(item.reason) } : {}) });
    }
    questionsJudged = Math.max(questionsJudged, judged);
    if (!items.length && !finished && total === null) return;
    const counts = { ceo: 0, owner: 0, monitor: 0 } as Record<string, number>;
    for (const item of items.slice(0, judged)) counts[str(item.verdict)] = (counts[str(item.verdict)] ?? 0) + 1;
    const count = total ?? judged;
    if (finished || (total !== null && judged >= total && itemsFinished)) {
      recorder.step(count === 0
        ? { key: "material_questions", kind: "material_question", label: "材料没有自带的待决题" }
        : { key: "material_questions", kind: "material_question",
          label: `已逐条判断材料自带的 ${count} 道待决题：${[counts.ceo ? `${counts.ceo} 道需要一号位判断` : "", counts.owner ? `${counts.owner} 道负责人可定` : "",
            counts.monitor ? `${counts.monitor} 道转监测` : ""].filter(Boolean).join("，") || "均已判断"}` });
    } else {
      recorder.step({ key: "material_questions", kind: "material_question", state: "active",
        label: total !== null ? `正在逐条判断材料自带的 ${total} 道待决题（${judged}/${total}）` : `正在逐条判断材料自带的待决题（已判断 ${judged} 道）` });
    }
  };

  const historyCheck = (raw: unknown, finished: boolean) => {
    if (!raw || typeof raw !== "object") return;
    const checks = Array.isArray((raw as { checks?: unknown }).checks) ? (raw as { checks: PartialCheck[] }).checks : [];
    const done = completedCount(checks, finished);
    for (let index = checksDone; index < done; index += 1) {
      const check = checks[index];
      const relation = RELATION_LABEL[str(check.relation)];
      if (!relation) continue;
      const decision = refLabels.get(str(check.ref));
      recorder.step({ key: `history_check:${index + 1}`, kind: "history",
        label: `${decision ? `「${clip(decision, 36)}」` : "一条历史决定"}：${relation}`, ...(str(check.note) ? { detail: str(check.note) } : {}) });
    }
    checksDone = Math.max(checksDone, done);
    if (!checks.length) return;
    const counts = new Map<string, number>();
    for (const check of checks.slice(0, done)) counts.set(str(check.relation), (counts.get(str(check.relation)) ?? 0) + 1);
    const summary = Object.keys(RELATION_LABEL).filter((relation) => counts.get(relation)).map((relation) => `${RELATION_LABEL[relation]} ${counts.get(relation)}`).join("、");
    recorder.step(finished
      ? { key: "history_checks", kind: "history", label: `已对照 ${done} 条历史决定${summary ? `：${summary}` : ""}` }
      : { key: "history_checks", kind: "history", label: `正在对照历史决定（已对照 ${done} 条）`, state: "active" });
  };

  /** final=true：整份候选已写完（工具调用结束），所有字段都算写完。 */
  const candidate = (raw: unknown, final = false) => {
    if (!raw || typeof raw !== "object") return;
    const value = raw as PartialCandidate & Record<string, unknown>;
    const finishedField = (key: string) => final || startedAfter(value, key);
    if (!writingStarted) {
      writingStarted = true;
      recorder.done("deliberate", "已权衡取舍");
      recorder.step({ key: "compose", kind: "finding", label: "正在写出预审结论", state: "active" });
    }
    if (value.materialQuestions) materialQuestions(value.materialQuestions, finishedField("materialQuestions"), true);

    const entries = Array.isArray(value.entries) ? value.entries as PartialEntry[] : [];
    const entriesFinished = finishedField("entries");
    const completed = completedCount(entries, entriesFinished);
    for (let index = entriesDone; index < completed; index += 1) {
      const entry = entries[index];
      const kind = str(entry.kind);
      if (!KIND_LABEL[kind] || !str(entry.title)) continue;
      kindCounts.set(kind, (kindCounts.get(kind) ?? 0) + 1);
      if (LISTED_KINDS.has(kind)) {
        recorder.step({ key: `entry:${index + 1}`, kind: "finding", label: `已形成${KIND_LABEL[kind]}：${clip(str(entry.title), 50)}` });
      }
    }
    if (completed > entriesDone) {
      entriesDone = completed;
      const total = [...kindCounts.values()].reduce((sum, n) => sum + n, 0);
      const questions = kindCounts.get("meeting_question") ?? 0;
      const lens = kindCounts.get("leader_lens") ?? 0;
      const within = [questions ? `会议问题 ${questions} 条` : "", lens ? `一号位追问 ${lens} 条` : ""].filter(Boolean).join("、");
      recorder.step({ key: "findings", kind: "finding", state: entriesFinished ? "done" : "active",
        label: `已形成 ${total} 条判断与建议${within ? `，其中${within}` : ""}` });
    }

    if (Array.isArray(value.divergences) && finishedField("divergences")) {
      const divergences = value.divergences as { type?: unknown }[];
      if (divergences.length) {
        const counts = new Map<string, number>();
        for (const item of divergences) counts.set(str(item.type), (counts.get(str(item.type)) ?? 0) + 1);
        recorder.step({ key: "divergences", kind: "finding",
          label: `已归类 ${divergences.length} 处开放分歧：${[...counts.entries()].filter(([type]) => DIVERGENCE_LABEL[type]).map(([type, n]) => `${DIVERGENCE_LABEL[type]} ${n}`).join("、")}` });
      }
    }
  };

  return { candidate, materialQuestions, historyCheck };
}

/** 企业知识工具的进度：开始时写在查什么，结束时写读到了什么。 */
function knowledgeLabel(name: string, args: Record<string, unknown>): string | undefined {
  const query = str(args.query).trim();
  switch (name) {
    case "list_sections": return "查看企业知识目录";
    case "search_sections": return `查找企业知识${query ? `「${clip(query, 30)}」` : ""}`;
    case "get_passages": return "阅读企业知识原文";
    default: return undefined;
  }
}

function knowledgeResult(name: string, result: unknown): string | undefined {
  const content = (result as { content?: { text?: unknown }[] } | null)?.content;
  const text = Array.isArray(content) ? content.map((item) => str(item?.text)).join("") : "";
  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { return undefined; }
  if (name === "list_sections" && Array.isArray(parsed.sections)) return `共 ${parsed.sections.length} 节`;
  if (name === "search_sections" && Array.isArray(parsed.results)) {
    const titles = (parsed.results as { title?: unknown }[]).map((item) => str(item.title)).filter(Boolean).slice(0, 3);
    return titles.length ? `找到 ${parsed.results.length} 节：${titles.map((title) => `《${clip(title, 16)}》`).join("")}` : "没有找到相关章节";
  }
  if (name === "get_passages") {
    const title = str((parsed.section as { title?: unknown } | undefined)?.title);
    const count = Array.isArray(parsed.passages) ? parsed.passages.length : 0;
    return title ? `《${clip(title, 24)}》${count} 段` : undefined;
  }
  return undefined;
}

/**
 * 候选 Agent 的运行事件 → 过程步骤：思考要点、企业知识查阅、候选写作。
 * translate 给出时，英文推理小标题译成中文要点（同一时间只译一条，译不出就不显示）。
 */
export function createAgentProgressHandler(recorder: PreflightProgressRecorder,
  options: { translate?: ThoughtTranslator; signal?: AbortSignal; refLabels?: Map<string, string> } = {}) {
  const progress = createCandidateProgress(recorder, options.refLabels);
  let summary = "";
  let lastHeading: string | undefined;
  let translating = false;
  let knowledgeCount = 0;
  const knowledgeKeys = new Map<string, { key: string; label: string }>();

  return (event: CandidateAgentEvent) => {
    switch (event.type) {
      case "thinking_start":
        summary = "";
        return;
      case "thinking_delta": {
        summary += event.delta;
        const firstLine = summary.split(/\n/).map((line) => line.trim()).find(Boolean);
        const direct = cleanThought(latestHeading(summary) ?? firstLine ?? "");
        if (direct) { recorder.thought(direct); return; }
        // GPT 的摘要按「**小标题**」翻；Claude 没有小标题，按最近写完的一段的第一句翻。
        const heading = latestHeading(summary) ?? latestParagraphLead(summary);
        if (heading && heading !== lastHeading && options.translate && !translating) {
          lastHeading = heading;
          translating = true;
          void options.translate(heading, options.signal)
            .then((text) => { const thought = text ? cleanThought(text) : undefined; if (thought) recorder.thought(thought); })
            .catch(() => undefined)
            .finally(() => { translating = false; });
        }
        return;
      }
      case "tool_start": {
        const label = knowledgeLabel(event.name, (event.args ?? {}) as Record<string, unknown>);
        if (!label) return;
        knowledgeCount += 1;
        const key = `knowledge:${knowledgeCount}`;
        knowledgeKeys.set(event.toolCallId, { key, label });
        recorder.step({ key, kind: "knowledge", label: `正在${label}`, state: "active" });
        return;
      }
      case "tool_end": {
        // 阶段性结论交出之后、最终候选开始写之前：模型在权衡取舍（按提示词的工作顺序，下一步就是写最终候选）。
        if ((event.name === REPORT_MATERIAL_QUESTIONS || event.name === REPORT_HISTORY_CHECK) && !event.isError && !recorder.has("compose")) {
          recorder.restart({ key: "deliberate", kind: "thinking", label: "正在权衡取舍，形成会议问题、一号位追问与开放分歧", state: "active" });
          return;
        }
        const known = knowledgeKeys.get(event.toolCallId);
        if (!known) return;
        knowledgeKeys.delete(event.toolCallId);
        const detail = event.isError ? "未能读取" : knowledgeResult(event.name, event.result);
        recorder.step({ key: known.key, kind: "knowledge", label: `已${known.label}`, ...(detail ? { detail } : {}) });
        return;
      }
      case "tool_args":
        if (event.name === "submit_candidate") progress.candidate(event.args, event.final === true);
        else if (event.name === REPORT_MATERIAL_QUESTIONS) {
          if (!recorder.has("compose")) recorder.remove("deliberate");
          progress.materialQuestions(event.args, event.final === true);
        }
        else if (event.name === REPORT_HISTORY_CHECK) {
          // 又交出一份阶段性结论：上一句「正在权衡取舍」让位，交完之后再接上。
          if (!recorder.has("compose")) recorder.remove("deliberate");
          progress.historyCheck(event.args, event.final === true);
        }
        return;
      default:
        return;
    }
  };
}
