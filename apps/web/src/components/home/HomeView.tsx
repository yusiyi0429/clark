"use client";

/**
 * 首页（新首页设计第 4.1 条）是「此刻」：
 * 1. 等你：所有要你拿主意的事合在一起，一件一行；短的（批准、单选、接下、采纳）就在这一行答，长的点进去答。没有就不显示。
 * 2. 本月的 Task：一件一行，标题和一句现状，点了进那件 Task 的管线。
 * 3. 底部输入框：左边「发给」默认自动，也能选伙伴或某件 Task；发出去以后直接跳进那条管线的对话。首页自己不存对话。
 */
import { useEffect, useRef, useState } from "react";
import { ArrowUp, AtSign, ChevronDown } from "lucide-react";
import type { Buddy } from "@/components/buddy/useBuddy";
import { localOptions, oneTap } from "@/components/work/decisions";
import { useHandheld } from "@/components/ui/useHandheld";
import { useLocalRunner } from "@/lib/local/LocalRunnerProvider";
import { decideProposal } from "@/lib/team/roles";
import { canCommandHere, decide } from "@/lib/work/actions";
import { mergeCard } from "@/lib/work/merge";
import { showWorkspaceToast } from "@/lib/toast";
import { statusLine, taskHref } from "@/lib/home/derive";
import type { RouteTarget, WaitingItem, WorkHomeData } from "@/lib/home/types";
import type { WorkHomeApi } from "@/lib/home/useWorkHome";
import h from "@/styles/home.module.css";

const ICON = { size: 16, strokeWidth: 1.5, "aria-hidden": true } as const;

export type SendTarget = "auto" | RouteTarget;

export function HomeView({ data, api, buddy, loading, go, route, onSend }: {
  data: WorkHomeData;
  api: WorkHomeApi;
  buddy: Buddy | null;
  /** 本月计划还没读到：「本月」那一块先空着，不写「还没有 Task」。 */
  loading: boolean;
  go: (href: string) => void;
  /** 「自动」会发去哪（打字时实时显示）。 */
  route: (text: string) => RouteTarget;
  onSend: (text: string, target: SendTarget) => void;
}) {
  const many = data.missions.length > 1;
  const tasks = data.missions.flatMap((mission) => mission.tasks);
  return (
    <div className={h.homeView} data-testid="home-view">
      <div className={h.homeScroll}>
        <div className={h.homeInner}>
          {data.waiting.length ? (
            <section aria-label="等你" className={h.section}>
              <p className={h.sectionTitle}>等你 <span>{data.waiting.length}</span></p>
              <WaitingList items={data.waiting} api={api} go={go} />
            </section>
          ) : null}
          <section aria-label="本月" className={h.section}>
            {data.missions.map((mission) => (
              <div key={mission.missionId} className={h.taskList}>
                <p className={h.sectionTitle}>{many ? mission.title : "本月"}</p>
                {mission.tasks.map((task) => (
                  <button key={task.taskId} type="button" className={h.taskLine} onClick={() => go(taskHref(task.taskId))} data-testid="home-task">
                    <span className={h.taskLineName}>{task.name}</span>
                    <span className={h.taskLineStatus} data-waiting={task.summary.waiting && !task.delivered ? "" : undefined}>{statusLine(task)}</span>
                  </button>
                ))}
              </div>
            ))}
            {data.missions.length || loading ? null : <p className={h.empty}>本月还没有 Task</p>}
          </section>
        </div>
      </div>
      <HomeComposer buddy={buddy} tasks={tasks} route={route} onSend={onSend} />
    </div>
  );
}

type Action = { label: string; primary?: boolean; run: () => Promise<unknown> };

/** 等你的一件：短的给就地答的按钮。本机上的批准、提问只在跑它的这台电脑上能答（手机上点进去看）。 */
function useActions(api: WorkHomeApi) {
  const local = useLocalRunner();
  const handheld = useHandheld();
  const ready = local.phase === "ready";
  return (item: WaitingItem): Action[] => {
    const worker = item.ref.workerKey ? api.work.workers.find((entry) => entry.key === item.ref.workerKey) : undefined;
    if (worker && (item.kind === "approval" || item.kind === "question") && !canCommandHere(worker, ready, handheld)) return [];
    if (item.kind === "approval" && worker) return [{ label: "批准", primary: true, run: () => decide(local.runner, worker, "allow") }];
    if (item.kind === "question" && worker?.session?.pendingQuestion) {
      const question = worker.session.pendingQuestion;
      const session = worker.session;
      if (!oneTap(question) || question.questions[0]!.options.length > 3) return [];
      const { options, order } = localOptions(question.questions[0]!.options);
      return options.map((option, index) => ({
        label: option.label, primary: index === 0,
        run: () => local.runner.answerQuestion(session.id, question.requestId, { choices: [[question.questions[0]!.options[order[index]!]!.label]] }),
      }));
    }
    if (item.kind === "role" && item.ref.proposalId) {
      const id = item.ref.proposalId;
      return [{ label: "采纳", primary: true, run: () => decideProposal(id, "accept") }, { label: "不要", run: () => decideProposal(id, "dismiss") }];
    }
    if (item.kind === "assigned" && item.ref.notificationId) {
      const id = item.ref.notificationId;
      return [{ label: "接下", primary: true, run: async () => { const result = await api.member.markSeen([id]); if (!result.ok) throw new Error(result.error); } }];
    }
    if (item.kind === "merge" && item.ref.sessionId) {
      const session = local.sessions.find((entry) => entry.id === item.ref.sessionId);
      if (!session || handheld) return [];
      return [{ label: "再合并", primary: true, run: async () => { const result = await mergeCard(local.runner, session, item.source ?? ""); if (!result.ok) throw new Error(result.text); } }];
    }
    return [];
  };
}

