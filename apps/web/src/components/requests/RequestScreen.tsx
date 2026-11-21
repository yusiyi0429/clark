"use client";

/**
 * ⑨ 传话的二级页（DetailFrame 壳）。同一个页面三种样子：
 * - 新请求 / 草稿（发起人）：一句话 → Agent 起草并自查歧义 → 回答「要你定」 → 预览 → 点「发送」才发出。参照 Superhuman 的发送前预览：收件人、主题、正文在一张卡里，发送键只在卡上。
 * - 已发出：接收人的待办卡（参照飞书审批卡：接收人和各自状态一排、本人的处理键在同一处），说明正文，问答（参照 GitHub PR conversation：一问一答成对、答案挂在问题下面）。
 * - 卡上提问：先查有没有人问过，有就直接给答案；没有就整理成一个问题，预览后本人点「发送」。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Markdown from "react-markdown";
import { ArrowUp, Check, Sparkles } from "lucide-react";
import { Button } from "ts-design/primitives";
import type { TActionDescriptor, TPrepareRequestQuestionResponse, TRequestQuestionView, TRequestStep, TRequestView } from "@warmap/contracts";
import { PersonAvatar } from "@/components/avatar/PersonAvatar";
import { DetailFrame } from "@/components/shell/DetailFrame";
import { useRegisterDetail, useWorkspace } from "@/components/shell/WorkspaceContext";
import { Select } from "@/components/ui/Select";
import { monthDayTime } from "@/lib/companyTime";
import { REMARK_PLUGINS } from "@/lib/markdown";
import type { Card } from "@/lib/api/client";
import { draftAnswer, draftRequest, prepareQuestion, readRequest, requestError, runRequestAction } from "./requestApi";
import { RequestSteps, runningSteps } from "./RequestSteps";
import { ImpactCardScreen } from "./ImpactCard";
import { DocChangeScreen } from "./DocChange";
import { CollectionScreen } from "@/components/collections/CollectionScreen";
import s from "./requests.module.css";

const NO_CARDS: Card[] = [];
const DRAFT_STEPS = ["起草请求", "查歧义", "等你确认"];
const ASK_STEPS = ["定位待办", "查有没有人问过", "整理问题", "等你确认"];
const ANSWER_STEPS = ["读问题", "起草回答", "等你确认"];

const actionOf = (request: TRequestView | null, type: string, itemId?: string) =>
  request?.actions.find((action) => action.actionType === type && (itemId === undefined || action.itemId === itemId));
const initial = (name: string) => name.trim().slice(-1);

export function statusTone(request: Pick<TRequestView, "status">, mine: TRequestView["viewer"]["myStatus"] = null): { label: string; tone: "wait" | "done" | "draft" } {
  if (request.status === "draft") return { label: "草稿", tone: "draft" };
  if (mine === "pending") return { label: "待处理", tone: "wait" };
  if (mine === "done" || request.status === "done") return { label: "已完成", tone: "done" };
  return { label: "进行中", tone: "wait" };
}

export function RequestScreen({ initialRequest, base, initialPrompt }: { initialRequest: TRequestView | null; base: string; initialPrompt?: string }) {
  // 影响卡也走送达通道，二级页换成影响卡的样子。
  if (initialRequest?.kind === "impact") return <ImpactCardScreen request={initialRequest} base={base} />;
  // 文档变更：作者确认修订 / 取代哪份，或旧文档负责人回答还有效吗。
  if (initialRequest?.kind === "doc_change") return <DocChangeScreen request={initialRequest} />;
  // ③ 信息收集的一轮：待办卡（接收人）或汇总（发起人）。
  if (initialRequest?.kind === "collection") return <CollectionScreen request={initialRequest} />;
  return <RelayRequestScreen initialRequest={initialRequest} base={base} initialPrompt={initialPrompt} />;
}

function RelayRequestScreen({ initialRequest, base, initialPrompt }: { initialRequest: TRequestView | null; base: string; initialPrompt?: string }) {
  const workspace = useWorkspace();
  const [request, setRequest] = useState(initialRequest);
  const sent = request !== null && request.status !== "draft";
  const title = sent ? request.title : "新请求";
  useRegisterDetail(useMemo(() => ({ scope: "global", label: title, mark: null, cards: NO_CARDS }), [title]));

  // 别处（通知栏、另一个标签页）动过这条请求时重读；草稿阶段只有自己在改，不重读免得冲掉输入。
  const refresh = useCallback(async () => {
    if (!request || request.status === "draft") return;
    try { setRequest(await readRequest(request.id)); } catch { /* 下次再读 */ }
  }, [request]);
  useEffect(() => {
    if (!sent) return;
    const onFocus = () => { if (document.visibilityState === "visible") void refresh(); };
    const timer = window.setInterval(onFocus, 20_000);
    window.addEventListener("focus", onFocus);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", onFocus); };
  }, [sent, refresh]);

  const status = request ? statusTone(request, request.viewer.myStatus) : null;
  return (
    <div className={s.screen}>
      <DetailFrame
        title={title}
        subtitle={sent ? `传话 · ${request.initiator.displayName} · ${monthDayTime(request.sentAt)}` : request ? `传话 · 草稿 v${request.version}` : "传话"}
        onBack={() => workspace.close()}
        actions={status && sent ? <span className={`${s.chip} ${s.headerChip}`} data-tone={status.tone}>{status.label}</span> : undefined}
      >
        <div className={s.content}>
          {sent
            ? <SentRequest request={request} onChange={setRequest} />
            : <DraftRequest request={request} initialPrompt={initialPrompt} onChange={setRequest} onSent={(next) => {
              setRequest(next);
              workspace.showToast(`已发给 ${next.recipients.map((person) => person.displayName).join("、")}`);
              if (!initialRequest) workspace.navigate(`${base}/${encodeURIComponent(next.id)}`);
            }} />}
        </div>
      </DetailFrame>
    </div>
  );
}

