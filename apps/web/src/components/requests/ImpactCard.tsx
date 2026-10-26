"use client";

/**
 * 影响卡（会后推给受影响的人，走送达通道 kind = impact）。参照 Linear 的 Inbox 详情：卡面只说和你有什么关系、要你做什么；
 * 前因后果、原话出处、可以问谁收在下面一块（GitHub 的 details 式折叠）；卡下可以直接追问自己的 Agent，问答留在卡上。
 * 「Agent 代判，Host 尚未确认」与更正都是状态标，不另写解释。
 * 文档变更（⑧）的卡：修订卡「知道了」把依据换到新版；取代卡「切换到新版」或「继续用旧版」（展开到哪天、一句理由），都写回本人的工作依据清单。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, ArrowUpRight, Check, ChevronDown, CircleOff, History, ListTodo, SquareCheck, Target } from "lucide-react";
import { Button } from "ts-design/primitives";
import type { TImpactCardView, TImpactDocTrigger, TImpactTarget, TRequestStep, TRequestView } from "@warmap/contracts";
import { DetailFrame } from "@/components/shell/DetailFrame";
import { useRegisterDetail, useWorkspace } from "@/components/shell/WorkspaceContext";
import { browserApi, type Card } from "@/lib/api/client";
import { DatePicker } from "@/components/ui/DatePicker";
import { companyToday } from "@/components/ui/pickerFormat";
import { monthDayTime } from "@/lib/companyTime";
import { emptySourceContext, sourceTarget } from "@/cards/meetingSources";
import { REQUESTS_CHANGED, RequestApiError, chooseImpactBasis, requestError, runRequestAction } from "./requestApi";
import { RequestSteps, runningSteps } from "./RequestSteps";
import s from "./requests.module.css";
import i from "./impact.module.css";

const NO_CARDS: Card[] = [];
const ASK_STEPS = ["读卡片", "查你手上的事", "回答"];
const TARGET_LABEL: Record<TImpactTarget["type"], string> = { task: "Task", mission: "Mission", acceptance: "验收项" };
const TARGET_ICON = { task: ListTodo, mission: Target, acceptance: SquareCheck } as const;
const changed = () => window.dispatchEvent(new Event(REQUESTS_CHANGED));
const dueLabel = (due: string) => `${Number(due.slice(5, 7))}月${Number(due.slice(8, 10))}日前`;

async function settle<T>(promise: Promise<{ data?: T; response: Response; error?: unknown }>, fallback: string): Promise<T> {
  const result = await promise;
  if (result.response.status === 401) { window.location.assign("/access"); throw new RequestApiError("登录已过期", 401); }
  if (!result.response.ok || !result.data) {
    const failure = result.error as { message?: string; code?: string } | undefined;
    throw new RequestApiError(failure?.message ?? fallback, result.response.status, failure?.code);
  }
  return result.data;
}

export function impactStatus(card: Pick<TImpactCardView, "status" | "basisChoice">, request: Pick<TRequestView, "viewer">): { label: string; tone: "wait" | "done" | "draft" } {
  if (card.status === "irrelevant") return { label: "和我无关", tone: "draft" };
  if (card.basisChoice) return card.basisChoice.choice === "keep" ? { label: `用旧版到 ${dueLabel(card.basisChoice.until ?? "").replace(/前$/, "")}`, tone: "done" } : { label: "已换新版", tone: "done" };
  return request.viewer.myStatus === "done" ? { label: "已知悉", tone: "done" } : { label: "待处理", tone: "wait" };
}

export function ImpactCardScreen({ request: initialRequest, base }: { request: TRequestView; base: string }) {
  const workspace = useWorkspace();
  const [request, setRequest] = useState(initialRequest);
  const [card, setCard] = useState<TImpactCardView | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useRegisterDetail(useMemo(() => ({ scope: "global", label: request.title, mark: null, cards: NO_CARDS }), [request.title]));

  useEffect(() => {
    let alive = true;
    void settle(browserApi.GET("/api/requests/{id}/impact", { params: { path: { id: request.id } } }), "没有读到这张卡")
      .then((data) => { if (alive) { setCard(data.card); changed(); } })
      .catch((cause) => { if (alive) setError(requestError(cause, "没有读到这张卡")); });
    return () => { alive = false; };
  }, [request.id]);

  const markDone = request.actions.find((action) => action.actionType === "request.mark_done");
  const acknowledge = async () => {
    if (!markDone || busy) return;
    setBusy(true); setError("");
    try { setRequest(await runRequestAction(markDone)); }
    catch (cause) { setError(requestError(cause, "没有成功，请重试")); }
    finally { setBusy(false); }
  };
  const irrelevant = async () => {
    if (!card || busy) return;
    setBusy(true); setError("");
    try {
      const next = await settle(browserApi.POST("/api/impact-cards/{id}/irrelevant", { params: { path: { id: card.id } }, body: {} }), "没有成功，请重试");
      setCard(next.card);
      setRequest({ ...request, actions: [], viewer: { ...request.viewer, myStatus: "done" } });
      changed();
      workspace.showToast("已记下：和我无关");
    } catch (cause) { setError(requestError(cause, "没有成功，请重试")); }
    finally { setBusy(false); }
  };

  const doc = card?.trigger.kind === "doc_change" ? card.trigger : null;
  const choose = async (body: { choice: "switch" } | { choice: "keep"; until: string; reason: string }) => {
    if (!card || busy) return;
    setBusy(true); setError("");
    try {
      setCard(await chooseImpactBasis(card.id, body));
      setRequest({ ...request, actions: [], viewer: { ...request.viewer, myStatus: "done" } });
    } catch (cause) { setError(requestError(cause, "没有成功，请重试")); }
    finally { setBusy(false); }
  };
  const status = card ? impactStatus(card, request) : null;
  const subtitle = !card ? "" : card.trigger.kind === "doc_change"
    ? `文档变更 · ${card.trigger.newDoc.title} · ${monthDayTime(request.sentAt)}`
    : `会后影响 · ${card.trigger.meetingTitle} · ${monthDayTime(request.sentAt)}`;
  return (
    <div className={s.screen}>
      <DetailFrame title={request.title} subtitle={subtitle} onBack={() => workspace.close()}
        actions={status ? <span className={`${s.chip} ${s.headerChip}`} data-tone={status.tone}>{status.label}</span> : undefined}>
        <div className={s.content}>
          <div className={s.stack}>
            {error ? <p className={s.error} role="alert">{error}</p> : null}
            {card ? (
              <>
                <ImpactFace card={card} actions={card.status === "irrelevant" ? null : doc ? (
                  <DocChoice card={card} trigger={doc} busy={busy} onChoose={(body) => void choose(body)}
                    irrelevant={card.status === "delivered" && !card.basisChoice ? () => void irrelevant() : undefined} />
                ) : (
                  <>
                    {markDone ? <Button variant="primary" className={s.primary} isDisabled={busy} onPress={() => void acknowledge()}><Check size={16} aria-hidden="true" />{markDone.label}</Button> : null}
                    {card.status === "delivered" ? <Button variant="ghost" className={s.ghost} isDisabled={busy} onPress={() => void irrelevant()}><CircleOff size={15} aria-hidden="true" />和我无关</Button> : null}
                  </>
                )} />
                <ImpactContext card={card} base={base} />
                <ImpactQuestions card={card} onCard={setCard} />
              </>
            ) : !error ? <div className={i.skeleton} aria-busy="true" aria-label="读取中" /> : null}
          </div>
        </div>
      </DetailFrame>
    </div>
  );
}

/** 卡面：影响一段、要做什么一行、落到的对象一排；状态标在最上面。 */
export function ImpactFace({ card, actions }: { card: TImpactCardView; actions?: React.ReactNode }) {
  const flags = [
    card.agentJudged ? <span key="agent" className={i.flag} data-tone="agent">Agent 代判，Host 尚未确认</span> : null,
    card.correction ? <span key="fix" className={i.flag} data-tone="fix">更正</span> : null,
    card.superseded ? <span key="old" className={i.flag}>已有更正</span> : null,
  ].filter(Boolean);
  return (
    <article className={i.face} data-superseded={card.superseded || undefined} aria-label="影响">
      {flags.length ? <div className={i.flags}>{flags}</div> : null}
      {card.correction ? <p className={i.correction}>{card.correction.note}</p> : null}
      <p className={i.impact}>{card.impact}</p>
      <div className={i.action} data-kind={card.action.kind}>
        <span className={i.actionLabel}>{card.action.kind === "do" ? "要做" : "知悉即可"}</span>
        <span className={i.actionText}>{card.action.kind === "do" ? card.action.text : card.action.text.replace(/^知悉即可[，。,.\s]*/, "") || null}</span>
        {card.action.due ? <time className={i.due} dateTime={card.action.due}>{dueLabel(card.action.due)}</time> : null}
      </div>
      {card.targets.length ? (
        <ul className={i.targets} aria-label="落到">
          {card.targets.map((target) => {
            const Icon = TARGET_ICON[target.type];
            return (
              <li key={`${target.type}:${target.id}:${target.index ?? ""}`} className={i.target}>
                <Icon size={14} aria-hidden="true" />
                <span className={i.targetKind}>{TARGET_LABEL[target.type]}</span>
                <span className={i.targetTitle}>{target.title}</span>
              </li>
            );
          })}
        </ul>
      ) : null}
      {actions ? <footer className={i.faceBar}>{actions}</footer> : null}
    </article>
  );
}

