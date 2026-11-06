"use client";

/**
 * 卡的子会话页（/me/cards/[id]，原型 v8.4 renderSess + cardPane，第 11.1 节）：左边和执行方对话（本机实时），右边结果。
 * 右边从上到下：交代（所属 Task、对的那条标准、岗位和模型）、计划条目、完成标准、Agent 验收、产出、动作。卡上写岗位名，不写执行方（第 19.6 节）。
 * 只有这台电脑上的本机程序在跑这张卡、而且不是手机时，才能开始、插话、停下、批权限；别处只看云端同步来的摘要。
 * 手机上分「结果」「对话」两个标签。
 */
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import type { TCardHandbackView, TLocalRunView } from "@warmap/contracts";
import { HeroButton } from "@/components/HeroButton";
import { useHandheld } from "@/components/ui/useHandheld";
import { StartDialog } from "@/components/local/StartDialog";
import { latestSessionFor, useLocalRunner } from "@/lib/local/LocalRunnerProvider";
import { useSessionEvents } from "@/lib/local/useSessionEvents";
import { localWait, planStep, running, type SessionView } from "@/lib/local/sessionView";
import { startCard } from "@/lib/local/start";
import { STAGES, WAIT_LABEL, boardCards, canCommand, circled, deliverableLabel, isAgentCard, waitTone } from "@/lib/board/cards";
import { overrule, retryAcceptance } from "@/lib/board/cloud";
import { cardRole } from "@/lib/team/roles";
import { useAutoReturn } from "@/lib/board/useAutoReturn";
import { showWorkspaceToast } from "@/lib/toast";
import { SessionComposer, SessionTranscript } from "./SessionTranscript";
import { useCardDetail, type CardDetail } from "./useCardDetail";
import { MergeAction } from "@/components/work/MergeAction";
import { commitText, placeText, shortPlace } from "@/lib/work/merge";
import type { TLocalSessionSummary } from "@/lib/local/runner";
import s from "@/styles/v2-session.module.css";

/** 回到新首页，锚着这张卡的 Task（V2 设计第 20.4 节；没打开新首页的人会被带回老首页）。 */
const workHref = (taskId: string | null) => (taskId ? `/me/work/tasks/${encodeURIComponent(taskId)}` : "/me/work");

const VERDICT: Record<string, string> = { met: "达到", partial: "部分", unmet: "未达到" };
const money = (usd: number | null) => (usd === null ? null : `约 $${usd.toFixed(usd < 1 ? 3 : 2)}`);

