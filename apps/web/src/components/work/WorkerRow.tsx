"use client";

/**
 * worker 的一行（V2 设计第 20.2、20.3 节，样子照 prototype-home）：链路记号、岗位头像（方的，干活 / 验收 / 挑刺三种底色）；
 * 第一行「开发 #2」、做的事、右边标记；第二行资源在前（本机 / 云端的小图标加模型），然后第几步或排第几、用时，Task 名放最后（放不下截它）。
 * 派活单里的行和左栏带「要运行 …」和批准、拒绝；手机和别的电脑写「到电脑上处理」。
 */
import { useState, type ReactElement } from "react";
import { HeroButton } from "@/components/HeroButton";
import { useHandheld } from "@/components/ui/useHandheld";
import { useLocalRunner } from "@/lib/local/LocalRunnerProvider";
import { showWorkspaceToast } from "@/lib/toast";
import type { RoleKind } from "@/lib/team/roles";
import { canCommandHere, decide, overruleWorker, reply } from "@/lib/work/actions";
import { shortPlace } from "@/lib/work/merge";
import { CHAIN_LABEL, MARK_LABEL, QUEUE_LABEL, type ChainState, type Worker } from "@/lib/work/workers";
import w from "@/styles/v2-work.module.css";

export function Chain({ state, size }: { state: ChainState | "draft"; size?: "xs" }) {
  return <span className={w.sg} data-state={state} data-size={size} role="img" aria-label={state === "draft" ? "待开工" : CHAIN_LABEL[state]} />;
}

/** 岗位头像：名字的第一个字，方的（人是圆的）。 */
export function RoleAvatar({ name, kind = "worker", size }: { name: string; kind?: RoleKind | "self"; size?: "s" }) {
  return <span className={w.ra} data-kind={kind} data-size={size} aria-hidden>{Array.from(name)[0] ?? "?"}</span>;
}

const LAPTOP = <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden><rect x="2" y="2.5" width="8" height="5.5" rx="1" /><path d="M1 9.5h10" /></svg>;
const CLOUD = <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden><path d="M3.6 9.5h5a2.2 2.2 0 0 0 .3-4.4A3 3 0 0 0 3.2 5.4 2.1 2.1 0 0 0 3.6 9.5z" /></svg>;
export function Resource({ where, model }: { where: "local" | "cloud"; model: string | null }) {
  return <span className={w.rs}>{where === "cloud" ? CLOUD : LAPTOP}{where === "cloud" ? "云端" : "本机"}{model ? ` · ${model}` : ""}</span>;
}

/** 右边的标记：排队写在等什么；进行中写等你批准、验收中这些；已完成不写。 */
export function marker(worker: Worker): { text: string; tone: "you" | "acc" | "warn" | "wait" } | null {
  if (worker.state === "queued") return worker.reason ? { text: QUEUE_LABEL[worker.reason], tone: "wait" } : null;
  if (worker.state === "done" || !worker.mark) return null;
  const tone = worker.mark === "approval" || worker.mark === "reply" ? "you" : worker.mark === "reviewing" ? "acc" : worker.mark === "paused" ? "wait" : "warn";
  return { text: MARK_LABEL[worker.mark], tone };
}

const minutes = (from: string | null, to: number) => (from ? `${Math.max(0, Math.round((to - Date.parse(from)) / 60_000))} 分` : null);
const hhmm = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }) : null);
/** 验收中：干活的是验收员（本机交回后自己接的；别的设备上看是云端转来的）。 */
const reviewing = (worker: Worker) => worker.state === "doing" && worker.mark === "reviewing";

/** 第二行：资源在前，再是在哪做（分支或文件夹；这台电脑上没有会话时用云端记的分支），Task 最后。 */
export function secondLine(worker: Worker, now: number, task: string | null): (string | ReactElement)[] {
  const tail = task ? [task] : [];
  const place = worker.workspace ? shortPlace(worker.workspace) : worker.git?.branch ?? null;
  const handback = worker.item?.card?.handback ?? null;
  const inclusion = worker.item?.card?.deliverable ?? null;
  if (worker.state === "queued") return [<Resource key="r" where="local" model={worker.model} />, place, worker.queuePos ? `排第 ${worker.queuePos}` : null, ...tail].filter((part): part is string | ReactElement => !!part);
  if (worker.state === "done") {
    return [handback ? `${handback.met}/${handback.total} 达到` : null, inclusion ? `${inclusion.state === "included" ? "已纳入" : "攒进"} v${inclusion.versionNumber}` : null,
      worker.workspace?.kind === "worktree" && worker.workspace.mergedCommit ? "已合并" : null, hhmm(worker.endedAt), ...tail].filter((part): part is string => !!part);
  }
  if (reviewing(worker)) return [<Resource key="r" where={worker.where ?? "local"} model={worker.model} />, (handback?.total ? `对照 ${handback.total} 条` : "逐条对照"), ...tail];
  return [<Resource key="r" where={worker.where ?? "local"} model={worker.model} />, place, worker.step ? `第 ${worker.step.n}/${worker.step.total} 步` : null, minutes(worker.startedAt, now), ...tail]
    .filter((part): part is string | ReactElement => !!part);
}

