"use client";

/**
 * 首页（新首页设计 5.4.4）：页头「11 月 7 日 周六」，从上到下是 等你（有才画）→ 各 Mission 的 Task → 输入框；区块之间 32，Mission 之间 16。
 * - 等你：一件两行（原话；来源 · 哪件 Task · 截止）。短的（批准、单选、合回、开工、岗位建议）在行尾就地答，推荐的那个是次按钮、另一个弱按钮；
 *   答完这一行变成状态词（「已批准」）停 2 秒再收走，不弹 toast。行首不放强调色点（组头已经写了「等你」）。
 * - Task 现状行：和左栏 Task 行同一个样子；小字「等你 1 · 进行中 2 · 已排队 1」（等你用计数样式），行尾「11/20 验收」。点了进 Task 管线。
 * - 输入框：ComposerPill；左下「发给」默认自动（打字停下 300ms 后问一次分发接口，只认最后一次），也能选伙伴或某件 Task；发出去以后跳进那条对话。
 */
import { useEffect, useRef, useState } from "react";
import { Dropdown, Header } from "@heroui/react";
import { Check, ChevronDown } from "lucide-react";
import type { Buddy } from "@/components/buddy/useBuddy";
import { HeroButton } from "@/components/HeroButton";
import { localOptions, oneTap } from "@/components/work/decisions";
import { useHandheld } from "@/components/ui/useHandheld";
import { ComposerAction, ComposerPill } from "@/conversation/ComposerPill";
import { useLocalRunner } from "@/lib/local/LocalRunnerProvider";
import { decideProposal } from "@/lib/team/roles";
import { canCommandHere, decide } from "@/lib/work/actions";
import { mergeCard } from "@/lib/work/merge";
import { monthLabel, statusParts, taskHref, waitingHref } from "@/lib/home/derive";
import type { HomeMission, RouteTarget, WaitingItem, WorkHomeData } from "@/lib/home/types";
import type { WorkHomeApi } from "@/lib/home/useWorkHome";
import { ICON } from "./StateIcon";
import h from "@/styles/home.module.css";

export type SendTarget = "auto" | RouteTarget;

export function HomeView({ data, api, buddy, today, go, route, onSend }: {
  data: WorkHomeData;
  api: WorkHomeApi;
  buddy: Buddy | null;
  /** 「11 月 7 日 周六」：页头和「今天」行一样。 */
  today: string;
  go: (href: string) => void;
  /** 「自动」会发去哪（打字时实时显示）。 */
  route: (text: string) => Promise<RouteTarget>;
  onSend: (text: string, target: SendTarget) => void;
}) {
  const missions = data.missions.filter((mission) => mission.tasks.length);
  return (
    <div className={h.homeView} data-testid="home-view">
      <header className={h.viewHead}><h1 className={h.viewTitle} tabIndex={-1}>{today}</h1></header>
      <div className={h.homeScroll}>
        <div className={h.homeInner}>
          {data.waiting.length ? (
            <section aria-label="等你" className={h.section}>
              <p className={h.sectionTitle}>等你 <span>{data.waiting.length}</span></p>
              <WaitingList items={data.waiting} api={api} go={go} />
            </section>
          ) : null}
          {api.planFailed ? (
            <section aria-label="Task" className={h.section}>
              <p className={h.planFailed} data-testid="plan-read-failed">本体读取失败<HeroButton variant="ghost" size="sm" onPress={() => void api.retryPlan()}>重试</HeroButton></p>
            </section>
          ) : null}
          {missions.length ? (
            <section aria-label="Task" className={h.section}>
              {missions.map((mission) => (
                <div key={mission.missionId} className={h.taskList}>
                  <p className={h.sectionTitle}>{mission.period !== data.period ? <span>{monthLabel(mission.period)} · </span> : null}{mission.title}</p>
                  {mission.tasks.map((task) => {
                    const { needsYou, rest } = statusParts(task);
                    return (
                      <button key={task.taskId} type="button" className={h.taskLine} onClick={() => go(taskHref(task.taskId))} data-testid="home-task">
                        <span className={h.taskText}>
                          <span className={h.taskName}>{task.name}</span>
                          <span className={h.taskSub}>
                            {needsYou ? <span className={h.count}><i aria-hidden />等你 {needsYou}</span> : null}
                            {rest.length ? <span>{needsYou ? " · " : ""}{rest.join(" · ")}</span> : null}
                          </span>
                        </span>
                        {task.subtitle ? <span className={h.taskGate}>{task.subtitle}</span> : null}
                      </button>
                    );
                  })}
                </div>
              ))}
            </section>
          ) : null}
        </div>
      </div>
      <HomeComposer buddy={buddy} missions={missions} route={route} onSend={onSend} />
    </div>
  );
}

