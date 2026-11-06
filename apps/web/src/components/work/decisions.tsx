"use client";

/**
 * 选项框的三种用法（DecisionBox）：
 * - QuestionDecision：执行方问本人（Claude Code 的「问用户」，本机的 pendingQuestion）。一次几个问题时一题一页，答完最后一题一起交。
 * - ApprovalDecision：执行方要权限。批准 / 同类以后都批准 / 换个做法（拒绝并附一句）；几件一起来时翻页，带「全部批准」。越界的只能「允许这一次」。
 * - AskDecision：伙伴回复里的提问卡（ask_user 工具）。替换以前「开始回答」弹窗那一版，在对话里就地答。
 * 开工（计划）那一种在 components/home/PlanDecision。
 */
import { useContext, useState } from "react";
import type { TConversationCard, TLocalQuestionAnswerRequest, TLocalQuestionRequestView } from "@warmap/contracts";
import type { TLocalPermissionRequestView } from "@/lib/local/runner";
import { AskContext, answersOf } from "@/conversation/AskPanel";
import { DecisionBox, type DecisionOption } from "./DecisionBox";
import x from "@/styles/decision-box.module.css";

/** Claude Code 把推荐的写在标签后面「(Recommended)」：去掉，标成推荐、放第一个。 */
const RECOMMENDED = /\s*[（(](recommended|推荐)[)）]\s*$/i;
export function localOptions(options: { label: string; description: string }[]): { options: DecisionOption[]; order: number[] } {
  const marked = options.map((option, index) => ({ index, label: option.label.replace(RECOMMENDED, ""), detail: option.description || null, recommended: RECOMMENDED.test(option.label) }));
  const sorted = [...marked.filter((option) => option.recommended), ...marked.filter((option) => !option.recommended)];
  return { options: sorted.map(({ label, detail, recommended }) => ({ label, detail, recommended })), order: sorted.map((option) => option.index) };
}

/** 行里、首页「等你」里写的那一句：第一个问题。 */
export const questionTitle = (request: TLocalQuestionRequestView) => request.questions[0]!.question;
/** 一个单选问题：在首页那一行就能点着答。 */
export const oneTap = (request: TLocalQuestionRequestView) => request.questions.length === 1 && !request.questions[0]!.multiSelect;

export function QuestionDecision({ request, blocked, onAnswer, resolved }: {
  request: TLocalQuestionRequestView;
  blocked?: string | null;
  onAnswer: (body: TLocalQuestionAnswerRequest) => Promise<unknown>;
  resolved?: string | null;
}) {
  const [page, setPage] = useState(0);
  const [choices, setChoices] = useState<string[][]>(() => request.questions.map(() => []));
  const [notes, setNotes] = useState<string[]>(() => request.questions.map(() => ""));
  const question = request.questions[page]!;
  const { options, order } = localOptions(question.options);
  const last = page === request.questions.length - 1;
  const finish = (nextChoices: string[][], nextNotes: string[]) => {
    const text = nextNotes.map((note, index) => (note ? (request.questions.length > 1 ? `${request.questions[index]!.question}：${note}` : note) : "")).filter(Boolean).join("\n");
    return onAnswer({ choices: nextChoices, ...(text ? { text } : {}) });
  };
  const advance = (nextChoices: string[][], nextNotes: string[]) => {
    setChoices(nextChoices);
    setNotes(nextNotes);
    if (last) return finish(nextChoices, nextNotes);
    setPage(page + 1);
    return undefined;
  };
  return (
    <DecisionBox kind="question" testId="question-decision" title={question.question} options={options} multi={question.multiSelect} blocked={blocked}
      resolved={resolved} pager={request.questions.length > 1 ? { index: page, total: request.questions.length, onGo: setPage } : undefined}
      onPick={(picked) => advance(choices.map((chosen, index) => (index === page ? picked.map((at) => question.options[order[at]!]!.label) : chosen)), notes)}
      other={{ placeholder: question.header || undefined, onSubmit: (text) => advance(choices.map((chosen, index) => (index === page ? [] : chosen)), notes.map((note, index) => (index === page ? text : note))) }} />
  );
}

