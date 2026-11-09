"use client";

/**
 * Task 页（/me/month/tasks/[taskId]，原型 v8.4 taskView，第 11.1、11.2 节）：
 * 左栏 340 是伙伴的主会话（总线程，页头挂这个 Task 的标签；要你拿主意的卡插在对话后面），右边面包屑「本月 › Mission › Task」和看板：
 * 待开始 · 进行中 · 验收中 · 已完成，最右一列交付物。没卡的 Task，「待开始」里只有「拆卡」。
 * 959 及以下：「看板」「对话」两个页签，看板按列分组成列表；本机的卡只能看。
 */
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { useBuddy } from "@/components/buddy/useBuddy";
import { useHomePlan } from "@/components/member/home/useHomePlan";
import { useHandheld } from "@/components/ui/useHandheld";
import { StartDialog } from "@/components/local/StartDialog";
import { ChatPane } from "@/components/rail/ChatPane";
import { useLocalRunner } from "@/lib/local/LocalRunnerProvider";
import { startCard } from "@/lib/local/start";
import { cardRole } from "@/lib/team/roles";
import { STAGES, WAIT_LABEL, boardCards, byStage, canStartCard, elsewhere, isAgentCard, waitTone, type BoardCard, type CardItem } from "@/lib/board/cards";
import { useTaskBoard } from "@/lib/board/useTaskBoard";
import { useAutoReturn } from "@/lib/board/useAutoReturn";
import { showWorkspaceToast } from "@/lib/toast";
import { CriteriaTree } from "./CriteriaTree";
import { BoardView } from "./BoardView";
import { PendingNotes } from "./PendingNotes";
import { cardHref } from "./CardPill";
import { gateOf, gateText } from "./MonthLanes";
import s from "@/styles/v2-board.module.css";
import c from "@/styles/v2-chat.module.css";