/**
 * 文档变更卡的处理键：修订「知道了」；取代「切换到新版」或「继续用旧版」，后者在卡下展开到哪天和一句理由（参照 GitHub 的 review 提交：选项和输入在同一处）。
 * 选过之后换成一行结果。
 */
function DocChoice({ card, trigger, busy, onChoose, irrelevant }: {
  card: TImpactCardView; trigger: TImpactDocTrigger; busy: boolean;
  onChoose: (body: { choice: "switch" } | { choice: "keep"; until: string; reason: string }) => void; irrelevant?: () => void;
}) {
  const [keeping, setKeeping] = useState(false);
  const [until, setUntil] = useState(trigger.transitionUntil ?? "");
  const [reason, setReason] = useState("");
  if (card.basisChoice) {
    return (
      <span className={i.choice} data-choice={card.basisChoice.choice}>
        {card.basisChoice.choice === "keep" ? <History size={15} aria-hidden="true" /> : <Check size={15} aria-hidden="true" />}
        {card.basisChoice.choice === "keep" ? `用旧版到 ${dueLabel(card.basisChoice.until ?? "").replace(/前$/, "")}` : "已换到新版"}
        {card.basisChoice.reason ? <small>{card.basisChoice.reason}</small> : null}
      </span>
    );
  }
  const ghostIrrelevant = irrelevant ? <Button variant="ghost" className={s.ghost} isDisabled={busy} onPress={irrelevant}><CircleOff size={15} aria-hidden="true" />和我无关</Button> : null;
  if (trigger.relation === "revision") {
    return <>{ghostIrrelevant}<Button variant="primary" className={s.primary} isDisabled={busy} onPress={() => onChoose({ choice: "switch" })}><Check size={16} aria-hidden="true" />知道了</Button></>;
  }
  return (
    <>
      {keeping ? (
        <div className={i.keep}>
          <label className={i.keepField}><span className={s.fieldName}>用到</span>
            <DatePicker label="用旧版到" size="compact" value={until} min={companyToday()} onChange={setUntil} /></label>
          <input className={i.keepReason} aria-label="理由" placeholder="理由" maxLength={200} value={reason} disabled={busy} onChange={(event) => setReason(event.target.value)} />
          <Button variant="ghost" className={s.ghost} isDisabled={busy} onPress={() => setKeeping(false)}>取消</Button>
          <Button variant="primary" className={s.primary} isDisabled={busy || !until || !reason.trim()} onPress={() => onChoose({ choice: "keep", until, reason: reason.trim() })}>
            <Check size={16} aria-hidden="true" />确定
          </Button>
        </div>
      ) : (
        <>
          {ghostIrrelevant}
          <Button variant="ghost" className={s.ghost} isDisabled={busy} onPress={() => setKeeping(true)}><History size={15} aria-hidden="true" />继续用旧版</Button>
          <Button variant="primary" className={s.primary} isDisabled={busy} onPress={() => onChoose({ choice: "switch" })}><Check size={16} aria-hidden="true" />切换到新版</Button>
        </>
      )}
    </>
  );
}

