"use client";

/**
 * 项目转交（新首页设计 16.7）网页这边的几块，样子都用现有的：阶段行（.line + 转圈 + 用时）、选项框（DecisionBox）、分隔线（.monthRule）、chip。
 * - TransferFlow：转出的人在项目对话里看到的「准备交接」→（问在跑的会话、问文件夹检查）→ 交接说明卡 →「交给 {名字}」→ 等接手。
 * - HandoverCard：交接说明卡，卡下面「带上对话记录」（默认不勾）和「交给 {名字}」；像密钥的行标出来，挡住不让发。
 * - TransferPreview：接手人从等你点进来的只读预览，交接说明在最上面，「接手」「不接」。
 * - HandoverRule：对话里换人的分隔线「{日期} {原负责人} → {接手人}」。
 * - PullChip：接手以后文件夹 chip 写「拉到这台电脑」，拉不下来在 chip 上写原因。
 */
import { useEffect, useState } from "react";
import { HeroButton } from "@/components/HeroButton";
import { DecisionBox, FailedLine, failureOf, type Failure } from "@/components/work/DecisionBox";
import { duration } from "@/lib/home/derive";
import type { Project } from "@/lib/home/projects";
import { draftNote, handoverRule, secretHits, type HandoverSection, type Transfer } from "@/lib/home/transfer";
import { StateIcon } from "./StateIcon";
import h from "@/styles/home.module.css";

/** 还在跑（或排着、等你）的会话：转之前要问等做完还是停掉。 */
const busy = (project: Project) => project.subSessions.filter((sub) => sub.state === "running" || sub.state === "queued" || sub.state === "waiting");

/** 用时每秒走（阶段行「准备交接 · 1 分 05 秒」）。 */
function useTicking(on: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [on]);
  return now;
}

export function TransferFlow({ project, transfer, onUpdate, onStop }: {
  project: Project;
  transfer: Transfer;
  onUpdate: (patch: Partial<Transfer>) => void;
  /** 选了「停掉」：停掉这些会话（在这台电脑上的）。 */
  onStop: (sessionIds: string[]) => Promise<void>;
}) {
  const running = busy(project);
  const preparing = transfer.status === "preparing";
  const askRunning = preparing && transfer.running === null && running.length > 0;
  const waitRunning = preparing && transfer.running === "wait" && running.length > 0;
  const askCheck = preparing && !askRunning && !!project.folder && transfer.check === null;
  const waitCheck = preparing && transfer.check === "wait";
  const ready = preparing && !askRunning && !waitRunning && !askCheck && !waitCheck;
  const now = useTicking(preparing && !ready);
  const [stopFailed, setStopFailed] = useState<Failure | null>(null);
  // 各步都过了：交接说明（管线写的那份到了以前，网页按项目里有的拼一份）。
  useEffect(() => {
    if (ready && !transfer.note) onUpdate({ note: draftNote(project, transfer.from) });
  }, [ready, transfer.note, project, transfer.from, onUpdate]);
  const stop = async () => {
    setStopFailed(null);
    try { await onStop(running.flatMap((sub) => (sub.sessionId ? [sub.sessionId] : []))); onUpdate({ running: "stop" }); }
    catch (error) { setStopFailed(failureOf(error, () => void stop())); }
  };
  return (
    <div className={h.transfer} data-testid="transfer-flow">
      <p className={h.line}>
        <StateIcon state={preparing && !transfer.note ? "running" : "done"} />
        准备交接给 {transfer.to.name}
        {preparing && !transfer.note ? <span className={h.lineMore}> · {duration(transfer.startedAt, now)}</span> : null}
      </p>
      {askRunning ? (
        <DecisionBox kind="question" title={`有 ${running.length} 个会话在跑`} testId="transfer-running"
          options={[{ label: "等做完再转", recommended: true }, { label: "停掉" }]}
          onPick={([index]) => (index === 0 ? onUpdate({ running: "wait" }) : stop())} />
      ) : null}
      {stopFailed ? <FailedLine {...stopFailed} /> : null}
      {waitRunning ? <p className={h.line}><StateIcon state="running" />等 {running.length} 个会话做完</p> : null}
      {askCheck ? (
        <DecisionBox kind="question" title={`检查文件夹「${project.folder}」`} testId="transfer-check"
          options={[{ label: "等本机上线", recommended: true }, { label: "不检查直接转" }]}
          onPick={([index]) => onUpdate({ check: index === 0 ? "wait" : "skip" })} />
      ) : null}
      {waitCheck ? (
        <p className={h.line}><StateIcon state="queued" />检查文件夹 · 等本机上线
          <HeroButton variant="ghost" size="sm" onPress={() => onUpdate({ check: "skip" })}>不检查直接转</HeroButton></p>
      ) : null}
      {transfer.note ? (
        <HandoverCard note={transfer.note} to={transfer.to.name} sent={transfer.status !== "preparing"} includeHistory={transfer.includeHistory}
          onSend={(includeHistory) => onUpdate({ status: "sent", includeHistory, decidedAt: new Date().toISOString() })} />
      ) : null}
      {transfer.status === "sent" ? <p className={h.line} data-testid="transfer-sent"><StateIcon state="waiting" />已交给 {transfer.to.name} · 等接手</p> : null}
      {transfer.status === "declined" ? <p className={h.line}><StateIcon state="stopped" />{transfer.to.name}没接</p> : null}
    </div>
  );
}