type Action = { label: string; done: string; primary?: boolean; run: () => Promise<unknown> };

/**
 * 等你的一件能就地答的（5.4.4「就地答」）：本机上的批准、提问、合回只在那台电脑上能答（契约的 deviceId），
 * 答案直接回给那个子会话；手机上、别的电脑上整行点进去看。
 */
function useActions(api: WorkHomeApi) {
  const local = useLocalRunner();
  const handheld = useHandheld();
  const ready = local.phase === "ready";
  return (item: WaitingItem): Action[] => {
    if (item.deviceId && api.deviceId && item.deviceId !== api.deviceId) return [];
    const worker = item.sessionId ? api.work.workers.find((entry) => entry.session?.id === item.sessionId) : undefined;
    if (worker && (item.kind === "approval" || item.kind === "question") && !canCommandHere(worker, ready, handheld)) return [];
    if (item.kind === "approval" && worker) return [{ label: "批准", done: "已批准", primary: true, run: () => decide(local.runner, worker, "allow") }];
    if (item.kind === "question" && worker?.session?.pendingQuestion) {
      const question = worker.session.pendingQuestion;
      const session = worker.session;
      if (!oneTap(question) || question.questions[0]!.options.length > 3) return [];
      const { options, order } = localOptions(question.questions[0]!.options);
      return options.slice(0, 2).map((option, index) => ({
        label: option.label, done: "已回答", primary: index === 0,
        run: () => local.runner.answerQuestion(session.id, question.requestId, { choices: [[question.questions[0]!.options[order[index]!]!.label]] }),
      }));
    }
    if (item.kind === "role" && item.open.kind === "role") {
      const id = item.open.id;
      return [{ label: "采纳", done: "已采纳", primary: true, run: () => decideProposal(id, "accept") }, { label: "不要", done: "已回答", run: () => decideProposal(id, "dismiss") }];
    }
    if (item.kind === "merge" && item.sessionId) {
      const session = local.sessions.find((entry) => entry.id === item.sessionId);
      if (!session || handheld) return [];
      const base = session.workspace?.kind === "worktree" ? session.workspace.baseBranch : "main";
      return [{ label: `合进 ${base}`, done: "已合回", primary: true, run: async () => { const result = await mergeCard(local.runner, session, item.source ?? ""); if (!result.ok) throw new Error(result.text); } }];
    }
    return [];
  };
}