export function CardSession({ cardId }: { cardId: string }) {
  const { detail, missing, refresh } = useCardDetail(cardId);
  const local = useLocalRunner();
  const handheld = useHandheld();
  const ready = local.phase === "ready";
  const session = ready ? latestSessionFor(local.sessions, { cardId }) : null;
  const { view } = useSessionEvents(local.runner, session?.id ?? null);
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

  if (missing) return <div className={s.gone}><p>没有这件事项</p><Link href="/me/month">回到本月</Link></div>;
  if (!detail) return <div className={s.page} aria-busy />;

  const item = detail.task;
  const agent = isAgentCard(item);
  const role = cardRole(item);
  const agentName = role?.name ?? "Claude Code";
  const canAct = canCommand({ ready, handheld, hasSession: !!session });
  const card = boardCards([item], session ? [session] : [])[0]!;
  const wait = session ? localWait(view) ?? card.wait : card.wait;
  const stage = card.stage;
  const taskId = item.planTaskId;
  const backHref = workHref(taskId);
  const sessionRunning = session ? running(view.status ?? session.status) : false;

  const decide = async (requestId: string, decision: "allow" | "deny", forSession: boolean) => {
    if (!session) return;
    try { await local.runner.decidePermission(session.id, requestId, { decision, allowForSession: forSession }); }
    catch (error) { showWorkspaceToast({ text: error instanceof Error ? error.message : "没成功，请重试" }); }
  };
  const say = async (text: string) => {
    if (!session) return false;
    try {
      const result = await local.runner.sendMessage(session.id, text);
      if (result.delivery === "next_step") showWorkspaceToast({ text: "下一步生效" });
      return true;
    } catch (error) {
      showWorkspaceToast({ text: error instanceof Error ? error.message : "没发出去，请重试" });
      return false;
    }
  };
  const control = async (action: "interrupt" | "kill") => {
    if (!session) return;
    try { await local.runner[action](session.id); await local.refresh(); showWorkspaceToast({ text: action === "interrupt" ? "已停下" : "已强停" }); }
    catch (error) { showWorkspaceToast({ text: error instanceof Error ? error.message : "没成功，请重试" }); }
  };

  const pane = (
    <aside className={s.pane} aria-label="结果">
      <ResultPane detail={detail} session={session} view={session ? view : null} canAct={canAct} wait={wait} stage={stage} handheld={handheld} ready={ready}
        onStart={() => setStarting(true)} onControl={(action) => void control(action)} onResume={() => void say("继续")} onChanged={() => void refresh()} />
    </aside>
  );
  const chat = (
    <div className={s.chat}>
      <div className={s.scroll}>
        {session ? (
          <SessionTranscript entries={view.entries} agentName={agentName} canAct={canAct} lead={`交代：${item.title}${item.card?.criterion ? ` · 按「${item.card.criterion.text}」验收` : ""}`}
            onDecide={(request, decision, forSession) => decide(request.requestId, decision, forSession)} />
        ) : <CloudTimeline run={detail.runs[0] ?? null} title={item.title} />}
      </div>
      {agent ? <SessionComposer placeholder={`发给${agentName}…`} disabled={!canAct} onSend={say} /> : null}
    </div>
  );

  return (
    <div className={s.page} data-testid="card-session">
      <header className={s.head}>
        <Link href={backHref} className={s.back}><ChevronLeft size={14} aria-hidden />{handheld ? null : "返回"}</Link>
        <div className={s.title}>
          <span className={s.kind} data-kind="card">执行事项</span>
          <b>{item.title}</b>
          {wait ? <span className={s.tag} data-tone={waitTone(wait)}>{WAIT_LABEL[wait]}</span>
            : <span className={s.tag} data-tone={stage === "done" ? "done" : stage === "todo" ? undefined : "ver"}>{STAGES.find((entry) => entry.id === stage)?.label}</span>}
        </div>
        <div className={s.exec}>
          {role ? <span className={s.ex}><i>&gt;_</i>{role.name}</span> : null}
          {agent ? <span>{session ? `本机${sessionRunning ? " · 在跑" : ""}` : item.card?.run ? item.card.run.deviceName : ""}</span> : null}
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
        {pane}
      </div>
      {starting ? <StartDialog title={item.title} role={role} onClose={() => setStarting(false)} onStart={async (model, folder, picked) => {
        const begun = performance.now();
        const created = await startCard(local.runner, item, model, folder?.path ?? "", picked);
        try { sessionStorage.setItem(`tianshu-start-${created.id}`, String(begun)); } catch { /* 只是量开工耗时 */ }
        setStarting(false);
        await local.refresh();
      }} /> : null}
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

function ResultPane({ detail, session, view, canAct, wait, stage, handheld, ready, onStart, onControl, onResume, onChanged }: {
  detail: CardDetail; session: TLocalSessionSummary | null; view: SessionView | null; canAct: boolean; wait: string | null; stage: string; handheld: boolean; ready: boolean;
  onStart: () => void; onControl: (action: "interrupt" | "kill") => void; onResume: () => void; onChanged: () => void;
}) {
  const item = detail.task;
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
          <ol className={s.plan}>{plan.map((entry, index) => <li key={index} data-status={entry.status}>{entry.content}</li>)}</ol>
        </div>
      ) : null}

      {detail.standards.length ? (
        <div className={s.sec}>
          <p className={s.lab}>完成标准</p>
          <ol className={s.goal}>{detail.standards.map((line, index) => <li key={index}>{line}</li>)}</ol>
        </div>
      ) : null}

      {handback ? <Acceptance cardId={item.id} handback={handback} canOverrule={!handheld} deliverable={deliverableLabel(item)} onChanged={onChanged} /> : null}
      <MergeAction session={session} title={item.title} accepted={stage === "done"} onChanged={onChanged} />

      {detail.outputs.length ? (
        <div className={s.sec}>
          <p className={s.lab}>产出</p>
          {detail.outputs.map((output) => (
            <div key={output.id} className={s.output}>
              <span className={s.outTag}>{output.kind === "artifact" ? (output.fileName?.split(".").pop() ?? "文件").toUpperCase() : "证据"}</span>
              <span className={s.outTitle}>{output.title}</span>
              {output.kind === "artifact" ? <a href={`/api/me/local-outputs/${encodeURIComponent(output.id)}`} target="_blank" rel="noopener" className={s.link}>打开</a>
                : output.url ? <a href={output.url} target="_blank" rel="noopener noreferrer" className={s.link}>打开</a> : null}
            </div>
          ))}
        </div>
      ) : null}

      {usage && usage.tokens ? <p className={s.cost}>{usage.tokens.toLocaleString("zh-CN")} tokens{money(usage.cost) ? ` · ${money(usage.cost)}` : ""}</p> : null}

      {agent && !handheld ? (
        <div className={s.actions}>
          {stage === "todo" && !view ? <HeroButton variant="primary" onPress={onStart} isDisabled={!ready}>开始</HeroButton> : null}
          {canAct && live ? <HeroButton variant="secondary" onPress={() => onControl("interrupt")}>停下</HeroButton> : null}
          {canAct && paused && !live ? <HeroButton variant="primary" onPress={onResume}>继续</HeroButton> : null}
          {canAct && view && status !== "exited" && status !== "failed" ? <HeroButton variant="ghost" onPress={() => onControl("kill")}>强停</HeroButton> : null}
        </div>
      ) : null}
      {!agent && item.status !== "done" ? <div className={s.actions}><Link href={`/me/tasks/${encodeURIComponent(item.id)}`} className={s.link}>打开事项</Link></div> : null}
    </>
  );
}