/** 交接说明的几段（预览和卡共用）；像密钥的那一行标危险色。 */
function NoteBody({ note }: { note: HandoverSection[] }) {
  const hits = secretHits(note);
  return (
    <div className={h.noteBody}>
      {note.map((section) => (
        <section key={section.title} aria-label={section.title}>
          <p className={h.noteTitle}>{section.title}</p>
          <ul>
            {section.lines.map((line, index) => (
              <li key={`${index}:${line}`} data-secret={hits.some((hit) => hit.section === section.title && hit.line === index + 1) ? "" : undefined}>{line}</li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** 交接说明卡：要改在对话里跟伙伴说；卡下面「带上对话记录」（默认不勾）和「交给 {名字}」。像密钥的挡住。 */
export function HandoverCard({ note, to, sent, includeHistory: initial, onSend }: {
  note: HandoverSection[]; to: string; sent: boolean; includeHistory: boolean; onSend: (includeHistory: boolean) => void;
}) {
  const [includeHistory, setIncludeHistory] = useState(initial);
  const hits = secretHits(note);
  return (
    <article className={h.noteCard} aria-label="交接说明" data-testid="handover-card">
      <p className={h.noteHead}>交接说明</p>
      <NoteBody note={note} />
      {hits.length ? (
        <p className={h.barError} role="alert" data-testid="handover-secret">
          {hits.map((hit) => `${hit.section}第 ${hit.line} 行像密钥（${hit.sample}）`).join("；")}
        </p>
      ) : null}
      <div className={h.noteFoot}>
        <label className={h.check}>
          <input type="checkbox" checked={includeHistory} disabled={sent} onChange={(event) => setIncludeHistory(event.target.checked)} data-testid="handover-history" />
          带上对话记录
        </label>
        {sent ? null : <HeroButton variant="primary" size="sm" isDisabled={hits.length > 0} onPress={() => onSend(includeHistory)} data-testid="handover-send">交给 {to}</HeroButton>}
      </div>
    </article>
  );
}

/** 接手人的只读预览（从等你点进来）：交接说明在最上面，「接手」「不接」。 */
export function TransferPreview({ transfer, onAccept, onDecline }: { transfer: Transfer; onAccept: () => void | Promise<unknown>; onDecline: () => void | Promise<unknown> }) {
  const [busyWith, setBusyWith] = useState<"accept" | "decline" | null>(null);
  const run = (which: "accept" | "decline") => { setBusyWith(which); void Promise.resolve(which === "accept" ? onAccept() : onDecline()).finally(() => setBusyWith(null)); };
  return (
    <div className={h.transferPreview} data-testid="transfer-preview">
      <p className={h.sectionTitle}>{transfer.from.name}把「{transfer.projectName}」交给你</p>
      {transfer.note ? <article className={h.noteCard} aria-label="交接说明"><p className={h.noteHead}>交接说明</p><NoteBody note={transfer.note} /></article> : null}
      <div className={h.noteFoot}>
        <HeroButton variant="primary" size="sm" isDisabled={!!busyWith} onPress={() => run("accept")} data-testid="transfer-accept">接手</HeroButton>
        <HeroButton variant="ghost" size="sm" isDisabled={!!busyWith} onPress={() => run("decline")} data-testid="transfer-decline">不接</HeroButton>
      </div>
    </div>
  );
}

/** 对话里换人的分隔线：「11/7 孙铭泽 → 陈晨星」（样式同月份分隔）。 */
export function HandoverRule({ transfer }: { transfer: Pick<Transfer, "decidedAt" | "from" | "to"> }) {
  return <p className={h.monthRule} role="separator" data-testid="handover-rule">{handoverRule(transfer)}</p>;
}

/** 接手以后的文件夹 chip：「拉到这台电脑」；拉着「拉取中」；拉不下来写原因（点了再试）。 */
export function PullChip({ state, reason, onPull }: { state: "idle" | "pulling" | "failed"; reason?: string | null; onPull: () => void }) {
  return (
    <button type="button" className={h.statusChip} data-tone={state === "failed" ? "danger" : undefined} disabled={state === "pulling"} title={reason ?? undefined} onClick={onPull} data-testid="pull-chip">
      {state === "pulling" ? "拉取中" : state === "failed" ? reason || "拉取失败" : "拉到这台电脑"}
    </button>
  );
}