/* ---------- 发起人：起草 → 要你定 → 预览 → 发送 ---------- */

/** compact：对话里的草稿卡（conversation/EntryCards）用，原话已在对话里，不显示起草框；改了「要你定」的回答时在那一组下面给「按回答重写」。 */
export function DraftRequest({ request, onChange, onSent, compact = false, initialPrompt }: {
  request: TRequestView | null; onChange: (next: TRequestView) => void; onSent: (next: TRequestView) => void; compact?: boolean;
  /** 从影响卡「可以问」进来时带上的开头。 */
  initialPrompt?: string;
}) {
  const [prompt, setPrompt] = useState(request?.prompt ?? initialPrompt ?? "");
  const [steps, setSteps] = useState<TRequestStep[] | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>(() => Object.fromEntries((request?.clarifications ?? []).map((item) => [item.question, item.answer ?? ""])));
  const [chosen, setChosen] = useState<string[]>(() => request?.candidates.map((person) => person.personId) ?? []);
  const [extra, setExtra] = useState<{ personId: string; displayName: string }[]>([]);
  const [busy, setBusy] = useState<"draft" | "send" | null>(null);
  const [error, setError] = useState("");
  const promptRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (!request && !compact) promptRef.current?.focus(); }, [request, compact]);

  const clarifications = request?.clarifications ?? [];
  const unanswered = clarifications.filter((item) => !answers[item.question]?.trim()).length;
  const changedAnswers = clarifications.some((item) => (answers[item.question] ?? "").trim() !== (item.answer ?? ""));
  const stale = request !== null && (prompt.trim() !== request.prompt || changedAnswers);
  const people = [...(request?.candidates ?? []), ...extra.filter((person) => !request?.candidates.some((candidate) => candidate.personId === person.personId))];
  const addable = (request?.directory ?? []).filter((person) => !people.some((shown) => shown.personId === person.personId));
  const sendAction = actionOf(request, "request.send");
  const canSend = Boolean(sendAction) && !stale && unanswered === 0 && chosen.length > 0 && busy === null;

  const draft = async () => {
    if (!prompt.trim() || busy) return;
    setBusy("draft"); setError(""); setSteps(runningSteps(DRAFT_STEPS));
    try {
      const result = await draftRequest(prompt.trim(), request?.id, request ? clarifications.map((item) => ({ question: item.question, answer: answers[item.question]?.trim() || null })) : undefined);
      setSteps(result.steps);
      onChange(result.request);
      setAnswers(Object.fromEntries(result.request.clarifications.map((item) => [item.question, item.answer ?? ""])));
      // 第一次起草按 Agent 的建议勾上；重写时保留本人已经勾选的人。
      if (!request) setChosen(result.request.candidates.map((person) => person.personId));
    } catch (cause) {
      setSteps(null);
      setError(requestError(cause, "起草没有成功，请重试"));
    } finally { setBusy(null); }
  };
  const send = async () => {
    if (!sendAction || !canSend) return;
    setBusy("send"); setError("");
    try { onSent(await runRequestAction(sendAction, { recipientIds: chosen })); }
    catch (cause) { setError(requestError(cause, "没有发出去，请重试")); }
    finally { setBusy(null); }
  };
  const toggle = (personId: string) => setChosen((current) => current.includes(personId) ? current.filter((id) => id !== personId) : [...current, personId]);

  return (
    <div className={s.stack}>
      {compact ? null : <section className={s.composer} data-compact={request ? "" : undefined}>
        <textarea ref={promptRef} aria-label="请谁做什么" placeholder="请谁做什么" rows={request ? 2 : 4} maxLength={2000} value={prompt} disabled={busy !== null}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void draft(); } }} />
        <div className={s.composerBar}>
          <kbd className={s.kbd}>Ctrl ↵</kbd>
          <Button variant={request && !stale ? "ghost" : "primary"} className={request && !stale ? s.ghost : s.primary} isDisabled={!prompt.trim() || busy !== null || (request !== null && !stale)} onPress={() => void draft()}>
            <Sparkles size={16} aria-hidden="true" />{request ? "按回答重写" : "起草"}
          </Button>
        </div>
      </section>}

      {steps ? <RequestSteps steps={steps} label="起草步骤" /> : null}
      {error ? <p className={s.error} role="alert">{error}</p> : null}

      {clarifications.length ? (
        <section className={s.panel} aria-labelledby="request-clarify">
          <header className={s.panelHead}>
            <h2 id="request-clarify">要你定</h2>
            <b className={s.count} data-tone={unanswered ? "wait" : "done"}>{unanswered ? unanswered : <Check size={12} strokeWidth={3} aria-label="都已回答" />}</b>
          </header>
          <ol className={s.clarifyList}>
            {clarifications.map((item, index) => (
              <li key={item.question}>
                <label htmlFor={`clarify-${index}`}>{item.question}</label>
                <input id={`clarify-${index}`} value={answers[item.question] ?? ""} maxLength={1000} disabled={busy !== null}
                  data-filled={answers[item.question]?.trim() ? "" : undefined}
                  onChange={(event) => setAnswers((current) => ({ ...current, [item.question]: event.target.value }))} />
              </li>
            ))}
          </ol>
          {compact && stale ? (
            <div className={s.replyBar}>
              <Button variant="primary" className={s.primary} isDisabled={busy !== null} onPress={() => void draft()}>
                <Sparkles size={16} aria-hidden="true" />{busy === "draft" ? "重写中" : "按回答重写"}
              </Button>
            </div>
          ) : null}
        </section>
      ) : null}

      {request ? (
        <section className={s.preview} aria-label="预览" data-stale={stale ? "" : undefined}>
          <div className={s.toRow}>
            <span className={s.fieldName}>收件人</span>
            <div className={s.chips}>
              {people.map((person) => {
                const on = chosen.includes(person.personId);
                return <button key={person.personId} type="button" className={s.personChip} aria-pressed={on} disabled={busy !== null} onClick={() => toggle(person.personId)}>
                  <PersonAvatar personId={on ? null : person.personId} className={s.avatar}>{on ? <Check size={12} strokeWidth={3} /> : initial(person.displayName)}</PersonAvatar>{person.displayName}
                </button>;
              })}
              {addable.length ? <Select size="compact" className={s.addPerson} aria-label="添加收件人" placeholder="添加" value=""
                options={addable.map((person) => ({ value: person.personId, label: person.displayName }))}
                onChange={(personId) => {
                  const person = addable.find((candidate) => candidate.personId === personId);
                  if (!person) return;
                  setExtra((current) => [...current, person]);
                  setChosen((current) => [...current, person.personId]);
                }} /> : null}
            </div>
          </div>
          <div className={s.subject}>{request.title}</div>
          <div className={s.prose}><Markdown remarkPlugins={REMARK_PLUGINS}>{request.body}</Markdown></div>
          <footer className={s.previewFoot}>
            <span className={s.version}>v{request.version}</span>
            <Button variant="primary" className={s.primary} isDisabled={!canSend} onPress={() => void send()}>
              <ArrowUp size={16} aria-hidden="true" />{busy === "send" ? "发送中" : "发送"}
            </Button>
          </footer>
        </section>
      ) : null}
    </div>
  );
}