/** 等你的一行。答完先在原处写状态词，停 2 秒再刷新（收走）；失败在原处写「失败」加「重试」，不弹 toast。 */
export function WaitingList({ items, api, go }: { items: WaitingItem[]; api: WorkHomeApi; go: (href: string) => void }) {
  const actions = useActions(api);
  const local = useLocalRunner();
  const [state, setState] = useState<Record<string, { busy?: boolean; done?: string; failed?: Action }>>({});
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach((timer) => window.clearTimeout(timer)), []);
  const run = async (item: WaitingItem, action: Action) => {
    setState((current) => ({ ...current, [item.id]: { busy: true } }));
    try {
      await action.run();
      setState((current) => ({ ...current, [item.id]: { done: action.done } }));
      timers.current.push(window.setTimeout(() => { void Promise.all([local.refresh(), api.refresh()]); }, 2000));
    } catch {
      setState((current) => ({ ...current, [item.id]: { failed: action } }));
    }
  };
  return (
    <ul className={h.waiting} data-testid="waiting-list">
      {items.map((item) => {
        const buttons = actions(item);
        const row = state[item.id];
        return (
          <li key={item.id} className={h.wait} data-kind={item.kind} data-done={row?.done ? "" : undefined}>
            <button type="button" className={h.waitMain} onClick={() => go(waitingHref(item))}>
              <span className={h.waitTitle}>{item.title}</span>
              {item.source ? <span className={h.waitSource}>{item.source}</span> : null}
            </button>
            <span className={h.waitActs}>
              {row?.done ? <span className={h.waitDone}>{row.done}</span>
                : row?.failed ? <><span className={h.waitFailed}>失败</span><HeroButton variant="ghost" size="sm" onPress={() => void run(item, row.failed!)}>重试</HeroButton></>
                : buttons.map((action) => (
                  <HeroButton key={action.label} variant={action.primary ? "tertiary" : "ghost"} size="sm" isDisabled={row?.busy} onPress={() => void run(item, action)}>{action.label}</HeroButton>
                ))}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * 首页底部的输入框（5.4.3「输入框和『发给』」）：ComposerPill，占位「说点什么…」；左下「发给」默认自动，回车发出，跳进那条对话。
 * 「发给」是选择器的触发器：「发给」淡色 + 目标墨色 + ChevronDown；点开是弹层：自动、伙伴，再按 Mission 列出 Task，当前那项行尾一个勾。
 */
export function HomeComposer({ buddy, missions, route, onSend }: { buddy: Buddy | null; missions: HomeMission[]; route: (text: string) => Promise<RouteTarget>; onSend: (text: string, target: SendTarget) => void }) {
  const [text, setText] = useState("");
  const [target, setTarget] = useState<SendTarget>("auto");
  const [guess, setGuess] = useState<RouteTarget>("main");
  const asked = useRef(0);
  const name = buddy?.name?.trim() || "伙伴";
  const tasks = missions.flatMap((mission) => mission.tasks);
  const nameOf = (value: RouteTarget) => (value === "main" ? name : tasks.find((task) => task.taskId === value.taskId)?.name ?? name);
  useEffect(() => {
    if (target !== "auto") return;
    const value = text.trim();
    const timer = window.setTimeout(() => {
      const ask = ++asked.current;
      if (!value) { setGuess("main"); return; }
      void route(value).then((next) => { if (ask === asked.current) setGuess(next); });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [text, target, route]);
  const label = target === "auto" ? (text.trim() ? `自动 · ${nameOf(guess)}` : "自动") : nameOf(target);
  const send = () => {
    const value = text.trim();
    if (!value) return;
    setText("");
    onSend(value, target);
  };
  const keyOf = (value: SendTarget) => (value === "auto" || value === "main" ? value : `task:${value.taskId}`);
  const current = keyOf(target);
  const pick = (key: string) => setTarget(key === "auto" || key === "main" ? key : { taskId: key.slice(5) });
  const item = (key: string, text: string) => (
    <Dropdown.Item key={key} id={key} textValue={text} className={h.menuItem}><span className={h.grow}>{text}</span>{current === key ? <Check {...ICON} /> : null}</Dropdown.Item>
  );
  return (
    <div className={h.composerDock}>
      <ComposerPill tone="agent" onSubmit={send}
        leading={(
          <Dropdown>
            <Dropdown.Trigger className={h.sendTo} data-testid="send-to"><span className={h.sendToLabel}>发给</span><b>{label}</b><ChevronDown {...ICON} /></Dropdown.Trigger>
            <Dropdown.Popover placement="top start" offset={8} className={h.pop}>
              <Dropdown.Menu aria-label="发给" className={h.menuList} onAction={(key) => pick(String(key))}>
                <Dropdown.Section className={h.menuSection}>
                  {item("auto", "自动")}
                  {item("main", name)}
                </Dropdown.Section>
                {missions.map((mission) => (
                  <Dropdown.Section key={mission.missionId} className={h.menuSection}>
                    <Header className={h.menuHeader}>{mission.title}</Header>
                    {mission.tasks.map((task) => item(`task:${task.taskId}`, task.name))}
                  </Dropdown.Section>
                ))}
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown>
        )}
        field={(
          <textarea rows={1} value={text} aria-label="说点什么" placeholder="说点什么…" onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send(); } }} />
        )}
        action={<ComposerAction state="send" isDisabled={!text.trim()} />} />
    </div>
  );
}
