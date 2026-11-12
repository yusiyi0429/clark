"use client";

/**
 * 卡的子会话页（/me/cards/[id]，原型 v8.4 renderSess + cardPane，第 11.1 节）：左边和执行方对话（本机实时），右边结果。
 * 右边从上到下：交代（所属 Task、对的那条标准、岗位和模型）、计划条目、完成标准、Agent 验收、产出、动作。卡上写岗位名，不写执行方（第 19.6 节）。
 * 只有这台电脑上的本机程序在跑这张卡、而且不是手机时，才能开始、插话、停止、批权限；别处只看云端同步来的摘要。
 * 手机上分「结果」「对话」两个标签。
 */
import type { TLocalChangedFile } from "@warmap/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Check, ChevronLeft, Info, X } from "lucide-react";
import type { TCardHandbackView, TLocalQuestionAnswerRequest, TLocalRunView } from "@warmap/contracts";
import { HeroButton } from "@/components/HeroButton";
import { useHandheld } from "@/components/ui/useHandheld";
import { StartDialog } from "@/components/local/StartDialog";
import { latestSessionFor, useLocalRunner } from "@/lib/local/LocalRunnerProvider";
import { useSessionEvents } from "@/lib/local/useSessionEvents";
import { contextUsage, localWait, planStep, running, type SessionView } from "@/lib/local/sessionView";
import { startCard } from "@/lib/local/start";
import { STAGES, WAIT_LABEL, boardCards, canCommand, circled, deliverableLabel, isAgentCard, waitTone, type CardStage, type CardWait } from "@/lib/board/cards";
import { CloudError, overrule, relayHandback, retryAcceptance } from "@/lib/board/cloud";
import { cardRole } from "@/lib/team/roles";
import { useAutoReturn } from "@/lib/board/useAutoReturn";
import { showWorkspaceToast } from "@/lib/toast";
import { SessionComposer, SessionTranscript, useSessionSend, useSessionModels, useModelChangedRefresh, sessionEnded, type DecideOptions } from "./SessionTranscript";
import { useSessionMode } from "./PermissionMode";
import { FilePreview, cloudOutputFile, localChangedFile, type PreviewFile } from "./FilePreview";
import { filesRestored, filesSignal, matchChangedFile, useSessionFiles } from "@/lib/local/sessionFiles";
import { ChangedFiles } from "./ChangedFiles";
import { TurnFilesContext, turnFilesView } from "./TurnFiles";
import { HARNESS_NAME, runLabel, sessionModelText } from "@/lib/local/runModel";
import { useCardDetail, type CardDetail } from "./useCardDetail";
import { SourceWordIssues, SourceWords } from "./SourceWords";
import { MergeAction } from "@/components/work/MergeAction";
import { ApprovalDecision, QuestionDecision, awayChip } from "@/components/work/decisions";
import { HandbackDecision, MergeDecision, handbackTitle, useRelayNow } from "@/components/home/TaskDecisions";
import { ATTENTION_LABEL, attentionOf, isMergeLater, viewAsk, type Attention } from "@/lib/home/attention";
import { DecisionBox, FailedLine, PendingBoxes, PendingDock, failureOf, type Failure } from "@/components/work/DecisionBox";
import { useViewChrome } from "@/components/home/view";
import { SideContent, useSideDetail } from "@/components/home/SideDetail";
import { ICON } from "@/components/home/StateIcon";
import { useConversationScroll } from "@/conversation/useConversationScroll";
import { commitText, placeText, shortPlace } from "@/lib/work/merge";
import type { LocalRunner, TLocalSessionSummary } from "@/lib/local/runner";
import s from "@/styles/v2-session.module.css";
import { PlanChecklist } from "./PlanChecklist";
import { AgreementSection, ProposalDecision } from "./Agreement";

/** 回到新首页，锚着这张卡的 Task（V2 设计第 20.4 节；没打开新首页的人会被带回老首页）。 */
const workHref = (taskId: string | null) => (taskId ? `/me/work/tasks/${encodeURIComponent(taskId)}` : "/me/work");

const VERDICT: Record<string, string> = { met: "达到", partial: "部分达到", unmet: "未达到", needs_person: "要你补" };
const money = (usd: number | null) => (usd === null ? null : `约 $${usd.toFixed(usd < 1 ? 3 : 2)}`);

/** 手机上（没有右栏）没选过看哪边时：不在这台电脑上先看摘要；有等你处理的框（受阻、等你补、提议）先看对话，框钉在下面。 */
export const paneFirst = (hasSession: boolean, hasBox: boolean) => !hasSession && !hasBox;

/**
 * 新首页页头的状态 chip（5.4.3「状态 chip」、5.6 状态词）：中性、警告、等你（中性底加强调色圆点）三档；新首页不用成功色。
 * 「等你」档只给等本人处理的框（attention，第 54 条，和左栏的点同一个来源）：等你批准、在问你、等你拿主意、等你合回；
 * 批准、提问不在这台电脑上时写「等你 · {电脑名}」（away）。首页数据里它在排队时照写排队的状态词（queued，「已排队 · 等 B」，第 68 条）。
 * 别的照会话和阶段：做完一轮（等本人下一句，和项目动态那行报告同一个说法）、已停下（本人停的、强停、本机程序重启打断）、受阻（不是验收没过的）、重做中、已排队、进行中…。
 */