const commandOf = (request: TLocalPermissionRequestView) => (typeof request.input.command === "string" ? request.input.command : null);

/** 等着批的几件（同一个会话）：一页一件；批完一件自动到下一件。 */
export function ApprovalDecision({ requests, blocked, onDecide }: {
  requests: TLocalPermissionRequestView[];
  blocked?: string | null;
  onDecide: (request: TLocalPermissionRequestView, decision: "allow" | "deny", options: { forSession?: boolean; message?: string }) => Promise<unknown>;
}) {
  const [page, setPage] = useState(0);
  const [allBusy, setAllBusy] = useState(false);
  const index = Math.min(page, requests.length - 1);
  const request = requests[index];
  if (!request) return null;
  const outside = request.outsidePaths ?? [];
  const command = commandOf(request);
  const options: DecisionOption[] = outside.length ? [{ label: "允许这一次", recommended: false }]
    : [{ label: "批准", recommended: true }, ...(request.canAllowForSession ? [{ label: "同类以后都批准" }] : [])];
  const allowAll = async () => {
    setAllBusy(true);
    try { for (const entry of requests) await onDecide(entry, "allow", {}); } finally { setAllBusy(false); }
  };
  const plain = requests.every((entry) => !(entry.outsidePaths ?? []).length);
  return (
    // 换一件就重新来：上一件「换个做法」里写的话不带到这一件。
    <DecisionBox key={request.requestId} kind="approval" testId="approval-decision" title={request.title} blocked={blocked} outside={outside.length > 0} autoFocus={!outside.length} busy={allBusy}
      body={command || outside.length ? <>
        {command ? <code className={x.cmd}>{command}</code> : null}
        {outside.length ? <ul className={x.outside} aria-label="越界的路径">{outside.map((path) => <li key={path}>越界：{path}</li>)}</ul> : null}
      </> : undefined}
      pager={requests.length > 1 ? { index, total: requests.length, onGo: setPage } : undefined}
      aside={requests.length > 1 && plain && !blocked ? <button type="button" className={x.all} disabled={allBusy} onClick={() => void allowAll()}>全部批准</button> : undefined}
      options={options}
      onPick={([picked]) => onDecide(request, "allow", { forSession: picked === 1 && !outside.length })}
      other={{ label: "换个做法…", onSubmit: (message) => onDecide(request, "deny", { message }) }} />
  );
}

type QuestionsCard = Extract<TConversationCard, { kind: "questions" }>;
type Pick = { option: number } | { text: string };

/** 伙伴的提问卡：一题一页；答完最后一题作为下一句话发回（问答记录照旧显示成紧凑的一问一答）。 */
export function AskDecision({ card }: { card: QuestionsCard }) {
  const ask = useContext(AskContext);
  const [page, setPage] = useState(0);
  const [draft, setDraft] = useState<Record<string, Pick | undefined>>({});
  const question = card.questions[page]!;
  const answered = ask?.answered.has(card.askId) ?? false;
  const last = page === card.questions.length - 1;
  const order = [...question.options.keys()].sort((a, b) => Number(!!question.options[b]!.recommended) - Number(!!question.options[a]!.recommended));
  // 答过的不再画框：下面本人那一句就是问答记录。
  if (answered) return null;
  const submit = (next: Record<string, Pick | undefined>) => {
    setDraft(next);
    if (!last) { setPage(page + 1); return undefined; }
    if (!ask) return undefined;
    const answers = answersOf(card, next);
    return ask.send(answers.record.items.map((item) => `${item.question}：${item.answer ?? "跳过"}`).join("\n"), [], { answers });
  };
  return (
    <DecisionBox kind="question" testId="ask-decision" title={question.question} busy={!ask || ask.streaming}
      options={order.map((at) => ({ label: question.options[at]!.label, detail: question.options[at]!.detail, recommended: question.options[at]!.recommended }))}
      pager={card.questions.length > 1 ? { index: page, total: card.questions.length, onGo: setPage } : undefined}
      onPick={([picked]) => submit({ ...draft, [question.id]: { option: order[picked!]! } })}
      other={{ onSubmit: (text) => submit({ ...draft, [question.id]: { text } }) }} />
  );
}
