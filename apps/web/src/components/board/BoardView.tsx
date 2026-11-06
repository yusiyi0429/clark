"use client";

/**
 * Task 页右边的看板（原型 v8.4 .board）：待开始 · 进行中 · 验收中 · 已完成，最右一列交付物。
 * 待开始里先放伙伴拆出来的草稿（虚线，「放进看板」「不要」，列头「全部放进」），再放卡；没有草稿时底下是「拆卡」。
 */
import { useState } from "react";
import type { THomePlanTask } from "@warmap/contracts";
import { HeroButton } from "@/components/HeroButton";
import { STAGES, byStage, elsewhere, type BoardCard, type CardItem } from "@/lib/board/cards";
import { acceptDrafts, dismissDraft, planCards } from "@/lib/board/cloud";
import type { TaskBoard } from "@/lib/board/useTaskBoard";
import { showWorkspaceToast } from "@/lib/toast";
import { DraftCard, KanbanCard } from "./KanbanCard";
import { DeliverableColumn } from "./DeliverableColumn";
import s from "@/styles/v2-board.module.css";

export function BoardView({ board, task, cards, canStart, deviceId, now, onStart, onChanged }: {
  board: TaskBoard; task: THomePlanTask; cards: BoardCard[]; canStart: (card: BoardCard) => boolean; deviceId: string | null; now: number;
  onStart: (item: CardItem) => void; onChanged: () => void;
}) {
  return (
    <div className={s.board} data-testid="board">
      <TodoColumn board={board} cards={byStage(cards, "todo")} taskId={task.taskId} canStart={canStart} deviceId={deviceId} now={now} onStart={onStart} onChanged={onChanged} />
      {STAGES.slice(1).map((stage) => {
        const list = byStage(cards, stage.id);
        return (
          <div key={stage.id} className={s.col} data-stage={stage.id}>
            <div className={s.colHead}><b>{stage.label}</b>{list.length}</div>
            {list.length ? list.map((card) => <KanbanCard key={card.item.id} card={card} canStart={false} elsewhere={elsewhere(card.item, deviceId)} onStart={() => undefined} now={now} />) : <div className={s.emptyCol} />}
          </div>
        );
      })}
      <DeliverableColumn task={task} board={board} onChanged={onChanged} />
    </div>
  );
}

function TodoColumn({ board, cards, taskId, canStart, deviceId, now, onStart, onChanged }: {
  board: TaskBoard; cards: BoardCard[]; taskId: string; canStart: (card: BoardCard) => boolean; deviceId: string | null; now: number;
  onStart: (item: CardItem) => void; onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState("");
  const drafts = board.drafts;
  const planning = board.plan?.status === "queued" || board.plan?.status === "running";
  const act = async (run: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try { await run(); if (done) showWorkspaceToast({ text: done }); onChanged(); } catch (error) { showWorkspaceToast({ text: error instanceof Error ? error.message : "没成功，请重试" }); } finally { setBusy(false); }
  };
  const plan = () => act(() => planCards(taskId, hint.trim() || undefined), undefined).then(() => setHint(""));
  const elapsed = board.plan?.startedAt ?? board.plan?.createdAt;
  return (
    <div className={s.col} data-stage="todo">
      <div className={s.colHead}><b>待开始</b>{cards.length + drafts.length}
        <span className={s.grow} />
        {drafts.length > 1 ? <button type="button" className={s.headAction} disabled={busy} onClick={() => void act(() => acceptDrafts(taskId, drafts.map((draft) => ({ id: draft.id }))), `已放进看板 ${drafts.length} 张`)}>全部放进</button> : null}
      </div>
      {drafts.map((draft) => (
        <DraftCard key={draft.id} draft={draft} busy={busy}
          onAccept={() => void act(() => acceptDrafts(taskId, [{ id: draft.id }]), "已放进看板")}
          onDismiss={() => void act(() => dismissDraft(draft.id))} />
      ))}
      {cards.map((card) => <KanbanCard key={card.item.id} card={card} canStart={canStart(card)} elsewhere={elsewhere(card.item, deviceId)} onStart={() => onStart(card.item)} now={now} />)}
      {planning ? (
        <div className={s.planning}><span className={s.spin} aria-hidden />正在拆 · {Math.max(0, Math.round((now - Date.parse(elapsed ?? new Date(now).toISOString())) / 1000))} 秒 / 预计 {board.plan?.expectedSeconds} 秒</div>
      ) : !drafts.length ? (
        <form className={s.planForm} onSubmit={(event) => { event.preventDefault(); void plan(); }}>
          <input value={hint} maxLength={500} placeholder="想怎么拆（可不填）" aria-label="想怎么拆" onChange={(event) => setHint(event.target.value)} />
          <HeroButton variant={cards.length ? "secondary" : "primary"} size="sm" type="submit" isDisabled={busy || board.fallback}>拆卡</HeroButton>
        </form>
      ) : null}
      {board.plan?.status === "failed" ? <p className={s.planError} role="alert">{board.plan.error ?? "没拆成，请重试"}</p> : null}
    </div>
  );
}