export function stateChip(attention: Attention | null, rest: CardWait | null, stage: CardStage, away: string | null, queued: string | null = null): { text: string; tone: "neutral" | "warn" | "wait" } {
  if (attention) return { text: (attention === "approval" || attention === "question") && away ? away : ATTENTION_LABEL[attention], tone: "wait" };
  if (queued) return { text: queued, tone: "neutral" };
  if (rest === "blocked") return { text: "受阻", tone: "warn" };
  if (rest === "paused") return { text: "已停下", tone: "neutral" };
  if (rest === "reply") return { text: "做完一轮", tone: "neutral" };
  if (rest === "review_failed") return { text: "重做中", tone: "neutral" };
  return { text: stage === "todo" ? "已排队" : STAGES.find((entry) => entry.id === stage)?.label ?? "进行中", tone: "neutral" };
}

/**
 * embedded：放在新首页的展示区里——没有返回键（左栏就是导航）。页头右边的信息图标：桌面上在右栏打开详情（交代、标准、验收、产出、改动的文件），对话留着；
 * 手机上没有右栏，照旧在「对话」和「结果」之间切。
 * waiting：首页数据里这个子会话在等什么（左栏的点用的那一份，已经照这台电脑上的会话改过）；页头标签和钉在输入框上方的框都从它和本机事件流算（第 54 条）。
 * queued：首页数据里它在排队时的状态词（subQueueText），页头照写；不在排队为 null。
 */