/** Agent 验收：逐条达到 / 部分 / 未达到，带理由和怎么补；本人能推翻（通过的退回去，没过的直接算通过）。 */
export function Acceptance({ cardId, handback, canOverrule, deliverable, onChanged }: { cardId: string; handback: TCardHandbackView; canOverrule: boolean; deliverable: string | null; onChanged: () => void }) {
  const [reason, setReason] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const verdicts = useMemo(() => handback.result?.criteria ?? [], [handback.result]);
  const run = async (action: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try { await action(); showWorkspaceToast({ text: done }); setReason(null); onChanged(); }
    catch (error) { showWorkspaceToast({ text: error instanceof Error ? error.message : "没成功，请重试" }); }
    finally { setBusy(false); }
  };
  const head = handback.status === "queued" || handback.status === "running" ? "Agent 验收中"
    : handback.status === "failed" ? "验收没跑完"
    : handback.outcome === "pass" ? `Agent 验收通过 · ${handback.met}/${handback.total}${deliverable ? ` · ${deliverable}` : ""}`
    : `验收没过 · ${handback.met}/${handback.total} 条达到`;
  const canFlip = canOverrule && handback.status === "done" && !handback.overruled && !(handback.outcome === "pass" && deliverable?.startsWith("已纳入"));
  return (
    <div className={s.sec} data-testid="acceptance">
      <p className={s.lab}>{handback.status === "queued" || handback.status === "running" ? <span className={s.pulse} aria-hidden /> : null}{head}</p>
      {verdicts.length ? (
        <ol className={s.verdicts}>
          {verdicts.map((row) => (
            <li key={row.index} data-verdict={row.verdict}>
              <span className={s.verdict}>{VERDICT[row.verdict] ?? row.verdict}</span>
              <span>{row.text}</span>
              {row.reason ? <small>{row.reason}</small> : null}
              {row.fix && row.verdict !== "met" ? <small>怎么补：{row.fix}</small> : null}
            </li>
          ))}
        </ol>
      ) : null}
      {handback.overrule ? <p className={s.faint}>{handback.overrule.by.name} 推翻：{handback.overrule.reason}</p> : null}
      {handback.error ? <p className={s.faint}>{handback.error}</p> : null}
      {reason !== null ? (
        <form className={s.reason} onSubmit={(event) => { event.preventDefault(); if (reason.trim()) void run(() => overrule(cardId, handback.id, reason.trim()), handback.outcome === "pass" ? "已推翻，回到进行中" : "已算通过"); }}>
          <input autoFocus value={reason} maxLength={200} placeholder="原因" aria-label="推翻的原因" onChange={(event) => setReason(event.target.value)} />
          <HeroButton variant="primary" size="sm" type="submit" isDisabled={busy || !reason.trim()}>{handback.outcome === "pass" ? "推翻" : "仍然通过"}</HeroButton>
          <HeroButton variant="ghost" size="sm" onPress={() => setReason(null)}>取消</HeroButton>
        </form>
      ) : (
        <div className={s.actions}>
          {canFlip ? <HeroButton variant="secondary" size="sm" onPress={() => setReason("")}>{handback.outcome === "pass" ? "推翻验收" : "仍然通过"}</HeroButton> : null}
          {canOverrule && handback.status === "failed" ? <HeroButton variant="secondary" size="sm" isDisabled={busy} onPress={() => void run(() => retryAcceptance(cardId, handback.id), "已重新排队")}>重新验收</HeroButton> : null}
        </div>
      )}
    </div>
  );
}
