"use client";

/**
 * 调研专题页（/me/topics/[id]，第 9 节，原型 v8.4 专题子会话）：左边和本机的 Claude Code 对话，右边当前一版（Markdown），可切到以前的版本，
 * 「存进飞书」「放进下一版」。先出提纲：提纲那一版下面有「按这个提纲写」。
 * 有了正文以后能开「评审会」（第 19.1、19.6 节）：选 2–3 个挑刺的岗位，本机并行挑刺、合成一份，存成「评审」那一版，按「分歧和建议」排版。
 * 版本由本机经同步报到云端；对话全文只在本机。手机和别的电脑上只能看版本。
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import Markdown from "react-markdown";
import { ChevronLeft, Info } from "lucide-react";
import type { TLocalQuestionAnswerRequest, TTopicDetailResponse, TTopicVersionView } from "@warmap/contracts";
import { HeroButton } from "@/components/HeroButton";
import { useHandheld } from "@/components/ui/useHandheld";
import { StartDialog } from "@/components/local/StartDialog";
import { showWorkspaceToast } from "@/lib/toast";
import { SessionComposer, SessionTranscript, useSessionSend, useSessionModels, useModelChangedRefresh, sessionEnded, type DecideOptions } from "@/components/cards/SessionTranscript";
import { stateChip } from "@/components/cards/CardSession";
import { ApprovalDecision, QuestionDecision, awayChip } from "@/components/work/decisions";
import { DecisionBox, FailedLine, PendingBoxes, PendingDock } from "@/components/work/DecisionBox";
import { ATTENTION_LABEL, attentionOf, viewAsk, type Attention } from "@/lib/home/attention";
import { useViewChrome } from "@/components/home/view";
import { SideContent, useSideDetail } from "@/components/home/SideDetail";
import { ICON } from "@/components/home/StateIcon";
import { useConversationScroll } from "@/conversation/useConversationScroll";
import { latestSessionFor, useLocalRunner } from "@/lib/local/LocalRunnerProvider";
import { useSessionEvents } from "@/lib/local/useSessionEvents";
import { useSessionMode } from "@/components/cards/PermissionMode";
import { HARNESS_NAME, defaultSourceLabel, runLabel, sessionModelText } from "@/lib/local/runModel";
import { placeText, shortPlace } from "@/lib/work/merge";
import { contextUsage, localWait, running } from "@/lib/local/sessionView";
import { startTopic } from "@/lib/local/start";
import { WAIT_LABEL, canCommand, waitTone } from "@/lib/board/cards";
import { addTopicVersionToPending, patchTopic, readTopic, readTopicVersion } from "@/lib/board/cloud";
import { REMARK_PLUGINS } from "@/lib/markdown";
import { ReviewDialog, ReviewDoc, isReview, reviewText } from "./Review";
import s from "@/styles/v2-session.module.css";

/**
 * embedded：放在新首页的展示区里——没有返回键。页头右边的信息图标：桌面上在右栏打开当前版本，对话留着；手机上照旧在「对话」和「当前版本」之间切。
 * waiting：首页数据里这个专题在等什么（左栏的点用的那一份）；页头标签和钉在输入框上方的框从它和本机事件流算（第 54 条，同卡的子会话）。
 */
