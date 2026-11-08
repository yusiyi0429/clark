"use client";

/**
 * 选项框的三种用法（DecisionBox）：
 * - QuestionDecision：执行方问本人（Claude Code 的「问用户」，本机的 pendingQuestion）。一次几个问题时一题一页，答完一页自动翻到下一页，全部答完「提交」才能点、一起发出。
 * - ApprovalDecision（设计 5.4.3「批准的特别规矩」）：批准 / 同类以后都批准（说明写清范围、只在这个子会话内；回车永远不会是它）/ 换个做法（原地一句话）。
 *   对外的动作（推送、开 PR、发消息、发邮件）头部加「对外」；碰到工作区外的路径（ADR 0031）路径一行一个标红、头部加「工作区外」、只剩「批准 / 换个做法」、不预先放焦点。
 *   几件一起来时翻页，头部右侧「全部批准」（弱按钮）。
 * - AskDecision：伙伴回复里的提问卡（ask_user 工具）。替换以前「开始回答」弹窗那一版，在对话里就地答。
 * 开工（计划）那一种在 components/home/PlanDecision。
 */
import { useContext, useState } from "react";
import type { TConversationCard, TLocalQuestionAnswerRequest, TLocalQuestionRequestView } from "@warmap/contracts";
import type { TLocalPermissionRequestView } from "@/lib/local/runner";
import { AskContext, answersOf } from "@/conversation/AskPanel";
import { HeroButton } from "@/components/HeroButton";
import { DecisionBox, DecisionTag, FailedLine, failureOf, type DecisionOption, type Failure } from "./DecisionBox";
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
/** 这里答不了时选项框头上的状态 chip（5.4.3、5.6「在 {哪} 答」）：等你 · 电脑名。 */
export const awayChip = (device: string | null | undefined) => `等你 · ${device || "那台电脑"}`;

/** 「自己说」「换个做法」的字数上限，和接这句话的接口一致：本机回答 4000（LocalQuestionAnswerRequest.text）、换个做法 500（LocalPermissionDecisionRequest.message）。 */
const ANSWER_MAX = 4000;
export const DENY_MAX = 500;
/** 伙伴提问卡里「自己说」的上限（AskAnswerInput 的 text）。 */
const ASK_TEXT_MAX = 1000;

/** 一个单选问题：在首页那一行就能点着答。 */
export const oneTap = (request: TLocalQuestionRequestView) => request.questions.length === 1 && !request.questions[0]!.multiSelect;