export function TaskPage({ taskId }: { taskId: string }) {
  const router = useRouter();
  const { plan } = useHomePlan();
  const { buddy } = useBuddy();
  const local = useLocalRunner();
  const handheld = useHandheld();
  const { board, refresh } = useTaskBoard(taskId, plan);
  const [tab, setTab] = useState<"board" | "chat">("board");
  const [starting, setStarting] = useState<CardItem | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 30_000); return () => window.clearInterval(timer); }, []);

  const task = plan?.tasks.find((entry) => entry.taskId === taskId) ?? null;
  const mission = plan?.missions.find((entry) => entry.missionId === task?.missionId) ?? null;
  const ready = local.phase === "ready";
  const sessions = ready ? local.sessions : [];
  const cards = useMemo(() => boardCards(board?.cards ?? [], sessions), [board?.cards, sessions]);
  const deviceId = local.status?.deviceId ?? null;
  useAutoReturn(local.runner, ready, board?.cards ?? [], sessions, () => void refresh());

  const canStart = (card: BoardCard) => canStartCard({ ready, handheld, item: card.item });
  const start = async (item: CardItem, model: Parameters<typeof startCard>[2], cwd: string, role: Parameters<typeof startCard>[4], effort: Parameters<typeof startCard>[5]) => {
    const begun = performance.now();
    const session = await startCard(local.runner, item, model, cwd, role, effort);
    setStarting(null);
    await local.refresh();
    showWorkspaceToast({ text: `开始了 · ${model.label}` });
    try { sessionStorage.setItem(`tianshu-start-${session.id}`, String(begun)); } catch { /* 只是量开工耗时 */ }
    router.push(cardHref(item.id));
  };

  const tag = task ? (
    <div className={c.sideHead}>
      <span className={c.taskTag} style={{ ["--c" as string]: mission?.color }}><i aria-hidden /><span>{task.name}</span></span>
    </div>
  ) : null;
  const chat = <ChatPane buddy={buddy} variant="side" head={tag} extra={<PendingNotes cards={cards} handheld={handheld} onChanged={() => void refresh()} />} />;

  if (handheld) {
    return (
      <div className={s.phoneTask} data-testid="task-page">
        <Link href="/me/month" className={s.back}><ChevronLeft size={16} aria-hidden />本月</Link>
        <div className={s.phoneHead}>
          {mission ? <span className={s.phoneMission} style={{ ["--c" as string]: mission.color }}><i aria-hidden />{mission.title}{plan ? ` · ${gateText(gateOf(plan, mission.missionId)) ?? ""}` : ""}</span> : null}
          <h1>{task?.name ?? "Task"}</h1>
        </div>
        <div className={s.phoneBar}>
          <div className={s.seg} role="tablist">
            <button type="button" role="tab" aria-selected={tab === "board"} onClick={() => setTab("board")}>看板</button>
            <button type="button" role="tab" aria-selected={tab === "chat"} onClick={() => setTab("chat")}>对话</button>
          </div>
          {board ? <CriteriaTree board={board} task={task} cards={cards} /> : null}
        </div>
        {tab === "chat" ? <div className={s.phoneChat}>{chat}</div> : (
          <div className={s.phoneGroups}>
            {STAGES.map((stage) => {
              const list = byStage(cards, stage.id);
              if (!list.length) return null;
              return (
                <section key={stage.id} className={s.phoneGroup} aria-label={stage.label}>
                  <h2>{stage.label}<span>{list.length}</span></h2>
                  <div className={s.phoneItems}>{list.map((card) => <PhoneItem key={card.item.id} card={card} deviceName={elsewhere(card.item, null)} />)}</div>
                </section>
              );
            })}
            {!cards.length ? <p className={s.none}>还没有执行事项</p> : null}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={s.taskPage} data-testid="task-page">
      <aside className={s.side}>{chat}</aside>
      <div className={s.boardArea}>
        <div className={s.crumbs}>
          <Link href="/me/month" className={s.crumbLink}>本月</Link><span aria-hidden>›</span>
          {mission ? <><span className={s.dot} style={{ background: mission.color }} aria-hidden /><span className={s.crumbMission}><small>Mission</small>{mission.title}</span><span aria-hidden>›</span></> : null}
          <b>{task?.name ?? "Task"}</b>
          <span className={s.grow} />
          {plan && mission ? <span className={s.gate}>{gateText(gateOf(plan, mission.missionId))}</span> : null}
          {board ? <CriteriaTree board={board} task={task} cards={cards} /> : null}
        </div>
        {board && task ? (
          <div className={s.boardScroll}>
            <BoardView board={board} task={task} cards={cards} canStart={canStart} deviceId={deviceId} now={now} onStart={setStarting} onChanged={() => void refresh()} />
          </div>
        ) : <div className={s.loading} aria-busy />}
      </div>
      {starting ? <StartDialog title={starting.title} role={cardRole(starting)} onClose={() => setStarting(null)} onStart={(model, folder, role, effort) => start(starting, model, folder?.path ?? "", role, effort)} /> : null}
    </div>
  );
}

function PhoneItem({ card, deviceName }: { card: BoardCard; deviceName: string | null }) {
  const { item, wait } = card;
  const plan = item.card?.run?.plan;
  const meta = wait ? item.card?.run?.lastActivity?.text ?? null
    : card.stage === "doing" ? plan?.current ? `${plan.current} ${Math.min(plan.total, plan.done + 1)}/${plan.total}` : "进行中"
    : card.stage === "review" ? "Agent 验收中"
    : card.stage === "done" ? item.card?.deliverable ? (item.card.deliverable.state === "included" ? `已纳入 v${item.card.deliverable.versionNumber}` : `v${item.card.deliverable.versionNumber} 准备中`) : "已完成"
    : isAgentCard(item) ? "Claude Code" : "我自己";
  return (
    <Link href={cardHref(item.id)} className={s.phoneItem}>
      <b>{item.title}</b>
      {wait ? <span className={s.tag} data-tone={waitTone(wait)}>{WAIT_LABEL[wait]}</span> : <span />}
      <small>{deviceName ? `在 ${deviceName} 上跑 · ` : ""}{meta}</small>
    </Link>
  );
}