export function CardSession({ cardId, embedded = false, waiting, queued = null }: { cardId: string; embedded?: boolean; waiting?: Attention | null; queued?: string | null }) {
  const chrome = useViewChrome();
  /** 看结果还是对话；没选过时，子会话不在这台电脑上（手机、别的电脑、还没开）先看摘要（5.4.3）。 */
  const [details, setDetails] = useState<boolean | null>(null);
  const side = useSideDetail();
  // 右边看文件（41 条）：交出的产出、改过的文件点了在右边看，不新开页；手持上整屏。
  // 新首页电脑上放进右边的面板位（第 73 条）：和详情、后台任务互相替换，换成别的就不画；放大也由面板位管（对话收起）。
  const [preview, setPreviewFile] = useState<PreviewFile | null>(null);
  // 预览只在面板里放着文件时画，所以关掉时直接收起面板位（show 在首页里是稳定的）。
  const showPanel = side?.show;
  const setPreview = useCallback((file: PreviewFile) => { setPreviewFile(file); showPanel?.("file"); }, [showPanel]);
  const shownPreview = side && side.shown !== "file" ? null : preview;
  const closePreview = useCallback(() => { setPreviewFile(null); showPanel?.(null); }, [showPanel]);
  /** 页头点了「推翻」：打开结果、推翻的原因框直接展开。 */
  const [flipping, setFlipping] = useState(false);
  const { detail, missing, refresh } = useCardDetail(cardId);
  const local = useLocalRunner();
  const handheld = useHandheld();
  // 和对话列一样：打开落在最新一条，往下长时跟着；本人往上翻了就不拉回。在选项框里批了、答了，接着跟到最新（键盘在框里操作会被当成往上翻）。
  const scroll = useConversationScroll({ streaming: false, resetKey: cardId });
  const ready = local.phase === "ready";
  const session = ready ? latestSessionFor(local.sessions, { cardId }) : null;
  const { view, draft, drafted } = useSessionEvents(local.runner, session?.id ?? null, { drafts: true });
  useModelChangedRefresh(view.entries, local.refresh);
  const mode = useSessionMode(local.runner, session, view);
  const models = useSessionModels(local.runner, local.models, session, local.refresh, () => showWorkspaceToast({ text: "没换成" }), local.status, local.sources !== null);
  // 本会话改过的文件（这台电脑上跑着的会话才读得到）：右栏「改动的文件 N」列它，回答里提到的路径对得上才能点。
  const fileSession = ready && !handheld ? session?.id ?? null : null;
  const files = useSessionFiles(local.runner, fileSession, filesSignal(view.status, view.entries));
  const outputs = detail?.outputs;
  // 改过的文件先看改动（第 72 条）：右栏和回答里点的看开工到现在，对话里一轮末尾那一行点的看那一轮（带轮号）。
  // 右栏清单里能恢复的（不在工作树里做的会话才有），点改动时可以出「恢复整个文件」。
  const openChanges = useCallback((path: string, turn?: number) => {
    if (!fileSession) return;
    const wholeFile = session?.workspace?.kind !== "worktree" && !!files.find((file) => file.path === path)?.restorable;
    setPreview(localChangedFile(local.runner, fileSession, path, { turn, wholeFile }));
  }, [local.runner, fileSession, files, session?.workspace?.kind, setPreview]);
  const openLocal = useCallback((path: string) => openChanges(path), [openChanges]);
  // 回答里提到的一处：先看是不是改过的文件（读这台电脑上现在的），再看是不是交出的产出（读云端那份）；都对不上不能点。
  const openFile = useCallback((mention: string) => {
    const changed = fileSession ? matchChangedFile(files, mention) : null;
    if (changed) return () => openLocal(changed.path);
    const output = outputs?.find((entry) => entry.kind === "artifact" && entry.fileName === mention);
    return output ? () => setPreview(cloudOutputFile(output)) : null;
  }, [files, outputs, fileSession, openLocal, setPreview]);
  const [tab, setTab] = useState<"result" | "chat">("result");
  const [starting, setStarting] = useState(false);
  useAutoReturn(local.runner, ready, detail ? [detail.task] : [], local.sessions, () => void refresh());
  // 开工耗时：从点「开始」到看到第一条事件（≤ 5 秒是验收条件）。只量一次，写进提示。
  useEffect(() => {
    if (!session || !view.lastSeq) return;
    const key = `tianshu-start-${session.id}`;
    try {
      const begun = Number(sessionStorage.getItem(key));
      if (!begun) return;
      sessionStorage.removeItem(key);
      showWorkspaceToast({ text: `开工用了 ${((performance.now() - begun) / 1000).toFixed(1)} 秒` });
    } catch { /* 不量了 */ }
  }, [session, view.lastSeq]);

  // 说一句：一按就先画出来（useSessionSend）。
  const send = useSessionSend(local.runner, session?.id ?? null, view, { kind: "card", id: cardId });
  // 等你补的「我来补」（第 61 条）：输入框填好、聚焦；这时发出的那一句走登记（…/relay），登记完马上在这台电脑上送出去。
  const [supply, setSupply] = useState<{ handbackId: string; text: string; nonce: number } | null>(null);
  const relayNow = useRelayNow();
  // 改约定（第 60 条）：会话详情里的完成标准进编辑。等你补、受阻的「改完成标准」，项目对话带 #agreement 跳来都开它。
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (window.location.hash !== "#agreement") return;
    setEditing(true);
    if (side) side.toggle(true); else setDetails(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在打开这张卡时看一次
  }, [cardId]);
  // 执行方提议改约定（事件 agreement_proposal）：重读一次卡的详情，钉住的框照云端的 proposal 画。
  const proposals = view.entries.filter((entry) => entry.kind === "notice" && entry.code === "agreement_proposal").length;
  useEffect(() => { if (proposals) void refresh(); }, [proposals, refresh]);

  if (missing) return <div className={s.gone}><p>没有这件事项</p><Link href="/me/month">回到本月</Link></div>;
  if (!detail) return <div className={s.page} aria-busy />;

  const item = detail.task;
  const agent = isAgentCard(item);
  const role = cardRole(item);
  const agentName = role?.name ?? HARNESS_NAME[session?.agent ?? "claude-code"];
  const canAct = canCommand({ ready, handheld, hasSession: !!session });
  const card = boardCards([item], session ? [session] : [])[0]!;
  const wait = session ? localWait(view) ?? card.wait : card.wait;
  // 等本人处理的框（第 54 条）：首页数据给的（左栏同一份），这台电脑上有会话时按事件流再对一遍。没给时照卡的标记。
  const cloudWaiting = waiting !== undefined ? waiting : card.wait === "approval" ? "approval" : card.wait === "blocked" ? "verdict" : card.wait === "needs_person" ? "needs_person" : null;
  const attention = attentionOf(cloudWaiting, session ? viewAsk(view, session) : null);
  const stage = card.stage;
  const taskId = item.planTaskId;
  const backHref = workHref(taskId);
  const status = view.status ?? session?.status ?? null;
  const sessionRunning = session ? running(status) : false;
  const ended = !!session && sessionEnded(status);
  const run = detail.runs[0] ?? null;
  const device = run?.deviceName ?? item.card?.run?.deviceName ?? null;

  // 没成的不弹 toast：批准、回答交给选项框，发消息交给输入框，停止交给那排按钮，各自在原处写「失败 · 重试」。
  const decide = async (requestId: string, decision: "allow" | "deny", { forSession, message }: DecideOptions) => {
    if (!session) return;
    await local.runner.decidePermission(session.id, requestId, { decision, ...(forSession ? { allowForSession: true } : {}), ...(message ? { message } : {}) });
    scroll.jumpToLatest();
  };
  // 执行方在问本人：连上事件流以后只认事件流（答过、作废了就是没有），还没连上时照会话摘要。
  const question = session ? (view.lastSeq ? view.question : session.pendingQuestion ?? null) : null;
  const answer = async (body: TLocalQuestionAnswerRequest) => {
    if (!session || !question) return;
    await local.runner.answerQuestion(session.id, question.requestId, body);
    await local.refresh();
    scroll.jumpToLatest();
  };
  const say = send.say;
  const openPane = () => (side ? side.toggle(true) : setDetails(true));
  // 约定改了、提议定了：云端登记了一句转话，这台电脑上跑着这张卡时马上说给执行方。
  // 登记了的转话（我来补、再改一轮、约定改了）：这一页马上认领，说给执行方的那句像平时发话一样先画出来。
  const via = canAct && session ? { sessionId: session.id, say: (text: string) => say(text) } : null;
  const settle = async () => { if (canAct) await relayNow(via); await refresh(); };
  const onSend = async (text: string, files: File[]) => {
    if (!supply) return say(text, files);
    try { await relayHandback(cardId, supply.handbackId, { kind: "supply", text }); }
    catch (error) { if (error instanceof CloudError && error.status === 409) { setSupply(null); void refresh(); } throw error; }
    await relayNow(via);
    setSupply(null);
    await refresh();
    return true;
  };
  const control = async (action: "interrupt" | "kill") => {
    if (!session) return;
    await local.runner[action](session.id);
    await local.refresh();
  };

  // 放大只在新首页电脑上的面板位里有（手持本来就整屏，老页面不加）。
  const previewNode = shownPreview ? <FilePreview file={shownPreview} onClose={closePreview} canRestore={!sessionRunning} wide={side?.wide} onWide={side?.setWide} /> : null;
  const pane = (
    <aside className={s.pane} aria-label="结果">
      <ResultPane detail={detail} session={session} view={session ? view : null} canAct={canAct} wait={wait} stage={stage} handheld={handheld} ready={ready} embedded={embedded}
        flipping={flipping} onFlipDone={() => setFlipping(false)} onPreview={setPreview} previewing={shownPreview?.key ?? null} files={files} onFile={openLocal}
        onRestoreFiles={(paths) => local.runner.restoreSessionFiles(session!.id, paths ? { paths } : {}).then((result) => { filesRestored(session!.id); return result; })}
        onStart={embedded ? undefined : () => setStarting(true)} onControl={control} onResume={() => say("继续")} onChanged={() => void refresh()}
        editing={editing} onEditing={setEditing} onSaved={settle} />
    </aside>
  );
  // 执行方在问本人：选项框（手机、别的电脑上只留问题和「等你 · {电脑名}」，会话停了收成「已失效」）。老页面放在对话最后，新首页钉在输入框上方。
  const asking = !question ? null : <QuestionDecision key={question.requestId} request={question} blocked={canAct ? null : awayChip(device)} expired={ended} onAnswer={answer} />;
  // 新首页里等本人处理的框钉在输入框上方（第 54 条），和项目对话那份是同一件事（本机同一个请求、同一条交回），答一处两处都收起。
  // 处理了、失效了回到对话里：批准收进那一步、提问收成「问：…」一行（事件流照常画），受阻、先不合在最后收成一行。
  const away = canAct ? null : awayChip(device);
  const handback = detail.handbacks[0] ?? null;
  const placeholder = (kind: "approval" | "question") => <DecisionBox kind={kind} title={ATTENTION_LABEL[kind]} options={[]} onPick={() => undefined} blocked={away ?? awayChip(device)} />;
  const asked = !embedded || !attention ? null
    : attention === "approval" ? (view.lastSeq && view.pending.length
      ? <ApprovalDecision requests={view.pending} blocked={away} inWorktree={session?.workspace?.kind === "worktree"} onDecide={(request, decision, options) => decide(request.requestId, decision, options)} />
      : placeholder("approval"))
    : attention === "question" ? asking ?? placeholder("question")
    : attention === "verdict" || attention === "needs_person" ? (handback ? <HandbackDecision key={handback.id} cardId={item.id} handback={handback} here={canAct} via={via}
      onFill={canAct && session ? (text) => setSupply({ handbackId: handback.id, text, nonce: Date.now() }) : undefined}
      onLook={openPane} onEdit={() => { openPane(); setEditing(true); }} onChanged={() => void refresh()} /> : null)
    : <MergeDecision session={session} title={item.title} onChanged={() => void refresh()} />;
  // 执行方提议改约定（第 60 条）：也钉在输入框上方，手机上、别的电脑上一样能定。同时只钉一个框：批准、提问这些先答，答完再出它。
  const proposal = embedded ? detail.agreement?.proposal ?? null : null;
  const pinned = asked ?? (proposal ? <ProposalDecision key={proposal.id} cardId={item.id} proposal={proposal} current={{ brief: detail.brief, standards: detail.standards }} onDecided={settle} /> : null);
  // 答过的等你补、受阻（就到这里、登记送到了），点了先不合的：对话最后收成一行。
  const handled = embedded && attention !== "verdict" && attention !== "needs_person" && handback;
  const blockedAnswer = !handled ? null : handback.passedWithGap ? "就到这里" : handback.relay?.state === "delivered" ? (handback.relay.kind === "return" ? "再改一轮" : "我来补") : null;
  const ws = session?.workspace;
  const mergeLater = embedded && attention !== "merge" && !!session && ws?.kind === "worktree" && !!ws.needsMerge && !ws.mergedCommit && isMergeLater(session.id);
  const settled = (title: string, answerText: string) => <DecisionBox kind="question" title={title} options={[]} onPick={() => undefined} resolved={answerText} />;
  const tail = !embedded ? asking : blockedAnswer && handback ? settled(handbackTitle(handback), blockedAnswer) : mergeLater ? settled(`「${item.title}」无法合回`, "先不合") : null;
  const dock = <PendingDock above latest={{ visible: !scroll.atBottom, jump: scroll.jumpToLatest }} />;
  // 新首页里输入框只在这台电脑上跑着这张卡时出（别处看摘要）；老页面照旧灰着。
  // 输入框下面一行的右边写「执行方 · 模型」（21 条），来源在悬停里：这台电脑上的会话报的（实际跑的优先），没有时退回「来源 · 模型」、再退回云端记的。文件夹在左边。
  const model = (session ? sessionModelText(session, local.models.find((entry) => entry.id === session.modelProfileId)?.efforts) : null) ?? ((label) => (label ? { label, title: null } : null))(runLabel(session?.run) ?? run?.modelLabel ?? item.card?.model?.label ?? null);
  const place = session?.workspace ? { name: shortPlace(session.workspace), title: placeText(session.workspace) } : null;
  const composer = agent && (session || !embedded)
    ? <SessionComposer label={`给${item.title}插话`} disabled={!canAct} onSend={onSend} mode={mode} dock={dock} context={contextUsage(view.context ?? session?.context)} subject={{ kind: "card", id: cardId }} place={place} model={model ? { label: model.label, title: model.title ?? undefined } : null}
      models={models} pinned={pinned} fill={supply ? { text: supply.text, nonce: supply.nonce } : null}
      busy={sessionRunning} onStop={() => void control("interrupt").catch(() => showWorkspaceToast({ text: "没停下" }))} />
    : <div className={s.composerDock}>{pinned ? <div className={s.pinned} data-testid="pinned">{pinned}</div> : null}{dock}</div>;
  const chat = (
    <PendingBoxes>
      <div className={s.chat}>
        <div className={s.scroll} ref={scroll.scrollRef}>
          <div ref={scroll.contentRef}>
            {session ? (
              <TurnFilesContext.Provider value={turnFilesView(local.runner, fileSession, files, view.entries, openChanges)}>
              <SessionTranscript entries={send.entries} agentName={agentName} canAct={canAct} onResend={(entry) => void say(entry.text).catch(() => showWorkspaceToast({ text: "没发出去" }))} onRetry={send.retry} draft={draft} drafted={drafted} device={device} live={sessionRunning} starting={status === "starting"} ended={ended} pinned={embedded} lead={`交代：${item.title}${item.card?.criterion ? ` · 按「${item.card.criterion.text}」验收` : ""}`}
                onFile={openFile}
                onDecide={(request, decision, options) => decide(request.requestId, decision, options)} tail={tail} asking={question}
                stopped={embedded ? view.stopped : null} onResume={canAct ? () => void say("接着做").catch(() => showWorkspaceToast({ text: "没发出去" })) : undefined} />
              </TurnFilesContext.Provider>
            ) : <CloudTimeline run={run} title={item.title} />}
          </div>
          <div ref={scroll.reserveRef} aria-hidden />
        </div>
        {composer}
      </div>
    </PendingBoxes>
  );

  const starter = starting ? <StartDialog title={item.title} role={role} onClose={() => setStarting(false)} onStart={async (model, folder, picked, effort) => {
    const begun = performance.now();
    const created = await startCard(local.runner, item, model, folder?.path ?? "", picked, effort);
    try { sessionStorage.setItem(`tianshu-start-${created.id}`, String(begun)); } catch { /* 只是量开工耗时 */ }
    setStarting(false);
    await local.refresh();
  }} /> : null;
  // 新首页的展示区（5.4.3「页头」）：上一级 / 名字，右边状态 chip、「停止」或「推翻」（弱按钮）、信息图标；下面是对话，点信息图标换成结果。模型和文件夹在输入框下面一行。
  if (embedded) {
    const inSide = !!side;
    const showPane = side ? side.open : details ?? paneFirst(!!session, !!pinned);
    const openDetails = (open?: boolean) => (side ? side.toggle(open) : setDetails(open ?? !showPane));
    const chipOf = stateChip(attention, session ? localWait(view) : card.wait, stage, !canAct && device ? awayChip(device) : null, queued);
    const handback = detail.handbacks[0] ?? null;
    const canFlip = !handheld && !!handback && handback.status === "done" && !handback.overruled && handback.outcome === "pass" && !deliverableLabel(item)?.startsWith("已纳入");
    // 停止在输入框右边（27 条，在跑时没字是停止方块）；页头只留「推翻」。
    const stop = canFlip ? <HeroButton variant="ghost" size="sm" onPress={() => { openDetails(true); setFlipping(true); }}>推翻</HeroButton> : null;
    return (
      <div className={s.page} data-embedded="" data-testid="card-session">
        <header className={s.embedHead}>
          {chrome.lead}
          <b className={s.embedTitle}>{chrome.parent}{chrome.letter}<span className={s.embedName}>{item.title}</span></b>
          <span className={s.stateChip} data-tone={chipOf.tone}>{chipOf.tone === "wait" ? <i aria-hidden /> : null}{chipOf.text}</span>
          <span className={s.exec} />
          {stop}
          <HeroButton variant="ghost" size="sm" isIconOnly aria-label={inSide ? "详情" : "结果"} title={inSide ? "详情" : "结果"} data-pressed={showPane || undefined} onPress={() => openDetails()} data-testid="session-details"><Info {...ICON} aria-hidden /></HeroButton>
          {chrome.trail}
        </header>
        <div className={s.body} data-solo={shownPreview && !side && !handheld ? undefined : ""}>
          {showPane && !inSide ? <div className={s.paneScroll}>{pane}</div> : chat}
          {side ? null : previewNode}
        </div>
        {starter}
        {side ? <SideContent side={side}><div className={s.page} data-embedded="" data-side="">{pane}</div></SideContent> : null}
        {side ? <SideContent side={side} kind="file">{previewNode}</SideContent> : null}
      </div>
    );
  }
  const state = wait ? <span className={s.tag} data-tone={waitTone(wait)}>{WAIT_LABEL[wait]}</span>
    : <span className={s.tag} data-tone={stage === "done" ? "done" : stage === "todo" ? undefined : "ver"}>{STAGES.find((entry) => entry.id === stage)?.label}</span>;
  return (
    <div className={s.page} data-testid="card-session">
      <header className={s.head}>
        <Link href={backHref} className={s.back}><ChevronLeft size={14} aria-hidden />{handheld ? null : "返回"}</Link>
        <div className={s.title}>
          <span className={s.kind} data-kind="card">执行事项</span>
          <b>{item.title}</b>
          {state}
        </div>
        <div className={s.exec}>
          {role ? <span className={s.ex}><i>&gt;_</i>{role.name}</span> : null}
          {agent ? <span>{session ? `本机${sessionRunning ? " · 进行中" : ""}` : item.card?.run ? item.card.run.deviceName : ""}</span> : null}
          {session?.workspace ? <span title={placeText(session.workspace)}>{shortPlace(session.workspace)}</span> : item.card?.handback?.git ? <span>{item.card.handback.git.branch}</span> : null}
        </div>
      </header>
      {handheld ? (
        <div className={s.tabs} role="tablist">
          <button type="button" role="tab" aria-selected={tab === "result"} onClick={() => setTab("result")}>结果</button>
          <button type="button" role="tab" aria-selected={tab === "chat"} onClick={() => setTab("chat")}>对话</button>
        </div>
      ) : null}
      <div className={s.body} data-tab={handheld ? tab : undefined}>
        {chat}
        {shownPreview && !handheld ? null : pane}
        {previewNode}
      </div>
      {starter}
    </div>
  );
}