export function QuestionDecision({ request, blocked, onAnswer, resolved, expired }: {
  request: TLocalQuestionRequestView;
  blocked?: string | null;
  onAnswer: (body: TLocalQuestionAnswerRequest) => Promise<unknown>;
  resolved?: string | null;
  /** 子会话停了：收成「已失效」。 */
  expired?: boolean;
}) {
  const [page, setPage] = useState(0);
  const [choices, setChoices] = useState<string[][]>(() => request.questions.map(() => []));
  const [notes, setNotes] = useState<string[]>(() => request.questions.map(() => ""));
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState<Failure | null>(null);
  const question = request.questions[page]!;
  const { options, order } = localOptions(question.options);
  const several = request.questions.length > 1;
  const labelsOf = (picked: number[]) => picked.map((at) => question.options[order[at]!]!.label);
  const answered = (nextChoices: string[][], nextNotes: string[]) => request.questions.every((_, index) => nextChoices[index]!.length > 0 || !!nextNotes[index]);
  // 几个问题的「问题：自己说的话」拼成一段：超过接口上限截掉尾巴，不然这一下怎么重试都发不出去。
  const finish = (nextChoices: string[][], nextNotes: string[]) => {
    const text = nextNotes.map((note, index) => (note ? (several ? `${request.questions[index]!.question}：${note}` : note) : "")).filter(Boolean).join("\n").slice(0, ANSWER_MAX);
    return onAnswer({ choices: nextChoices, ...(text ? { text } : {}) });
  };
  // 一个问题：点了就交。几个问题：答完一页自动翻到下一个没答的，全部答完「提交」才能点，一起发出。
  const advance = (nextChoices: string[][], nextNotes: string[]) => {
    setChoices(nextChoices);
    setNotes(nextNotes);
    if (!several) return finish(nextChoices, nextNotes);
    const next = request.questions.findIndex((_, index) => index > page && !nextChoices[index]!.length && !nextNotes[index]);
    if (next >= 0) setPage(next);
    return undefined;
  };
  // 整件「提交」没成（问题作废了、本机连不上）：框底下原处写「失败 · 重试」。
  const submit = async () => {
    setSending(true);
    setFailed(null);
    try { await finish(choices, notes); }
    catch (error) { setFailed(failureOf(error, () => void submit())); }
    finally { setSending(false); }
  };
  // 几个问题时多选那一页：勾一下记一下，不翻页、不另画「提交」——整件只有底下那一个「提交」。
  const ticking = several && question.multiSelect;
  return (
    <DecisionBox kind="question" testId="question-decision" title={question.question} options={options} multi={question.multiSelect} blocked={blocked} busy={sending}
      resolved={resolved} expired={expired} pager={several ? { index: page, total: request.questions.length, onGo: setPage } : undefined}
      onPick={(picked, note) => advance(choices.map((chosen, index) => (index === page ? labelsOf(picked) : chosen)), notes.map((value, index) => (index === page ? note ?? "" : value)))}
      onTicks={ticking ? (picked) => setChoices(choices.map((chosen, index) => (index === page ? labelsOf(picked) : chosen))) : undefined}
      initialPicks={ticking ? choices[page]!.map((label) => order.findIndex((at) => question.options[at]!.label === label)).filter((at) => at >= 0) : undefined}
      // 多选时自己说的话和勾中的一起发：这里只记字，不清掉勾。
      other={{ placeholder: question.header || undefined, maxLength: ANSWER_MAX, onSubmit: (text) => advance(choices.map((chosen, index) => (index === page && !question.multiSelect ? [] : chosen)), notes.map((note, index) => (index === page ? text : note))) }}
      footer={several ? <>
        {failed && !sending ? <FailedLine inline {...failed} /> : null}
        <span className={x.grow} /><HeroButton variant="primary" size="sm" isDisabled={sending || !answered(choices, notes)} onPress={() => void submit()}>提交</HeroButton>
      </> : undefined} />
  );
}

/** 对外的动作：推送、开 PR、发消息、发邮件（就算在工作区里也一律要本人批，设计 9.5）。按命令尽力认。 */
const EXTERNAL = /\bgit\s+push\b|\bgh\s+(pr|issue|release)\s+(create|merge|comment|edit)\b|\blark-cli\b[^\n]*\b(send|reply|create|update|delete)\b|\b(sendmail|mail)\b/i;

const commandOf = (request: TLocalPermissionRequestView) => (typeof request.input.command === "string" ? request.input.command : null);

/** 等着批的几件（同一个会话）：一页一件；批完一件自动到下一件。 */
export function ApprovalDecision({ requests, blocked, onDecide }: {
  requests: TLocalPermissionRequestView[];
  blocked?: string | null;
  onDecide: (request: TLocalPermissionRequestView, decision: "allow" | "deny", options: { forSession?: boolean; message?: string }) => Promise<unknown>;
}) {
  const [page, setPage] = useState(0);
  const [allBusy, setAllBusy] = useState(false);
  const [allFailed, setAllFailed] = useState<Failure | null>(null);
  const index = Math.min(page, requests.length - 1);
  const request = requests[index];
  if (!request) return null;
  const outside = request.outsidePaths ?? [];
  const command = commandOf(request);
  const external = !!command && EXTERNAL.test(command);
  // 「同类以后都批准」只在这个子会话内放行；说明写清是哪一类（等宽字写工具），回车永远不会选它。
  const options: DecisionOption[] = outside.length ? [{ label: "批准" }]
    : [{ label: "批准", recommended: true }, ...(request.canAllowForSession ? [{ label: "同类以后都批准", noEnter: true, detail: <><code className={x.ruleCode}>{request.toolName}</code> · 这个子会话内</> }] : [])];
  // 「全部批准」有一件没成（别处已经批了、本机连不上）：框底下写「失败 · 重试」。
  const allowAll = async () => {
    setAllBusy(true);
    setAllFailed(null);
    try { for (const entry of requests) await onDecide(entry, "allow", {}); }
    catch (error) { setAllFailed(failureOf(error, () => void allowAll())); }
    finally { setAllBusy(false); }
  };
  const plain = requests.every((entry) => !(entry.outsidePaths ?? []).length);
  return (
    // 换一件就重新来：上一件「换个做法」里写的话不带到这一件。
    <DecisionBox key={request.requestId} kind="approval" testId="approval-decision" title={request.title} blocked={blocked} outside={outside.length > 0} autoFocus={!outside.length} busy={allBusy}
      body={command || outside.length ? <>
        {command ? <code className={x.cmd}>{command}</code> : null}
        {outside.length ? <ul className={x.outside} aria-label="工作区外的路径">{outside.map((path) => <li key={path}>{path}</li>)}</ul> : null}
      </> : undefined}
      pager={requests.length > 1 ? { index, total: requests.length, onGo: setPage } : undefined}
      aside={<>
        {external ? <DecisionTag>对外</DecisionTag> : null}
        {outside.length ? <DecisionTag>工作区外</DecisionTag> : null}
        {requests.length > 1 && plain && !blocked ? <HeroButton variant="ghost" size="sm" isDisabled={allBusy} onPress={() => void allowAll()}>全部批准</HeroButton> : null}
      </>}
      options={options}
      onPick={([picked]) => onDecide(request, "allow", { forSession: picked === 1 && !outside.length })}
      footer={allFailed && !allBusy ? <FailedLine inline {...allFailed} /> : undefined}
      other={{ label: "换个做法", maxLength: DENY_MAX, onSubmit: (message) => onDecide(request, "deny", { message }) }} />
  );
}

