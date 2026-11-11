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
import { useRouter } from "next/navigation";
import { Check, ChevronDown, ChevronLeft, ChevronRight, Info, X } from "lucide-react";
import type { TCardHandbackView, TLocalQuestionAnswerRequest, TLocalRunView } from "@warmap/contracts";
import { HeroButton } from "@/components/HeroButton";
import { useHandheld } from "@/components/ui/useHandheld";
import { StartDialog } from "@/components/local/StartDialog";
import { latestSessionFor, useLocalRunner } from "@/lib/local/LocalRunnerProvider";
import { useSessionEvents } from "@/lib/local/useSessionEvents";
import { contextUsage, localWait, planStep, running, type SessionView } from "@/lib/local/sessionView";
import { startCard } from "@/lib/local/start";
import { STAGES, WAIT_LABEL, boardCards, canCommand, circled, deliverableLabel, isAgentCard, waitTone, type CardStage, type CardWait } from "@/lib/board/cards";
import { overrule, retryAcceptance } from "@/lib/board/cloud";
import { cardRole } from "@/lib/team/roles";
import { useAutoReturn } from "@/lib/board/useAutoReturn";
import { showWorkspaceToast } from "@/lib/toast";
import { RelayLine, SessionComposer, SessionTranscript, useSessionSend, useSessionModels, useModelChangedRefresh, sessionEnded, type DecideOptions } from "./SessionTranscript";
import { useSessionMode } from "./PermissionMode";
import { FilePreview, cloudOutputFile, localSessionFile, type PreviewFile } from "./FilePreview";
import { filesSignal, matchChangedFile, useSessionFiles } from "@/lib/local/sessionFiles";
import { HARNESS_NAME, runLabel, sessionModelText } from "@/lib/local/runModel";
import { useCardDetail, type CardDetail } from "./useCardDetail";
import { SourceWordIssues, SourceWords } from "./SourceWords";
import { MergeAction } from "@/components/work/MergeAction";
import { QuestionDecision, awayChip, questionTitle } from "@/components/work/decisions";
import { askAnchor } from "@/components/home/TaskFeed";
import { FailedLine, PendingBoxes, PendingDock, failureOf, type Failure } from "@/components/work/DecisionBox";
import { useViewChrome } from "@/components/home/view";
import { ICON } from "@/components/home/StateIcon";
import { useConversationScroll } from "@/conversation/useConversationScroll";
import { commitText, placeText, shortPlace } from "@/lib/work/merge";
import type { TLocalSessionSummary } from "@/lib/local/runner";
import s from "@/styles/v2-session.module.css";
import { PlanChecklist } from "./PlanChecklist";

/** 回到新首页，锚着这张卡的 Task（V2 设计第 20.4 节；没打开新首页的人会被带回老首页）。 */
const workHref = (taskId: string | null) => (taskId ? `/me/work/tasks/${encodeURIComponent(taskId)}` : "/me/work");

const VERDICT: Record<string, string> = { met: "达到", partial: "部分达到", unmet: "未达到" };
const money = (usd: number | null) => (usd === null ? null : `约 $${usd.toFixed(usd < 1 ? 3 : 2)}`);

/**
 * 新首页页头的状态 chip（5.4.3「状态 chip」、5.6 状态词）：中性、警告、等你（中性底加强调色圆点）三档；新首页不用成功色。
 * 第一次验收没过不是单独的状态：进行中，阶段「重做中」。away：不在这台电脑上、又在等你时写「等你 · {电脑名}」。
 */
export function stateChip(wait: CardWait | null, stage: CardStage, away: string | null): { text: string; tone: "neutral" | "warn" | "wait" } {
  if (wait === "approval" || wait === "reply") return { text: away ?? WAIT_LABEL[wait], tone: "wait" };
  if (wait === "blocked") return { text: "受阻", tone: "warn" };
  if (wait === "paused") return { text: "已停止", tone: "neutral" };
  if (wait === "review_failed") return { text: "重做中", tone: "neutral" };
  return { text: stage === "todo" ? "已排队" : STAGES.find((entry) => entry.id === stage)?.label ?? "进行中", tone: "neutral" };
}