export function TopicSession({ topicId, embedded = false, waiting = null }: { topicId: string; embedded?: boolean; waiting?: Attention | null }) {
  const chrome = useViewChrome();
  const [reading, setReading] = useState(false);
  const side = useSideDetail();
  const local = useLocalRunner();
  const handheld = useHandheld();
  const scroll = useConversationScroll({ streaming: false, resetKey: topicId });
  const [detail, setDetail] = useState<TTopicDetailResponse | null>(null);
  const [missing, setMissing] = useState(false);
  const [picked, setPicked] = useState<number | null>(null);
  const [version, setVersion] = useState<TTopicVersionView | null>(null);
  const [starting, setStarting] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const load = useCallback(async () => {
    try {
      const data = await readTopic(topicId);
      if (data) setDetail(data); else setMissing(true);
    } catch { /* 留着上次的 */ }
  }, [topicId]);
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, 8000);
    return () => window.clearInterval(timer);
  }, [load]);
  // 切到以前的版本：按号取正文；最新一版就用详情里带的。
  useEffect(() => {
    if (picked === null || !detail || picked === detail.current?.number) { setVersion(null); return; }
    let alive = true;
    void readTopicVersion(topicId, picked).then((value) => { if (alive) setVersion(value); }).catch(() => undefined);
    return () => { alive = false; };
  }, [picked, detail, topicId]);

  const ready = local.phase === "ready";
  const session = ready ? latestSessionFor(local.sessions, { topicId }) : null;
  // 刚建的专题（?start=1）：本机连着、还没开过，就直接弹出「开始」。
  const [autoStart, setAutoStart] = useState(false);
  useEffect(() => { setAutoStart(new URLSearchParams(window.location.search).get("start") === "1"); }, []);
  useEffect(() => {
    if (!autoStart || !ready || !detail || session) return;
    setAutoStart(false);
    setStarting(true);
    window.history.replaceState(null, "", window.location.pathname);
  }, [autoStart, ready, detail, session]);
  const { view, draft, drafted } = useSessionEvents(local.runner, session?.id ?? null, { drafts: true });
  useModelChangedRefresh(view.entries, local.refresh);
  const canAct = canCommand({ ready, handheld, hasSession: !!session });
  const mode = useSessionMode(local.runner, session, view);
  const models = useSessionModels(local.runner, local.models, session, local.refresh, () => showWorkspaceToast({ text: "没换成" }), local.status, local.sources !== null);
  // 说一句：一按就先画出来（useSessionSend）。
  const send = useSessionSend(local.runner, session?.id ?? null, view, { kind: "topic", id: topicId });
  // 没成的不弹 toast：发消息交给输入框，批准、回答交给选项框，这页的按钮后面各自写「失败 · 重试」。
  const [failed, setFailed] = useState<{ at: "doc" | "head"; retry: () => void; reason: string } | null>(null);
  const act = (at: "doc" | "head", action: () => Promise<unknown>) => { setFailed(null); action().catch((error: unknown) => setFailed({ at, retry: () => act(at, action), reason: error instanceof Error ? error.message : "" })); };

  if (missing) return <div className={s.gone}><p>没有这个专题</p><Link href="/me/work">回到首页</Link></div>;
  if (!detail) return <div className={s.page} aria-busy />;

  const { topic } = detail;
  const shown = version ?? detail.current;
  const hasDraft = detail.versions.some((entry) => entry.kind === "draft");
  const wait = session ? localWait(view) : null;
  const status = view.status ?? session?.status ?? null;
  const ended = !!session && sessionEnded(status);
  const device = topic.run?.deviceName ?? detail.runs[0]?.deviceName ?? null;
  const say = send.say;
  const decide = async (requestId: string, decision: "allow" | "deny", { forSession, message }: DecideOptions) => {
    if (!session) return;
    await local.runner.decidePermission(session.id, requestId, { decision, ...(forSession ? { allowForSession: true } : {}), ...(message ? { message } : {}) });
    scroll.jumpToLatest();
  };
  // Claude Code 在问本人：选项框放在对话最后。连上事件流以后只认事件流（答过、作废了就是没有），还没连上时照会话摘要。
  const question = session ? (view.lastSeq ? view.question : session.pendingQuestion ?? null) : null;
  const answer = async (body: TLocalQuestionAnswerRequest) => {
    if (!session || !question) return;
    await local.runner.answerQuestion(session.id, question.requestId, body);
    await local.refresh();
    scroll.jumpToLatest();
  };
  const asking = !question ? null : <QuestionDecision key={question.requestId} request={question} blocked={canAct ? null : awayChip(device)} expired={ended} onAnswer={answer} />;
  // 新首页里等本人处理的框（批准、提问）钉在输入框上方（第 54 条），和项目对话那份是同一个本机请求，答一处两处都收起。
  const attention = attentionOf(waiting, session ? viewAsk(view, session) : null);
  const away = canAct ? null : awayChip(device);
  const placeholder = (kind: "approval" | "question") => <DecisionBox kind={kind} title={ATTENTION_LABEL[kind]} options={[]} onPick={() => undefined} blocked={away ?? awayChip(device)} />;
  const pinned = !embedded ? null
    : attention === "approval" ? (view.lastSeq && view.pending.length
      ? <ApprovalDecision requests={view.pending} blocked={away} inWorktree={session?.workspace?.kind === "worktree"} onDecide={(request, decision, options) => decide(request.requestId, decision, options)} />
      : placeholder("approval"))
    : attention === "question" ? asking ?? placeholder("question") : null;
  const toPending = async () => {
    if (!shown || !topic.planTaskId) return;
    await addTopicVersionToPending(topic.planTaskId, shown.id);
    void load();
  };
  const archive = async () => {
    await patchTopic(topic.id, { status: topic.status === "archived" ? "active" : "archived" });
    void load();
  };

  const doc = (
    <aside className={s.pane} data-reading aria-label="当前版本">
      <div className={s.docHead}>
        <b>{topic.title}</b>
        {shown ? <small>{shown.label}</small> : null}
        <span className={s.grow} />
        {hasDraft && canAct ? <HeroButton variant={embedded ? "ghost" : "secondary"} size="sm" onPress={() => setReviewing(true)}>评审会</HeroButton> : null}
        {shown?.feishuUrl ? <a href={shown.feishuUrl} target="_blank" rel="noopener noreferrer" className={embedded ? s.stateChip : s.tag} data-tone={embedded ? "neutral" : "done"}>已存进飞书</a>
          : shown && canAct ? <HeroButton variant={embedded ? "ghost" : "secondary"} size="sm" onPress={() => act("doc", () => say(`把「${shown.label}」存进飞书，存好把地址交回来。`))}>存进飞书</HeroButton> : null}
        {shown && topic.planTaskId && !handheld ? (shown.deliverable ? <span className={embedded ? s.stateChip : s.tag} data-tone={embedded ? "neutral" : "ver"}>{shown.deliverable.state === "included" ? `已纳入 v${shown.deliverable.versionNumber}` : `v${shown.deliverable.versionNumber} 准备中`}</span>
          : <HeroButton variant="ghost" size="sm" onPress={() => act("doc", toPending)}>放进下一版</HeroButton>) : null}
        {failed?.at === "doc" ? <FailedLine inline reason={failed.reason} onRetry={failed.retry} /> : null}
      </div>
      {detail.versions.length > 1 ? (
        <div className={s.versions} role="tablist" aria-label="版本">
          {detail.versions.map((entry) => (
            <button key={entry.id} type="button" role="tab" aria-selected={(shown?.number ?? null) === entry.number} onClick={() => setPicked(entry.number)}>{entry.label}</button>
          ))}
        </div>
      ) : null}
      {shown ? (
        <>
          {shown.note ? <p className={s.note}>{shown.note}</p> : null}
          {isReview(shown) ? <ReviewDoc body={shown.body} /> : <article className={s.doc} data-outline={shown.kind === "outline" || undefined}><Markdown remarkPlugins={REMARK_PLUGINS}>{shown.body}</Markdown></article>}
          {shown.kind === "outline" && shown.number === detail.current?.number && canAct ? <div className={s.actions}><HeroButton variant="primary" size="sm" onPress={() => void say("按这个提纲写。")}>按这个提纲写</HeroButton></div> : null}
        </>
      ) : embedded ? null : <p className={s.faint}>还没有版本</p>}
    </aside>
  );

  const state = wait ? <span className={s.tag} data-tone={waitTone(wait)}>{WAIT_LABEL[wait]}</span> : <span className={s.tag} data-tone={topic.status === "archived" ? undefined : "ver"}>{topic.status === "archived" ? "已归档" : "进行中"}</span>;
  // 输入框下面一行的右边写「执行方 · 模型」（21 条），来源在悬停里；没有时退回「来源 · 模型」、再退回云端记的。文件夹在左边。
  const model = (session ? sessionModelText(session, local.models.find((entry) => entry.id === session.modelProfileId)?.efforts, defaultSourceLabel(local.models)) : null) ?? ((label) => (label ? { label, title: null } : null))(runLabel(session?.run) ?? topic.run?.modelLabel ?? null);
  const place = session?.workspace ? { name: shortPlace(session.workspace), title: placeText(session.workspace) } : null;
  const chat = (
    <PendingBoxes>
      <div className={s.chat}>
        <div className={s.scroll} ref={scroll.scrollRef}>
          <div ref={scroll.contentRef}>
            {session ? <SessionTranscript entries={send.entries} agentName={HARNESS_NAME[session.agent]} canAct={canAct} onResend={(entry) => void say(entry.text).catch(() => showWorkspaceToast({ text: "没发出去" }))} onRetry={send.retry} draft={draft} drafted={drafted} device={device} live={running(status)} starting={status === "starting"} ended={ended} pinned={embedded} onDecide={(request, decision, options) => decide(request.requestId, decision, options)} tail={embedded ? null : asking} asking={question} />
              : <div className={s.feed}><span className={s.evt}>{topic.title}</span>
                  {ready && topic.status === "active" && !embedded ? <div className={s.actions}><HeroButton variant="primary" size="sm" onPress={() => setStarting(true)}>开始</HeroButton></div> : null}
                </div>}
          </div>
          <div ref={scroll.reserveRef} aria-hidden />
        </div>
        {session || !embedded
          ? <SessionComposer label={`给${topic.title}插话`} disabled={!canAct} onSend={say} mode={mode} context={contextUsage(view.context ?? session?.context)} subject={{ kind: "topic", id: topic.id }} place={place} model={model ? { label: model.label, title: model.title ?? undefined } : null}
            models={models} pinned={pinned}
            busy={running(status)} onStop={() => void local.runner.interrupt(session!.id).then(() => local.refresh()).catch(() => showWorkspaceToast({ text: "没停下" }))} dock={<PendingDock above latest={{ visible: !scroll.atBottom, jump: scroll.jumpToLatest }} />} />
          : <div className={s.composerDock}>{pinned ? <div className={s.pinned} data-testid="pinned">{pinned}</div> : null}<PendingDock above latest={{ visible: !scroll.atBottom, jump: scroll.jumpToLatest }} /></div>}
      </div>
    </PendingBoxes>
  );
  const dialogs = <>
    {reviewing ? <ReviewDialog onClose={() => setReviewing(false)} onStart={async (critics) => {
      if (!session) return;
      await local.runner.sendMessage(session.id, reviewText(critics), "review");
      setReviewing(false);
    }} /> : null}
    {starting ? <StartDialog title={topic.title} needsFolder={false} onClose={() => setStarting(false)} onStart={async (model, _folder, _role, effort) => {
      await startTopic(local.runner, topic, model, undefined, undefined, effort);
      setStarting(false);
      await local.refresh();
    }} /> : null}
  </>;
  // 新首页的展示区：一行页头（名字、状态、文档图标），下面是对话；点文档图标换成当前版本（手机上默认看文档）。
  if (embedded) {
    const showDoc = side ? side.open : reading || (handheld && !session);
    // 页头的状态 chip（5.4.3）：中性、警告、等你（中性底加圆点）；不在这台电脑上又在等你时写「等你 · {电脑名}」。
    const chipOf = attention || wait ? stateChip(attention, wait, "doing", !canAct && device ? awayChip(device) : null) : { text: topic.status === "archived" ? "已归档" : "进行中", tone: "neutral" as const };
    return (
      <div className={s.page} data-embedded="" data-testid="topic-session">
        <header className={s.embedHead}>
          {chrome.lead}
          <b className={s.embedTitle}>{chrome.parent}{chrome.letter}<span className={s.embedName}>{topic.title}</span></b>
          <span className={s.stateChip} data-tone={chipOf.tone}>{chipOf.tone === "wait" ? <i aria-hidden /> : null}{chipOf.text}</span>
          <span className={s.exec} />
          <HeroButton variant="ghost" size="sm" isIconOnly aria-label="当前版本" title="当前版本" data-pressed={showDoc || undefined} onPress={() => (side ? side.toggle() : setReading(!showDoc))} data-testid="session-details"><Info {...ICON} aria-hidden /></HeroButton>
          {chrome.trail}
        </header>
        <div className={s.body} data-solo="">{showDoc && !side ? <div className={s.paneScroll}>{doc}</div> : chat}</div>
        {side ? <SideContent side={side}><div className={s.page} data-embedded="" data-side="">{doc}</div></SideContent> : null}
        {dialogs}
      </div>
    );
  }
  return (
    <div className={s.page} data-testid="topic-session">
      <header className={s.head}>
        <Link href="/me/work" className={s.back}><ChevronLeft size={14} aria-hidden />{handheld ? null : "返回"}</Link>
        <div className={s.title}>
          <span className={s.kind} data-kind="topic">专题</span>
          <b>{topic.title}</b>
          {state}
        </div>
        <div className={s.exec}>
          {detail.task ? <Link href={`/me/work/tasks/${encodeURIComponent(detail.task.taskId)}`} className={s.link}>{detail.task.name}</Link> : null}
          {!handheld ? <HeroButton variant="ghost" size="sm" onPress={() => act("head", archive)}>{topic.status === "archived" ? "取消归档" : "归档"}</HeroButton> : null}
          {failed?.at === "head" ? <FailedLine inline reason={failed.reason} onRetry={failed.retry} /> : null}
        </div>
      </header>
      {handheld ? <div className={s.body} data-solo>{doc}</div> : (
        <div className={s.body}>
          {chat}
          {doc}
        </div>
      )}
      {dialogs}
    </div>
  );
}