const DocTitle = ({ title, url }: { title: string; url: string | null }) => url
  ? <a className={i.docLink} href={url} target="_blank" rel="noreferrer">{title}<ArrowUpRight size={13} aria-hidden="true" /></a> : <>{title}</>;

/** 文档变更：新旧两份、谁发布谁确认、生效与过渡期。 */
function DocFacts({ trigger }: { trigger: TImpactDocTrigger }) {
  const day = (value: string | null) => value ? dueLabel(value).replace(/前$/, "") : null;
  const version = trigger.oldDoc.revision ?? (trigger.oldDoc.revisedAt ? `${monthDayTime(trigger.oldDoc.revisedAt).split(" ")[0]} 的版本` : null);
  const rows: [string, React.ReactNode][] = [
    [trigger.relation === "revision" ? "新版本" : "新文档", <DocTitle key="new" title={trigger.newDoc.title} url={trigger.newDoc.url} />],
    ["你依据的", <><DocTitle key="old" title={trigger.oldDoc.title} url={trigger.oldDoc.url} />{version ? <span className={i.factNote}>{version}</span> : null}</>],
    ["发布", trigger.authorName],
    ...(trigger.decidedByName !== trigger.authorName ? [["确认", trigger.decidedByName] as [string, React.ReactNode]] : []),
    ...(day(trigger.effectiveOn) ? [["生效", day(trigger.effectiveOn)] as [string, React.ReactNode]] : []),
    ...(day(trigger.transitionUntil) ? [["过渡期到", day(trigger.transitionUntil)] as [string, React.ReactNode]] : []),
    ...(trigger.keepExisting === null ? [] : [["已有工作", trigger.keepExisting ? "沿用旧版" : "换成新版"] as [string, React.ReactNode]]),
  ];
  return <dl className={i.facts}>{rows.map(([term, value]) => <div key={term}><dt>{term}</dt><dd>{value}</dd></div>)}</dl>;
}