/** embedded：放在新首页的展示区里——没有返回键（左栏就是导航），页头右边的信息图标在「对话」和「结果」之间切。 */
export function CardSession({ cardId, embedded = false }: { cardId: string; embedded?: boolean }) {
  const chrome = useViewChrome();
  const router = useRouter();
  /** 看结果还是对话；没选过时，子会话不在这台电脑上（手机、别的电脑、还没开）先看摘要（5.4.3）。 */
  const [details, setDetails] = useState<boolean | null>(null);
  // 右边看文件（41 条）：交出的产出点了在这一页右边看，不新开页；手持上整屏。
  const [preview, setPreview] = useState<PreviewFile | null>(null);
  const closePreview = useCallback(() => setPreview(null), []);
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
  const models = useSessionModels(local.runner, local.models, session, local.refresh, () => showWorkspaceToast({ text: "没换成" }), local.status);
  // 本会话改过的文件（这台电脑上跑着的会话才读得到）：右栏「改动的文件 N」列它，回答里提到的路径对得上才能点。
  const fileSession = ready && !handheld ? session?.id ?? null : null;
  const files = useSessionFiles(local.runner, fileSession, filesSignal(view.status, view.entries));
  const outputs = detail?.outputs;
  const openLocal = useCallback((path: string) => { if (fileSession) setPreview(localSessionFile(local.runner, fileSession, path)); }, [local.runner, fileSession]);
  // 回答里提到的一处：先看是不是改过的文件（读这台电脑上现在的），再看是不是交出的产出（读云端那份）；都对不上不能点。
  const openFile = useCallback((mention: string) => {
    const changed = fileSession ? matchChangedFile(files, mention) : null;
    if (changed) return () => openLocal(changed.path);
    const output = outputs?.find((entry) => entry.kind === "artifact" && entry.fileName === mention);
    return output ? () => setPreview(cloudOutputFile(output)) : null;
  }, [files, outputs, fileSession, openLocal]);
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

  if (missing) return <div className={s.gone}><p>没有这件事项</p><Link href="/me/month">回到本月</Link></div>;
  if (!detail) return <div className={s.page} aria-busy />;

  const item = detail.task;
  const agent = isAgentCard(item);
  const role = cardRole(item);
  const agentName = role?.name ?? HARNESS_NAME[session?.agent ?? "claude-code"];
  const canAct = canCommand({ ready, handheld, hasSession: !!session });
  const card = boardCards([item], session ? [session] : [])[0]!;
  const wait = session ? localWait(view) ?? card.wait : card.wait;
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
  const control = async (action: "interrupt" | "kill") => {
    if (!session) return;
    await local.runner[action](session.id);
    await local.refresh();
  };

  const pane = (
    <aside className={s.pane} aria-label="结果">
      <ResultPane detail={detail} session={session} view={session ? view : null} canAct={canAct} wait={wait} stage={stage} handheld={handheld} ready={ready} embedded={embedded}
        flipping={flipping} onFlipDone={() => setFlipping(false)} onPreview={setPreview} previewing={preview?.key ?? null} files={files} onFile={openLocal}
        onStart={embedded ? undefined : () => setStarting(true)} onControl={control} onResume={() => say("继续")} onChanged={() => void refresh()} />
    </aside>
  );
  // 执行方在问本人：选项框放在对话最后（问的那一处）；手机、别的电脑上只留问题和「等你 · {电脑名}」。会话停了收成「已失效」。
  // 新首页里提问、批准由 Task 管线转达（14.3）：这里只一行原话加「去回答」，点了跳到 Task 管线那个框。
  const relay = embedded && taskId && session && !ended ? () => router.push(`${workHref(taskId)}#${askAnchor(session.id)}`) : null;
  const asking = !question ? null : relay ? <RelayLine text={questionTitle(question)} onGo={relay} />
    : <QuestionDecision key={question.requestId} request={question} blocked={canAct ? null : awayChip(device)} expired={ended} onAnswer={answer} />;
  const dock = <PendingDock above latest={{ visible: !scroll.atBottom, jump: scroll.jumpToLatest }} />;
  // 新首页里输入框只在这台电脑上跑着这张卡时出（别处看摘要）；老页面照旧灰着。
  // 输入框下面一行的右边写「执行方 · 模型」（21 条），来源在悬停里：这台电脑上的会话报的（实际跑的优先），没有时退回「来源 · 模型」、再退回云端记的。文件夹在左边。
  const model = (session ? sessionModelText(session, local.models.find((entry) => entry.id === session.modelProfileId)?.efforts) : null) ?? ((label) => (label ? { label, title: null } : null))(runLabel(session?.run) ?? run?.modelLabel ?? item.card?.model?.label ?? null);
  const place = session?.workspace ? { name: shortPlace(session.workspace), title: placeText(session.workspace) } : null;
  const composer = agent && (session || !embedded)
    ? <SessionComposer label={`给${item.title}插话`} disabled={!canAct} onSend={say} mode={mode} dock={dock} context={contextUsage(view.context ?? session?.context)} subject={{ kind: "card", id: cardId }} place={place} model={model ? { label: model.label, title: model.title ?? undefined } : null}
      models={models}
      busy={sessionRunning} onStop={() => void control("interrupt").catch(() => showWorkspaceToast({ text: "没停下" }))} />
    : <div className={s.composerDock}>{dock}</div>;
  const chat = (
    <PendingBoxes>
      <div className={s.chat}>
        <div className={s.scroll} ref={scroll.scrollRef}>
          <div ref={scroll.contentRef}>
            {session ? (
              <SessionTranscript entries={send.entries} agentName={agentName} canAct={canAct} onResend={(entry) => void say(entry.text).catch(() => showWorkspaceToast({ text: "没发出去" }))} onRetry={send.retry} draft={draft} drafted={drafted} device={device} live={sessionRunning} starting={status === "starting"} ended={ended} relay={relay} lead={`交代：${item.title}${item.card?.criterion ? ` · 按「${item.card.criterion.text}」验收` : ""}`}
                onFile={openFile}
                onDecide={(request, decision, options) => decide(request.requestId, decision, options)} tail={asking} asking={question} />
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
    const showPane = details ?? !session;
    const chipOf = stateChip(wait, stage, !canAct && device ? awayChip(device) : null);
    const handback = detail.handbacks[0] ?? null;
    const canFlip = !handheld && !!handback && handback.status === "done" && !handback.overruled && handback.outcome === "pass" && !deliverableLabel(item)?.startsWith("已纳入");
    // 停止在输入框右边（27 条，在跑时没字是停止方块）；页头只留「推翻」。
    const stop = canFlip ? <HeroButton variant="ghost" size="sm" onPress={() => { setDetails(true); setFlipping(true); }}>推翻</HeroButton> : null;
    return (
      <div className={s.page} data-embedded="" data-testid="card-session">
        <header className={s.embedHead}>
          {chrome.lead}
          <b className={s.embedTitle}>{chrome.parent}{chrome.letter}<span className={s.embedName}>{item.title}</span></b>
          <span className={s.stateChip} data-tone={chipOf.tone}>{chipOf.tone === "wait" ? <i aria-hidden /> : null}{chipOf.text}</span>
          <span className={s.exec} />
          {stop}
          <HeroButton variant="ghost" size="sm" isIconOnly aria-label="结果" title="结果" data-pressed={showPane || undefined} onPress={() => setDetails(!showPane)} data-testid="session-details"><Info {...ICON} aria-hidden /></HeroButton>
          {chrome.trail}
        </header>
        <div className={s.body} data-solo={preview && !handheld ? undefined : ""}>
          {showPane ? <div className={s.paneScroll}>{pane}</div> : chat}
          {preview ? <FilePreview file={preview} onClose={closePreview} /> : null}
        </div>
        {starter}
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
        {preview && !handheld ? null : pane}
        {preview ? <FilePreview file={preview} onClose={closePreview} /> : null}
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

function ResultPane({ detail, session, view, canAct, wait, stage, handheld, ready, embedded, flipping, onFlipDone, onPreview, previewing, files, onFile, onStart, onControl, onResume, onChanged }: {
  detail: CardDetail; session: TLocalSessionSummary | null; view: SessionView | null; canAct: boolean; wait: string | null; stage: string; handheld: boolean; ready: boolean;
  /** 新首页里：停止、推翻在页头（5.4.3），这里只留「继续」；不写订阅按标价折算的花费（11.2）。 */
  embedded: boolean;
  /** 页头点了「推翻」：推翻的原因框直接展开。 */
  flipping: boolean; onFlipDone: () => void;
  /** 交出的产出点了在右边看（41 条）；previewing 是正在看的那一份。 */
  onPreview: (file: PreviewFile) => void; previewing: string | null;
  /** 本会话改过的文件（这台电脑上才有），点了在右边看；不在了的不能点。 */
  files: readonly TLocalChangedFile[]; onFile: (path: string) => void;
  /** 新首页里没有常驻的「开始」（设计 9.8）：自动开工失败时由 Task 管线那一行出「手动开始」。 */
  onStart?: () => void; onControl: (action: "interrupt" | "kill") => Promise<unknown>; onResume: () => Promise<unknown>; onChanged: () => void;
}) {
  const item = detail.task;
  // 「改动的文件 N」默认收起。
  const [filesOpen, setFilesOpen] = useState(false);
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
  const model = view ? null : item.card?.model?.label;
  // 在哪做：本机开工时说的（分支、从哪个提交开始、主文件夹没提交的改动没带进来），没收到时照会话摘要。
  const git = item.card?.handback?.git ?? null;
  const place = view?.place ?? (session?.workspace ? placeText(session.workspace) : git ? `分支 ${git.branch}` : null);
  return (
    <>
      <div className={s.brief}>
        <p className={s.lab}>交代</p>
        {item.planTaskId ? <Link href={workHref(item.planTaskId)} className={s.link}>{item.mission?.title ? `${item.mission.title} › ` : ""}Task</Link> : null}
        {item.card?.criterion ? <div className={s.meta}><span className={s.crit}>{circled(item.card.criterion.index)}</span><span>{item.card.criterion.text}</span></div> : null}
        {detail.brief ? <p className={s.text}>{detail.brief}</p> : null}
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

      {detail.standards.length ? (
        <div className={s.sec}>
          <p className={s.lab}>完成标准</p>
          <ol className={s.goal}>{detail.standards.map((line, index) => <li key={index}>{line}</li>)}</ol>
        </div>
      ) : null}

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
        <div className={s.sec}>
          <button type="button" className={s.filesHead} aria-expanded={filesOpen} onClick={() => setFilesOpen(!filesOpen)} data-testid="changed-files">
            {filesOpen ? <ChevronDown {...ICON} /> : <ChevronRight {...ICON} />}改动的文件 {files.length}
          </button>
          {filesOpen ? files.map((file) => (file.exists
            ? <button key={file.path} type="button" className={s.output} title={file.path} data-current={previewing === `local:${session.id}:${file.path}` ? "" : undefined} onClick={() => onFile(file.path)} data-testid="changed-file">
              <span className={s.outTitle}>{file.path}</span>
            </button>
            : <div key={file.path} className={s.output} title={file.path} data-gone="" data-testid="changed-file"><span className={s.outTitle}>{file.path}</span></div>)) : null}
        </div>
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
    : `未通过 · ${handback.met}/${handback.total} 条达到`;
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
        <form className={s.reason} onSubmit={(event) => { event.preventDefault(); if (reason.trim()) void run(() => overrule(cardId, handback.id, reason.trim())); }}>
          <input autoFocus value={reason} maxLength={200} placeholder="原因" aria-label="推翻的原因" onChange={(event) => setReason(event.target.value)} />
          <HeroButton variant="primary" size="sm" type="submit" isDisabled={busy || !reason.trim()}>{handback.outcome === "pass" ? "推翻" : "仍然通过"}</HeroButton>
          <HeroButton variant="ghost" size="sm" onPress={close}>取消</HeroButton>
          {failed && !busy ? <FailedLine inline {...failed} /> : null}
        </form>
      ) : (
        <div className={s.actions}>
          {canFlip && !(hideFlip && handback.outcome === "pass") ? <HeroButton variant="ghost" size="sm" onPress={() => setReason("")}>{handback.outcome === "pass" ? "推翻" : "仍然通过"}</HeroButton> : null}
          {canOverrule && handback.status === "failed" ? <HeroButton variant="ghost" size="sm" isDisabled={busy} onPress={() => void run(() => retryAcceptance(cardId, handback.id))}>重新验收</HeroButton> : null}
          {failed && !busy ? <FailedLine inline {...failed} /> : null}
        </div>
      )}
    </div>
  );
}
