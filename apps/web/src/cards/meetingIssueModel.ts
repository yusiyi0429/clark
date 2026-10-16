import type { TMeetingPreflightEntry } from "@warmap/contracts";
import type { CardAction } from "@/lib/api/client";
import type { MeetingPayload, ResearchDoc } from "./payloads";
import { refIssueId, type SourceContext } from "./meetingSources";

/**
 * 会议页按议题收拢（feedback 15）：哪条预审条目、哪条会后条目属于哪个议题，议题块里有哪些可选路径，
 * 「按此决定」提交什么。全是纯函数：页面和测试用同一套规则。
 */

export type PreflightEntry = TMeetingPreflightEntry;
export type OutcomeItem = NonNullable<MeetingPayload["outcome"]>["items"][number];

/** 天然是「对这个议题的结论」的条目：决定、CEO 判断、复议条件。 */
const DECISION_KINDS = new Set(["decision", "ceoJudgment", "reopenWhen"]);

/**
 * 会后条目指向的议题：显式 issueId 优先；决定类条目在只有一个关联议题时无歧义地归它（与服务端 decisionIssueId 同一规则）。
 * 普通待办、战略议题、未收敛事项没有写明议题时不硬归，放进「其他」。
 */
export function outcomeIssueId(item: Pick<OutcomeItem, "issueId" | "kind">, issueIds: string[]): string | null {
  if (item.issueId) return issueIds.includes(item.issueId) ? item.issueId : null;
  return issueIds.length === 1 && DECISION_KINDS.has(item.kind) ? issueIds[0] : null;
}

const OUTCOME_ORDER = ["decision", "ceoJudgment", "reopenWhen", "todo", "strategic", "open"];
const byKind = (a: OutcomeItem, b: OutcomeItem) => {
  const rank = (item: OutcomeItem) => (OUTCOME_ORDER.indexOf(item.kind) + 1 || OUTCOME_ORDER.length + 1);
  return rank(a) - rank(b);
};

/** 会后条目按议题分组；没有议题的（普通待办、战略议题、未收敛事项…）进「其他」。 */
export function groupOutcomeByIssue(items: OutcomeItem[], issueIds: string[]): { byIssue: Map<string, OutcomeItem[]>; others: OutcomeItem[] } {
  const byIssue = new Map<string, OutcomeItem[]>(issueIds.map((id) => [id, []]));
  const others: OutcomeItem[] = [];
  for (const item of items) {
    const issueId = outcomeIssueId(item, issueIds);
    if (issueId) byIssue.get(issueId)!.push(item);
    else others.push(item);
  }
  for (const [id, list] of byIssue) byIssue.set(id, [...list].sort(byKind));
  return { byIssue, others };
}

/**
 * 预审条目归属：只有一个关联议题时全部归它；多个议题时看条目依据指向哪个议题（议题本身、议题预研、议题群材料、
 * 议题历史里的决定与变化），只指向一个议题的放进那个议题块，其余留在会议层面。
 */
export function attributeEntries(entries: PreflightEntry[], issueIds: string[], context: SourceContext): { byIssue: Map<string, PreflightEntry[]>; meeting: PreflightEntry[] } {
  const byIssue = new Map<string, PreflightEntry[]>(issueIds.map((id) => [id, []]));
  const meeting: PreflightEntry[] = [];
  for (const entry of entries) {
    if (issueIds.length === 1) {
      byIssue.get(issueIds[0])!.push(entry);
      continue;
    }
    const targets = [...new Set(entry.sourceRefs.map((ref) => refIssueId(ref, context)).filter((id): id is string => Boolean(id)))];
    if (targets.length === 1) byIssue.get(targets[0])!.push(entry);
    else meeting.push(entry);
  }
  return { byIssue, meeting };
}

export type DecisionOption = {
  key: string;
  label: string;
  consequences: string[];
  /** 预研选项的 id；只有它能作为 issue.decide 的 optionId 提交。 */
  optionId: string | null;
  /** 来自预审「需要你拍板的问题」时，问题的标题。 */
  question: string | null;
};