export function WorkerRow({ worker, now, current, onOpen, onChanged, task = null, ask = false }: {
  worker: Worker;
  now: number;
  current?: boolean;
  onOpen?: () => void;
  onChanged: () => void;
  /** 跨 Task 的列表里写上是哪个 Task 的（放最后）。 */
  task?: string | null;
  /** 派活单里的行：等你的事直接带按钮。 */
  ask?: boolean;
}) {
  const mark = marker(worker);
  const line2 = secondLine(worker, now, task);
  return (
    <div className={w.wr} data-testid="worker-row" data-card={worker.cardId ?? worker.key} role={onOpen ? "button" : undefined} tabIndex={onOpen ? 0 : undefined} aria-current={current || undefined}
      onClick={(event) => { if (onOpen && !(event.target as HTMLElement).closest("button, a, input, form, [data-ask]")) onOpen(); }}
      onKeyDown={(event) => { if (onOpen && event.key === "Enter" && event.target === event.currentTarget) onOpen(); }}>
      <Chain state={worker.state} />
      <RoleAvatar name={worker.role.name} kind={worker.role.kind} />
      <div className={w.mid}>
        <div className={w.l1}>
          <span className={w.who}>{worker.role.name} #{worker.seq}</span>
          <span className={w.what}>{worker.title}</span>
          {mark ? <span className={w.mk} data-tone={mark.tone}>{mark.text}</span> : null}
        </div>
        {line2.length ? <div className={w.l2}>{line2.map((part, index) => <span key={index}>{index ? " · " : ""}{part}</span>)}</div> : null}
      </div>
      {ask ? <AskRow worker={worker} onChanged={onChanged} /> : null}
    </div>
  );
}

/** 要运行的那件事：命令用等宽字。 */
export function AskText({ worker }: { worker: Worker }) {
  if (!worker.ask) return <span>等你批准</span>;
  if (worker.ask.command) return <span>要运行 <code className={w.cmd}>{worker.ask.command}</code></span>;
  return <span>要{worker.ask.text}</span>;
}

/** 等你的事：批准、拒绝（这台电脑），回复，仍然通过（云端，手机也能）。 */
export function AskRow({ worker, onChanged, boxed = true }: { worker: Worker; onChanged: () => void; boxed?: boolean }) {
  const local = useLocalRunner();
  const handheld = useHandheld();
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const mark = worker.state === "doing" ? worker.mark : null;
  if (mark !== "approval" && mark !== "reply" && mark !== "review_failed") return null;
  const here = canCommandHere(worker, local.phase === "ready", handheld);
  const run = async (action: () => Promise<void>, done: string) => {
    setBusy(true);
    try { await action(); showWorkspaceToast({ text: done }); setText(null); await local.refresh(); onChanged(); }
    catch (error) { showWorkspaceToast({ text: error instanceof Error ? error.message : "没成功，请重试" }); }
    finally { setBusy(false); }
  };
  const what = mark === "approval" ? <AskText worker={worker} /> : mark === "reply" ? <span>{worker.doing ?? "等你回复"}</span>
    : <span>验收没过{worker.item?.card?.handback ? ` · ${worker.item.card.handback.met}/${worker.item.card.handback.total} 条` : ""}</span>;
  const remote = (mark === "approval" || mark === "reply") && !here;
  const body = text !== null ? (
    <form className={w.acts} onSubmit={(event) => { event.preventDefault(); if (text.trim()) void run(() => (mark === "reply" ? reply(local.runner, worker, text.trim()) : overruleWorker(worker, text.trim())), mark === "reply" ? "已回复" : "已算通过"); }}>
      <span className={w.inline}><input autoFocus value={text} maxLength={mark === "reply" ? 4000 : 200} placeholder={mark === "reply" ? "回复" : "原因"} aria-label={mark === "reply" ? "回复" : "仍然通过的原因"} onChange={(event) => setText(event.target.value)} /></span>
      <HeroButton variant="primary" size="sm" type="submit" isDisabled={busy || !text.trim()}>{mark === "reply" ? "发送" : "仍然通过"}</HeroButton>
      <HeroButton variant="ghost" size="sm" onPress={() => setText(null)}>取消</HeroButton>
    </form>
  ) : remote ? <span className={w.faint}>到电脑上处理</span> : (
    <span className={w.acts}>
      {mark === "approval" ? <>
        <HeroButton variant="primary" size="sm" isDisabled={busy} onPress={() => void run(() => decide(local.runner, worker, "allow"), "已批准")}>批准</HeroButton>
        <HeroButton variant="secondary" size="sm" isDisabled={busy} onPress={() => void run(() => decide(local.runner, worker, "deny"), "已拒绝")}>拒绝</HeroButton>
      </> : <HeroButton variant={mark === "reply" ? "primary" : "secondary"} size="sm" isDisabled={busy} onPress={() => setText("")}>{mark === "reply" ? "回复" : "仍然通过"}</HeroButton>}
    </span>
  );
  return (
    <div className={boxed ? w.askrow : w.ask} data-ask data-testid="ask-row">
      <span className={w.m}>{what}</span>
      {body}
    </div>
  );
}