export function WaitingList({ items, api, go }: { items: WaitingItem[]; api: WorkHomeApi; go: (href: string) => void }) {
  const actions = useActions(api);
  const local = useLocalRunner();
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (item: WaitingItem, action: Action) => {
    setBusy(item.id);
    try { await action.run(); await Promise.all([local.refresh(), api.refresh()]); }
    catch (error) { showWorkspaceToast({ text: error instanceof Error ? error.message : "没成功，请重试" }); }
    finally { setBusy(null); }
  };
  return (
    <ul className={h.waiting} data-testid="waiting-list">
      {items.map((item) => {
        const buttons = actions(item);
        return (
          <li key={item.id} className={h.wait} data-kind={item.kind}>
            <button type="button" className={h.waitMain} onClick={() => go(item.href)}>
              <i className={h.waitDot} aria-hidden />
              <span className={h.waitText}>
                <span className={h.waitTitle}>{item.title}</span>
                {item.source ? <span className={h.waitSource}>{item.source}</span> : null}
              </span>
            </button>
            {buttons.length ? (
              <span className={h.waitActs}>
                {buttons.map((action) => (
                  <button key={action.label} type="button" className={h.act} data-primary={action.primary ? "" : undefined} disabled={busy === item.id} onClick={() => void run(item, action)}>{action.label}</button>
                ))}
              </span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * 首页底部的输入框：「发给」默认自动；回车发出，跳进那条对话。
 * 自动时，停下打字约 300ms 后标签写出会发去哪（「自动 · Task 2」），发之前就能改（设计第 4.1 条）。
 */
function HomeComposer({ buddy, tasks, route, onSend }: { buddy: Buddy | null; tasks: { taskId: string; name: string }[]; route: (text: string) => RouteTarget; onSend: (text: string, target: SendTarget) => void }) {
  const [text, setText] = useState("");
  const [target, setTarget] = useState<SendTarget>("auto");
  const [guess, setGuess] = useState<RouteTarget>("main");
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLSpanElement>(null);
  const name = buddy?.name?.trim() || "伙伴";
  const nameOf = (value: RouteTarget) => (value === "main" ? name : tasks.find((task) => task.taskId === value.taskId)?.name ?? name);
  useEffect(() => {
    if (target !== "auto") return;
    const value = text.trim();
    const timer = window.setTimeout(() => setGuess(value ? route(value) : "main"), 300);
    return () => window.clearTimeout(timer);
  }, [text, target, route]);
  const label = target === "auto" ? (text.trim() ? `自动 · ${nameOf(guess)}` : "自动") : nameOf(target);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", close);
    return () => { window.removeEventListener("mousedown", close); window.removeEventListener("keydown", close); };
  }, [open]);
  const send = () => {
    const value = text.trim();
    if (!value) return;
    setText("");
    onSend(value, target);
  };
  const pick = (next: SendTarget) => { setTarget(next); setOpen(false); };
  const options: { key: string; label: string; target: SendTarget }[] = [
    { key: "auto", label: "自动", target: "auto" },
    { key: "main", label: name, target: "main" },
    ...tasks.map((task) => ({ key: task.taskId, label: task.name, target: { taskId: task.taskId } as SendTarget })),
  ];
  const current = (option: SendTarget) => (typeof option === "string" ? option === target : typeof target === "object" && target.taskId === option.taskId);
  return (
    <form className={h.composer} onSubmit={(event) => { event.preventDefault(); send(); }} data-testid="home-composer">
      <textarea rows={2} value={text} aria-label="说点什么" onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send(); } }} />
      <div className={h.composerBar}>
        <span className={h.pick} ref={menuRef}>
          <button type="button" className={h.sendTo} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} data-testid="send-to">
            <AtSign {...ICON} /><span>发给</span><b>{label}</b><ChevronDown {...ICON} />
          </button>
          {open ? (
            <span className={h.menu} data-up="" role="menu">
              {options.map((option) => (
                <button key={option.key} type="button" role="menuitemradio" aria-checked={current(option.target)} onClick={() => pick(option.target)}>{option.label}</button>
              ))}
            </span>
          ) : null}
        </span>
        <span className={h.grow} />
        <button type="submit" className={h.sendBtn} aria-label="发送" disabled={!text.trim()}><ArrowUp {...ICON} /></button>
      </div>
    </form>
  );
}