const normalize = (text: string) => text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
function sameOption(a: string, b: string): boolean {
  const x = normalize(a), y = normalize(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 4 && long.includes(short);
}

/** 可选路径：预研选项（带后果，可直接按 optionId 决定）＋ 预审问题里的选项（与预研同名的并进预研选项）。 */
export function decisionOptions(doc: ResearchDoc | undefined, questions: PreflightEntry[]): DecisionOption[] {
  const options: DecisionOption[] = (doc?.options ?? []).map((option) => ({
    key: `research:${option.id}`, label: option.label, consequences: [...option.consequences], optionId: option.id, question: null,
  }));
  for (const entry of questions) {
    for (const [index, option] of (entry.ceoDecision?.options ?? []).entries()) {
      const twin = options.find((candidate) => candidate.optionId && sameOption(candidate.label, option.label));
      if (twin) {
        if (!twin.consequences.includes(option.impact)) twin.consequences.push(option.impact);
        continue;
      }
      options.push({ key: `question:${entry.id}:${index}`, label: option.label, consequences: [option.impact], optionId: null, question: entry.title });
    }
  }
  return options;
}

export function defaultDecisionText(option: DecisionOption): string {
  return option.question ? `${option.question}：选择「${option.label}」` : `按「${option.label}」执行`;
}

export type DecisionDraft = { optionKey: string | null; optionId: string | null; text: string; overrideConfirmed: boolean };
export type DecisionActions = { decide?: CardAction; override?: CardAction };

/**
 * 「确认决定」提交的原生 Action：预研完成走 issue.decide（可带预研选项 id）；预研未完成只能走 issue.decide_override，
 * 必须二次确认（confirmOverride: true），且契约不收 optionId。都没有就不能在这里决定。
 */
export function decisionRequest(actions: DecisionActions, draft: DecisionDraft):
  { action: CardAction; input: { decisionText: string; optionId?: string } | { decisionText: string; confirmOverride: true } } | { error: string } {
  const decisionText = draft.text.trim();
  if (!decisionText) return { error: "请写下决定内容" };
  if (decisionText.length > 5000) return { error: "决定内容不能超过 5000 字" };
  if (actions.decide) return { action: actions.decide, input: { decisionText, ...(draft.optionId ? { optionId: draft.optionId } : {}) } };
  if (actions.override) {
    if (!draft.overrideConfirmed) return { error: "预研尚未完成：请先勾选确认在预研未完成时作出决定" };
    return { action: actions.override, input: { decisionText, confirmOverride: true } };
  }
  return { error: "当前不能在这里决定" };
}

export const ISSUE_STATUS_LABEL: Record<"pending" | "decided" | "dismissed", string> = {
  pending: "待决定",
  decided: "已决定",
  dismissed: "已移出",
};

/** 会还没开完时那一行预审状态：只在预审正在跑时写「会前预审中」。「预审：建议补充后上会」这类结论句不再单独占一行（读者从预审正文里看结论）。 */
export function preflightStatusText(preflight: Pick<MeetingPayload["preflight"], "status">): string {
  return preflight.status === "running" ? "会前预审中" : "";
}

/** 预审在后台跑（建会、入会、重新预审之后）：会还没开时，会议页和左栏会议卡要接着刷新，直到出结果。 */
export function preflightInFlight(meeting: Pick<MeetingPayload, "status"> & { preflight: Pick<MeetingPayload["preflight"], "status"> }): boolean {
  return meeting.status === "scheduled" && meeting.preflight?.status === "running";
}

/** 记录账号（资料包里给纪要标作者的「会议纪要」，id 形如 minutes-record）：不是人，不进参会名单。 */
const RECORD_ACCOUNT_ID = /^(?:minutes|record)(?:-|$)/i;

/**
 * 会后条目下面那行「是谁说的」：参会人里有就写名字；纪要账号写「会议纪要」；
 * 认不出的 id 不显示——一号位不该看到 minutes-record 这类内部标识。
 */
export function speakerLabel(speakerId: string | null | undefined, people: ReadonlyMap<string, string>): string | null {
  if (!speakerId) return null;
  const name = people.get(speakerId);
  if (name) return name;
  return RECORD_ACCOUNT_ID.test(speakerId) ? "会议纪要" : null;
}