/* ---------- 已发出：待办卡 ---------- */

function SentRequest({ request, onChange }: { request: TRequestView; onChange: (next: TRequestView) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const markDone = actionOf(request, "request.mark_done");
  const done = request.recipients.filter((person) => person.status === "done").length;
  const perform = async (action: TActionDescriptor | undefined, input?: unknown) => {
    if (!action || busy) return false;
    setBusy(true); setError("");
    try { onChange(await runRequestAction(action, input)); return true; }
    catch (cause) {
      setError(requestError(cause, "没有成功，请重试"));
      try { onChange(await readRequest(request.id)); } catch { /* 保留当前 */ }
      return false;
    } finally { setBusy(false); }
  };

  return (
    <div className={s.stack}>
      <section className={s.roster} aria-label="接收人">
        <div className={s.rosterHead}>
          <span className={s.fieldName}>接收人</span>
          <b className={s.ratio} data-done={done === request.recipients.length ? "" : undefined}>{done}/{request.recipients.length}</b>
        </div>
        <ul className={s.rosterList}>
          {request.recipients.map((person) => (
            <li key={person.personId} data-status={person.status}>
              <PersonAvatar personId={person.status === "done" ? null : person.personId} className={s.avatar}>{person.status === "done" ? <Check size={12} strokeWidth={3} /> : initial(person.displayName)}</PersonAvatar>
              <span className={s.rosterName}>{person.displayName}</span>
              <span className={s.rosterState}>{person.status === "done" ? monthDayTime(person.doneAt) : "待处理"}</span>
            </li>
          ))}
        </ul>
        {markDone ? <Button variant="primary" className={s.primary} isDisabled={busy} onPress={() => void perform(markDone)}><Check size={16} aria-hidden="true" />标记完成</Button> : null}
      </section>
      {error ? <p className={s.error} role="alert">{error}</p> : null}

      <article className={s.prose} aria-label="说明"><Markdown remarkPlugins={REMARK_PLUGINS}>{request.body}</Markdown></article>

      <QuestionThread request={request} busy={busy} perform={perform} />
      {actionOf(request, "request.ask") ? <AskBox request={request} perform={perform} /> : null}
    </div>
  );
}

export function QuestionThread({ request, busy, perform }: {
  request: TRequestView; busy: boolean; perform: (action: TActionDescriptor | undefined, input?: unknown) => Promise<boolean>;
}) {
  const ref = useRef<HTMLElement>(null);
  // 从「有人提问」的通知点进来（#qa）：直接落到问答区。
  useEffect(() => { if (window.location.hash === "#qa") ref.current?.scrollIntoView({ block: "start" }); }, []);
  if (!request.questions.length) return null;
  const open = request.questions.filter((question) => question.answer === null).length;
  return (
    <section ref={ref} id="qa" className={s.thread} aria-labelledby="request-qa">
      <header className={s.panelHead}>
        <h2 id="request-qa">问答</h2>
        <b className={s.count} data-tone={open ? "wait" : "done"}>{open || request.questions.length}</b>
      </header>
      <ol className={s.threadList}>
        {request.questions.map((question) => (
          <li key={question.id} className={s.qa}>
            <Entry personId={question.askerId} name={question.askerName} at={question.createdAt} tag={question.answer === null ? <span className={s.tag} data-tone="wait">待回答</span> : null}>
              <p>{question.question}</p>
            </Entry>
            {question.answer !== null
              ? <div className={s.answer}><Entry personId={request.initiator.personId} name={request.initiator.displayName} at={question.answeredAt} tag={question.mergedIntoBody ? <span className={s.tag} data-tone="done">已补进说明</span> : null}><p>{question.answer}</p></Entry></div>
              : actionOf(request, "request.answer", question.id)
                ? <AnswerBox request={request} question={question} busy={busy} perform={perform} />
                : null}
          </li>
        ))}
      </ol>
    </section>
  );
}

function Entry({ personId, name, at, tag, children }: { personId: string; name: string; at: string | null; tag?: ReactNode; children: ReactNode }) {
  return (
    <div className={s.entry}>
      <PersonAvatar personId={personId} className={s.avatar}>{initial(name)}</PersonAvatar>
      <div className={s.entryBody}>
        <div className={s.entryMeta}><strong>{name}</strong><time>{monthDayTime(at)}</time>{tag}</div>
        {children}
      </div>
    </div>
  );
}

/** 发起人回答：Agent 先起草填进框里，本人改好点「发出回答」才发。 */
function AnswerBox({ request, question, busy, perform }: {
  request: TRequestView; question: TRequestQuestionView; busy: boolean; perform: (action: TActionDescriptor | undefined, input?: unknown) => Promise<boolean>;
}) {
  const [text, setText] = useState(question.answerDraft ?? "");
  const [steps, setSteps] = useState<TRequestStep[] | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [error, setError] = useState("");
  const draft = async () => {
    setDrafting(true); setError(""); setSteps(runningSteps(ANSWER_STEPS, 1));
    try { const result = await draftAnswer(request.id, question.id); setSteps(result.steps); setText(result.answer); }
    catch (cause) { setSteps(null); setError(requestError(cause, "起草没有成功，请重试或直接写")); }
    finally { setDrafting(false); }
  };
  return (
    <div className={s.reply}>
      {steps ? <RequestSteps steps={steps} label="起草回答的步骤" /> : null}
      <textarea aria-label={`回答${question.askerName}`} rows={2} maxLength={2000} value={text} disabled={busy || drafting} onChange={(event) => setText(event.target.value)} />
      {error ? <p className={s.error} role="alert">{error}</p> : null}
      <div className={s.replyBar}>
        <Button variant="ghost" className={s.ghost} isDisabled={busy || drafting} onPress={() => void draft()}><Sparkles size={15} aria-hidden="true" />{drafting ? "起草中" : "起草"}</Button>
        <Button variant="primary" className={s.primary} isDisabled={busy || drafting || !text.trim()} onPress={() => void perform(actionOf(request, "request.answer", question.id), { answer: text.trim() })}>
          <ArrowUp size={16} aria-hidden="true" />发出回答
        </Button>
      </div>
    </div>
  );
}

/** 接收人提问：定位待办 → 查有没有人问过 → 整理问题 → 等你确认。查到答案就停在第二步。 */
export function AskBox({ request, perform }: { request: TRequestView; perform: (action: TActionDescriptor | undefined, input?: unknown) => Promise<boolean> }) {
  const [text, setText] = useState("");
  const [phase, setPhase] = useState<"idle" | "checking" | "found" | "preview" | "sending">("idle");
  const [result, setResult] = useState<TPrepareRequestQuestionResponse | null>(null);
  const [question, setQuestion] = useState("");
  const [error, setError] = useState("");
  const box = useRef<HTMLElement>(null);
  // 查完把结果和按钮带进视野：找到的答案或待确认的预览就在输入条原位展开。
  useEffect(() => { if (phase === "found" || phase === "preview") box.current?.scrollIntoView({ block: "end", behavior: "smooth" }); }, [phase]);
  const reset = () => { setPhase("idle"); setResult(null); setText(""); setQuestion(""); };
  const check = async () => {
    if (!text.trim()) return;
    setPhase("checking"); setError("");
    setResult({ steps: runningSteps(ASK_STEPS, 1), answer: null, question: text });
    try {
      const prepared = await prepareQuestion(request.id, text.trim());
      setResult(prepared); setQuestion(prepared.question);
      setPhase(prepared.answer ? "found" : "preview");
    } catch (cause) { setPhase("idle"); setResult(null); setError(requestError(cause, "没有查成，请重试")); }
  };
  const send = async () => {
    setPhase("sending");
    if (await perform(actionOf(request, "request.ask"), { question: question.trim() })) reset();
    else setPhase("preview");
  };
  const forceAsk = () => {
    if (!result) return;
    setResult({ ...result, steps: result.steps.map((step, index) => index < 2 ? step : { ...step, status: index === 2 ? "done" : "current" }) });
    setPhase("preview");
  };

  return (
    <section ref={box} className={s.ask} aria-label="提问">
      {phase === "idle" ? (
        <div className={s.askInput}>
          <textarea aria-label={`问${request.initiator.displayName}`} placeholder={`问${request.initiator.displayName}`} rows={1} maxLength={1000} value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void check(); } }} />
          <Button variant="primary" className={s.send} isIconOnly aria-label="提问" isDisabled={!text.trim()} onPress={() => void check()}><ArrowUp size={18} aria-hidden="true" /></Button>
        </div>
      ) : null}
      {error ? <p className={s.error} role="alert">{error}</p> : null}
      {result && phase !== "idle" ? <RequestSteps steps={result.steps} label="提问的步骤" /> : null}
      {phase === "found" && result?.answer ? (
        <div className={s.found}>
          <blockquote>{result.answer.text}</blockquote>
          <div className={s.replyBar}>
            <Button variant="ghost" className={s.ghost} onPress={forceAsk}>仍要问</Button>
            <Button variant="primary" className={s.primary} onPress={reset}><Check size={16} aria-hidden="true" />知道了</Button>
          </div>
        </div>
      ) : null}
      {phase === "preview" || phase === "sending" ? (
        <div className={s.askPreview}>
          <div className={s.askTo}>问 <strong>{request.initiator.displayName}</strong><span>（{request.title}，{monthDayTime(request.sentAt)}）</span></div>
          <textarea aria-label="整理好的问题" rows={2} maxLength={1000} value={question} disabled={phase === "sending"} onChange={(event) => setQuestion(event.target.value)} />
          <div className={s.replyBar}>
            <Button variant="ghost" className={s.ghost} isDisabled={phase === "sending"} onPress={reset}>取消</Button>
            <Button variant="primary" className={s.primary} isDisabled={phase === "sending" || !question.trim()} onPress={() => void send()}><ArrowUp size={16} aria-hidden="true" />发送</Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