type BuddyQuestionCard = Extract<TConversationCard, { kind: "buddy_question" }>;
/** 一题答了什么：点的几个选项（下标），或「自己填」的话（点选项时自己填里打了字，note 一起带上）。 */
export type BuddyPick = { options: number[]; note?: string } | { text: string };

/** 把选择拼成本人的一句话：「部署方式：只发预发（推荐）；时间：本周五」。多选用「、」连，自己填的照原话。 */
export function buddyAnswerText(card: { questions: BuddyQuestionCard["questions"] }, picks: (BuddyPick | undefined)[]): string {
  return card.questions.map((question, index) => {
    const pick = picks[index];
    const answer = !pick ? "跳过" : "text" in pick ? pick.text
      : [...pick.options.map((at) => `${question.options[at]!.label}${question.options[at]!.recommended ? "（推荐）" : ""}`), ...(pick.note ? [pick.note] : [])].join("、");
    return `${question.header}：${answer}`;
  }).join("；");
}

/**
 * 伙伴的选项框（18 节第 9 条，ask_user 出的 buddy_question）：推荐的在第一个、标「推荐」，最后固定一行「自己填」。
 * 一题点了就发；几题一题一页，答完翻到下一个没答的，全部答完「提交」才能点。选了拼成一句话作为本人的新消息发出，带上卡 id（send）。
 * 只画还 open 的；本人可以不选、去聊别的（发了别的话这张就收起，见 WorkTimeline）。
 */
export function BuddyQuestionDecision({ card, send, busy }: { card: BuddyQuestionCard; send: (text: string, questionId: string) => Promise<boolean>; busy: boolean }) {
  const [page, setPage] = useState(0);
  const [picks, setPicks] = useState<(BuddyPick | undefined)[]>(() => card.questions.map(() => undefined));
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState<Failure | null>(null);
  const question = card.questions[page]!;
  const several = card.questions.length > 1;
  const deliver = async (next: (BuddyPick | undefined)[]) => {
    if (!(await send(buddyAnswerText(card, next), card.questionId))) throw new Error("没发出去");
  };
  const record = (pick: BuddyPick) => {
    const next = picks.map((value, index) => (index === page ? pick : value));
    setPicks(next);
    if (!several) return deliver(next);
    const following = next.findIndex((value, index) => index > page && !value);
    const open = following >= 0 ? following : next.findIndex((value) => !value);
    if (open >= 0) setPage(open);
    return undefined;
  };
  const submit = async () => {
    setSending(true);
    setFailed(null);
    try { await deliver(picks); }
    catch (error) { setFailed(failureOf(error, () => void submit())); }
    finally { setSending(false); }
  };
  const current = picks[page];
  const ticking = several && !!question.multiSelect;
  return (
    <DecisionBox kind="question" testId="buddy-question" title={question.question} busy={busy || sending} multi={question.multiSelect}
      options={question.options.map((option) => ({ label: option.label, detail: option.detail, recommended: option.recommended }))}
      pager={several ? { index: page, total: card.questions.length, onGo: setPage } : undefined}
      onPick={(picked, note) => record({ options: picked, ...(note ? { note } : {}) })}
      onTicks={ticking ? (picked) => setPicks(picks.map((value, index) => (index === page ? (picked.length ? { options: picked } : undefined) : value))) : undefined}
      initialPicks={ticking && current && "options" in current ? current.options : undefined}
      other={{ label: "自己填", maxLength: ASK_TEXT_MAX, onSubmit: (text) => record({ text }) }}
      footer={several ? <>
        {failed && !sending ? <FailedLine inline {...failed} /> : null}
        <span className={x.grow} /><HeroButton variant="primary" size="sm" isDisabled={busy || sending || picks.some((value) => !value)} onPress={() => void submit()}>提交</HeroButton>
      </> : undefined} />
  );
}