/** 点开：前因后果、会上定了什么（或文档怎么变了）、原话出处、可以问谁。 */
function ImpactContext({ card, base }: { card: TImpactCardView; base: string }) {
  const workspace = useWorkspace();
  const trigger = card.trigger;
  const decidedBy = trigger.kind === "doc_change" ? "" : trigger.decidedBy === "ceo" ? "CEO 确认" : trigger.decidedBy === "agent" ? "Agent 代判" : "主持人确认";
  const prompt = trigger.kind === "doc_change" ? `关于《${trigger.newDoc.title}》：` : `关于会上定的「${trigger.statement}」：`;
  return (
    <details className={i.more}>
      <summary><span>前因后果</span><ChevronDown size={16} aria-hidden="true" /></summary>
      <div className={i.moreBody}>
        {card.why ? <p className={i.why}>{card.why}</p> : null}
        {trigger.kind === "doc_change" ? <DocFacts trigger={trigger} /> : (
          <dl className={i.facts}>
            <div><dt>会上定了</dt><dd>{trigger.statement}</dd></div>
            <div><dt>拍板</dt><dd>{decidedBy}</dd></div>
            <div><dt>会议</dt><dd>{trigger.meetingTitle}</dd></div>
          </dl>
        )}
        {card.sources.map((source) => <ImpactQuote key={`${source.turnId}:${source.quote}`} source={source} base={base} onNavigate={workspace.navigate} />)}
        {card.askWho.length ? (
          <div className={i.askWho}>
            <span className={s.fieldName}>可以问</span>
            {card.askWho.map((person) => (
              <button key={person.personId} type="button" className={s.personChip} aria-pressed="false"
                onClick={(event) => workspace.navigate(`${base}/new?prompt=${encodeURIComponent(prompt)}`, event.currentTarget)}>
                <span className={s.avatar} aria-hidden="true">{person.displayName.trim().slice(-1)}</span>
                {person.displayName}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </details>
  );
}

/** 原话：带发言段的点下去打开那场会的逐字稿，定位到这一段（成员走 /me/meetings）。 */
export function ImpactQuote({ source, base, onNavigate }: {
  source: TImpactCardView["sources"][number]; base: string; onNavigate: (href: string, origin?: Element | null) => void;
}) {
  const target = source.turnId ? sourceTarget(`transcript:${source.meetingId}#${source.turnId}`, emptySourceContext()) : null;
  const href = target?.type === "route" ? `${base.startsWith("/me/") ? "/me" : ""}${target.href}` : null;
  return (
    <figure className={i.quote}>
      {href ? (
        <a className={i.quoteLink} href={href} onClick={(event) => { event.preventDefault(); onNavigate(href, event.currentTarget); }}>
          <blockquote>{source.quote}</blockquote>
        </a>
      ) : <blockquote>{source.quote}</blockquote>}
      <figcaption>{[source.speakerName, source.at ? monthDayTime(source.at) : null].filter(Boolean).join(" · ")}</figcaption>
    </figure>
  );
}

/** 卡下追问：自己的 Agent 回答（读卡片 → 查你手上的事 → 回答），问答留在卡上。 */
function ImpactQuestions({ card, onCard }: { card: TImpactCardView; onCard: (card: TImpactCardView) => void }) {
  const [text, setText] = useState("");
  const [steps, setSteps] = useState<TRequestStep[] | null>(null);
  const [error, setError] = useState("");
  const end = useRef<HTMLDivElement>(null);
  const asking = steps !== null && steps.some((step) => step.status === "current");
  const ask = useCallback(async () => {
    const question = text.trim();
    if (!question || asking) return;
    setError(""); setSteps(runningSteps(ASK_STEPS, 0));
    try {
      const result = await settle(browserApi.POST("/api/impact-cards/{id}/ask", { params: { path: { id: card.id } }, body: { question } }), "没有答出来，请重试");
      onCard(result.card); setSteps(result.steps); setText("");
      requestAnimationFrame(() => end.current?.scrollIntoView({ block: "end", behavior: "smooth" }));
    } catch (cause) { setSteps(null); setError(requestError(cause, "没有答出来，请重试")); }
  }, [text, asking, card.id, onCard]);

  return (
    <section className={s.thread} aria-label="追问">
      {card.questions.length ? (
        <ol className={s.threadList}>
          {card.questions.map((item) => (
            <li key={item.id} className={s.qa}>
              <div className={s.entry}><span className={s.avatar} aria-hidden="true">我</span><div className={s.entryBody}><div className={s.entryMeta}><strong>我</strong><time>{monthDayTime(item.createdAt)}</time></div><p>{item.question}</p></div></div>
              {item.answer ? <div className={s.answer}><div className={s.entry}><span className={`${s.avatar} ${i.agentAvatar}`} aria-hidden="true">A</span><div className={s.entryBody}><div className={s.entryMeta}><strong>我的 Agent</strong></div><p>{item.answer}</p></div></div></div> : null}
            </li>
          ))}
        </ol>
      ) : null}
      {steps && asking ? <RequestSteps steps={steps} label="追问的步骤" /> : null}
      <div className={s.askInput}>
        <textarea aria-label="追问" placeholder="追问" rows={1} maxLength={1000} value={text} disabled={asking}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void ask(); } }} />
        <Button variant="primary" className={s.send} isIconOnly aria-label="发送追问" isDisabled={!text.trim() || asking} onPress={() => void ask()}><ArrowUp size={18} aria-hidden="true" /></Button>
      </div>
      {error ? <p className={s.error} role="alert">{error}</p> : null}
      <div ref={end} />
    </section>
  );
}