/** 不在这台电脑上跑：只看云端摘要的里程碑。 */
function CloudTimeline({ run, title }: { run: TLocalRunView | null; title: string }) {
  if (!run) return <div className={s.feed}><span className={s.evt}>交代：{title}</span></div>;
  return (
    <div className={s.feed}>
      <span className={s.evt}>在 {run.deviceName} 上跑 · {run.modelLabel ?? ""}</span>
      {run.timeline.map((entry, index) => <div key={index} className={s.step} data-done><time>{new Date(entry.at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}</time><span>{entry.text}</span></div>)}
      {run.lastActivity ? <span className={s.evt}>最近：{run.lastActivity.text}</span> : null}
    </div>
  );
}

function ResultPane({ detail, session, view, canAct, wait, stage, handheld, ready, embedded, flipping, onFlipDone, onPreview, previewing, files, onFile, onRestoreFiles, onStart, onControl, onResume, onChanged, editing, onEditing, onSaved }: {
  detail: CardDetail; session: TLocalSessionSummary | null; view: SessionView | null; canAct: boolean; wait: string | null; stage: string; handheld: boolean; ready: boolean;
  /** 新首页里：停止、推翻在页头（5.4.3），这里只留「继续」；不写订阅按标价折算的花费（11.2）。 */
  embedded: boolean;
  /** 页头点了「推翻」：推翻的原因框直接展开。 */
  flipping: boolean; onFlipDone: () => void;
  /** 交出的产出点了在右边看（41 条）；previewing 是正在看的那一份。 */
  onPreview: (file: PreviewFile) => void; previewing: string | null;
  /** 本会话改过的文件（这台电脑上才有），点了在右边看；不在了的不能点。 */
  files: readonly TLocalChangedFile[]; onFile: (path: string) => void;
  /** 恢复文件（第 71 条）：paths 不给是全部。 */
  onRestoreFiles: (paths?: string[]) => ReturnType<LocalRunner["restoreSessionFiles"]>;
  /** 新首页里没有常驻的「开始」（设计 9.8）：自动开工失败时由 Task 管线那一行出「手动开始」。 */
  onStart?: () => void; onControl: (action: "interrupt" | "kill") => Promise<unknown>; onResume: () => Promise<unknown>; onChanged: () => void;
  /** 约定（交代、完成标准）在改（第 60 条）；存好以后 onSaved。 */
  editing: boolean; onEditing: (editing: boolean) => void; onSaved: () => Promise<unknown>;
}) {
  const item = detail.task;
  // 停止、继续没成：那排按钮后面写「失败 · 重试」（原因在 title 里），不弹 toast。
  const [failed, setFailed] = useState<{ retry: () => void; reason: string } | null>(null);
  const act = (action: () => Promise<unknown>) => { setFailed(null); action().catch((error: unknown) => setFailed({ retry: () => act(action), reason: error instanceof Error ? error.message : "" })); };
  const run = detail.runs[0] ?? null;
  const agent = isAgentCard(item);
  const role = cardRole(item);
  const plan = view?.plan.length ? view.plan : run?.planEntries ?? [];
  const step = planStep(plan);
  const handback = detail.handbacks[0] ?? null;
  const usage = view ? { tokens: view.usage.inputTokens + view.usage.outputTokens, cost: view.usage.costUsd } : run ? { tokens: run.cost.inputTokens + run.cost.outputTokens, cost: run.cost.costUsd } : null;
  const status = view?.status ?? null;
  const live = status === "running" || status === "starting" || status === "waiting_permission";
  const paused = wait === "paused" || status === "idle";
  // 这台电脑上有会话时照它的摘要写「来源 · 模型 · 思考」（第 67 条），别处只有云端记的原文。
  const model = view ? runLabel(session?.run) : item.card?.model?.label;
  // 在哪做：本机开工时说的（分支、从哪个提交开始、主文件夹没提交的改动没带进来），没收到时照会话摘要。
  const git = item.card?.handback?.git ?? null;
  const place = view?.place ?? (session?.workspace ? placeText(session.workspace) : git ? `分支 ${git.branch}` : null);
  return (
    <>
      <div className={s.brief}>
        {editing ? null : <p className={s.lab}>交代</p>}
        {item.planTaskId ? <Link href={workHref(item.planTaskId)} className={s.link}>{item.mission?.title ? `${item.mission.title} › ` : ""}Task</Link> : null}
        {item.card?.criterion ? <div className={s.meta}><span className={s.crit}>{circled(item.card.criterion.index)}</span><span>{item.card.criterion.text}</span></div> : null}
        {detail.brief && !editing ? <p className={s.text}>{detail.brief}</p> : null}
        {agent && (role || model || run?.modelLabel) ? <div className={s.meta}>{role ? <span className={s.ex}><i>&gt;_</i>{role.name}</span> : null}<span>{model ?? run?.modelLabel}</span></div> : null}
        {view?.queuedBecause ? <div className={s.meta}><span>{view.queuedBecause}</span></div> : null}
        {place ? <div className={s.meta}><span>{place}</span></div> : null}
        {git ? <div className={s.meta}><span>{commitText(git)}</span></div> : null}
      </div>

      {plan.length ? (
        <div className={s.sec}>
          <p className={s.lab}>计划{step ? <span className={s.faint}>第 {step.step}/{step.total} 步</span> : null}</p>
          <PlanChecklist entries={plan} />
        </div>
      ) : null}

      {item.card?.sourceWords.length ? (
        <div className={s.sec}>
          <p className={s.lab}>原话</p>
          <SourceWords words={item.card.sourceWords} className={s.words} />
        </div>
      ) : null}

      <AgreementSection cardId={item.id} version={item.version} brief={detail.brief} standards={detail.standards} agreement={detail.agreement ?? null}
        canEdit={agent && !detail.fallback && stage !== "done"} editing={editing} onEditing={onEditing} onSaved={onSaved} />

      {handback ? <Acceptance cardId={item.id} handback={handback} canOverrule={!handheld} deliverable={deliverableLabel(item)} onChanged={onChanged} flipping={flipping} onFlipDone={onFlipDone} hideFlip={embedded} /> : null}
      <MergeAction session={session} title={item.title} accepted={stage === "done"} onChanged={onChanged} />

      {detail.outputs.length ? (
        <div className={s.sec}>
          <p className={s.lab}>产出</p>
          {detail.outputs.map((output) => {
            const tag = <span className={s.outTag}>{output.kind === "artifact" ? (output.fileName?.split(".").pop() ?? "文件").toUpperCase() : "证据"}</span>;
            // 交出的文件：整行点了在右边看；证据照旧（有链接的新开一页）。
            if (output.kind === "artifact") {
              const file = cloudOutputFile(output);
              return (
                <button key={output.id} type="button" className={s.output} data-current={previewing === file.key ? "" : undefined} onClick={() => onPreview(file)} data-testid="output-open">
                  {tag}<span className={s.outTitle}>{output.title}</span>
                </button>
              );
            }
            return (
              <div key={output.id} className={s.output}>
                {tag}<span className={s.outTitle}>{output.title}</span>
                {output.url ? <a href={output.url} target="_blank" rel="noopener noreferrer" className={s.link}>打开</a> : null}
              </div>
            );
          })}
        </div>
      ) : null}

      {files.length && session ? (
        <ChangedFiles files={files} undo={session.undo} canRestore={!handheld && session.workspace?.kind !== "worktree" && !live} onRestore={onRestoreFiles}
          current={previewing?.startsWith(`local:${session.id}:`) ? previewing.slice(`local:${session.id}:`.length).replace(/:(turn|session)$/, "") : null} onOpen={handheld ? undefined : onFile} />
      ) : null}

      {usage && usage.tokens && !embedded ? <p className={s.cost}>{usage.tokens.toLocaleString("zh-CN")} tokens{money(usage.cost) ? ` · ${money(usage.cost)}` : ""}</p> : null}

      {agent && !handheld ? (
        <div className={s.actions}>
          {stage === "todo" && !view && onStart ? <HeroButton variant="primary" onPress={onStart} isDisabled={!ready}>开始</HeroButton> : null}
          {canAct && live && !embedded ? <HeroButton variant="secondary" onPress={() => act(() => onControl("interrupt"))}>停止</HeroButton> : null}
          {canAct && paused && !live ? <HeroButton variant={embedded ? "ghost" : "primary"} size={embedded ? "sm" : undefined} onPress={() => act(onResume)}>继续</HeroButton> : null}
          {canAct && view && !embedded && status !== "exited" && status !== "done" && status !== "failed" ? <HeroButton variant="ghost" onPress={() => act(() => onControl("kill"))}>强停</HeroButton> : null}
          {failed ? <FailedLine inline reason={failed.reason} onRetry={failed.retry} /> : null}
        </div>
      ) : null}
      {!agent && item.status !== "done" ? <div className={s.actions}><Link href={`/me/tasks/${encodeURIComponent(item.id)}`} className={s.link}>打开事项</Link></div> : null}
    </>
  );
}

/** 单条标准的结论（5.4.7）：达到 = 勾（--ink-muted），未达到 = 叉（--danger），部分达到 = 中性 chip。 */
function Verdict({ verdict }: { verdict: string }) {
  if (verdict === "met") return <span className={s.verdict} data-verdict="met"><Check {...ICON} aria-hidden />{VERDICT.met}</span>;
  if (verdict === "unmet") return <span className={s.verdict} data-verdict="unmet"><X {...ICON} aria-hidden />{VERDICT.unmet}</span>;
  return <span className={s.verdict}>{VERDICT[verdict] ?? verdict}</span>;
}

/** Agent 验收：逐条达到 / 部分达到 / 未达到，带理由和怎么补；本人能推翻（通过的退回去，没过的直接算通过）。 */
export function Acceptance({ cardId, handback, canOverrule, deliverable, onChanged, flipping = false, onFlipDone, hideFlip = false }: {
  cardId: string; handback: TCardHandbackView; canOverrule: boolean; deliverable: string | null; onChanged: () => void;
  /** 页头点了「推翻」：原因框直接展开。hideFlip：「推翻」在页头，这里不再放一个。 */
  flipping?: boolean; onFlipDone?: () => void; hideFlip?: boolean;
}) {
  const [reason, setReason] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<Failure | null>(null);
  useEffect(() => { if (flipping) setReason((current) => current ?? ""); }, [flipping]);
  const verdicts = useMemo(() => handback.result?.criteria ?? [], [handback.result]);
  const close = () => { setReason(null); onFlipDone?.(); };
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setFailed(null);
    try { await action(); close(); onChanged(); }
    catch (error) { setFailed(failureOf(error, () => void run(action))); }
    finally { setBusy(false); }
  };
  const head = handback.status === "queued" || handback.status === "running" ? "验收中"
    : handback.status === "failed" ? "验收失败"
    : handback.outcome === "pass" ? `验收过了 · ${handback.met}/${handback.total}${deliverable ? ` · ${deliverable}` : ""}`
    : handback.passedWithGap ? `就到这里 · ${handback.met}/${handback.total} 条达到`
    : handback.outcome === "needs_person" ? `等你补 · ${handback.met}/${handback.total} 条达到`
    : `未通过 · ${handback.met}/${handback.total} 条达到`;
  // 没过、等你补的推翻就是「就到这里」（主循环第 62 条）：没达到的几条上面逐条列着，原因空着提交不了。
  const flipLabel = handback.outcome === "pass" ? "推翻" : "就到这里";
  const canSubmit = !!reason?.trim();
  const canFlip = canOverrule && handback.status === "done" && !handback.overruled && !(handback.outcome === "pass" && deliverable?.startsWith("已纳入"));
  return (
    <div className={s.sec} data-testid="acceptance">
      <p className={s.lab}>{handback.status === "queued" || handback.status === "running" ? <span className={s.pulse} aria-hidden /> : null}{head}</p>
      {verdicts.length ? (
        <ol className={s.verdicts}>
          {verdicts.map((row) => (
            <li key={row.index} data-verdict={row.verdict}>
              <Verdict verdict={row.verdict} />
              <span>{row.text}</span>
              {row.reason ? <small>{row.reason}</small> : null}
              {row.fix && row.verdict !== "met" ? <small>怎么补：{row.fix}</small> : null}
            </li>
          ))}
        </ol>
      ) : null}
      <SourceWordIssues issues={handback.sourceWordIssues} className={s.wordIssues} tagClassName={s.issueTag} />
      {handback.overrule ? <p className={s.faint}>{handback.overrule.by.name} 推翻：{handback.overrule.reason}</p> : null}
      {handback.error ? <p className={s.faint}>{handback.error}</p> : null}
      {reason !== null ? (
        <form className={s.reason} onSubmit={(event) => { event.preventDefault(); if (canSubmit) void run(() => overrule(cardId, handback.id, reason.trim())); }}>
          <input autoFocus value={reason} maxLength={200} placeholder="原因" aria-label="推翻的原因" onChange={(event) => setReason(event.target.value)} />
          <HeroButton variant="primary" size="sm" type="submit" isDisabled={busy || !canSubmit}>{flipLabel}</HeroButton>
          <HeroButton variant="ghost" size="sm" onPress={close}>取消</HeroButton>
          {failed && !busy ? <FailedLine inline {...failed} /> : null}
        </form>
      ) : (
        <div className={s.actions}>
          {canFlip && !(hideFlip && handback.outcome === "pass") ? <HeroButton variant="ghost" size="sm" onPress={() => setReason("")}>{flipLabel}</HeroButton> : null}
          {canOverrule && handback.status === "failed" ? <HeroButton variant="ghost" size="sm" isDisabled={busy} onPress={() => void run(() => retryAcceptance(cardId, handback.id))}>重新验收</HeroButton> : null}
          {failed && !busy ? <FailedLine inline {...failed} /> : null}
        </div>
      )}
    </div>
  );
}