type QuestionsCard = Extract<TConversationCard, { kind: "questions" }>;
type Pick = { option: number } | { text: string };

/**
 * 伙伴的提问卡：一题一页，答完一页翻到下一个没答的；一个问题点了就发，几个问题全部答完「提交」才能点、一起发出
 * （作为下一句话发回，问答记录照旧显示成紧凑的一问一答）。
 */
export function AskDecision({ card }: { card: QuestionsCard }) {
  const ask = useContext(AskContext);
  const [page, setPage] = useState(0);
  const [draft, setDraft] = useState<Record<string, Pick | undefined>>({});
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState<Failure | null>(null);
  const question = card.questions[page]!;
  const answered = ask?.answered.has(card.askId) ?? false;
  const several = card.questions.length > 1;
  const order = [...question.options.keys()].sort((a, b) => Number(!!question.options[b]!.recommended) - Number(!!question.options[a]!.recommended));
  // 答过的：新首页里原处收成一行（问题 · 答了什么），老页面下面本人那一句就是问答记录、这里不画。
  if (answered) {
    const record = ask?.inline ? ask.answers.get(card.askId) : undefined;
    if (!record) return null;
    const said = record.items.map((item) => item.answer ?? "跳过").join("；");
    return <DecisionBox kind="question" testId="ask-decision" title={several ? `${card.questions.length} 个问题` : card.questions[0]!.question} options={[]} onPick={() => undefined} resolved={said} />;
  }
  // 没发出去（管线正在回话、断网）算失败：原处写「失败 · 重试」。
  const send = async (next: Record<string, Pick | undefined>) => {
    if (!ask) return;
    const answers = answersOf(card, next);
    const sent = await ask.send(answers.record.items.map((item) => `${item.question}：${item.answer ?? "跳过"}`).join("\n"), [], { answers });
    if (!sent) throw new Error("没发出去");
  };
  const record = (next: Record<string, Pick | undefined>) => {
    setDraft(next);
    if (!several) return send(next);
    const following = card.questions.findIndex((entry, index) => index > page && !next[entry.id]);
    const open = following >= 0 ? following : card.questions.findIndex((entry) => !next[entry.id]);
    if (open >= 0) setPage(open);
    return undefined;
  };
  const submit = async () => {
    setSending(true);
    setFailed(null);
    try { await send(draft); }
    catch (error) { setFailed(failureOf(error, () => void submit())); }
    finally { setSending(false); }
  };
  const complete = card.questions.every((entry) => !!draft[entry.id]);
  return (
    <DecisionBox kind="question" testId="ask-decision" title={question.question} busy={!ask || ask.streaming || sending}
      options={order.map((at) => ({ label: question.options[at]!.label, detail: question.options[at]!.detail, recommended: question.options[at]!.recommended }))}
      pager={several ? { index: page, total: card.questions.length, onGo: setPage } : undefined}
      onPick={([picked]) => record({ ...draft, [question.id]: { option: order[picked!]! } })}
      other={{ maxLength: ASK_TEXT_MAX, onSubmit: (text) => record({ ...draft, [question.id]: { text } }) }}
      footer={several ? <>
        {failed && !sending ? <FailedLine inline {...failed} /> : null}
        <span className={x.grow} /><HeroButton variant="primary" size="sm" isDisabled={!ask || ask.streaming || sending || !complete} onPress={() => void submit()}>提交</HeroButton>
      </> : undefined} />
  );
}
