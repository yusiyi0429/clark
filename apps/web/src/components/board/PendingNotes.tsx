"use client";

/**
 * 卡要你拿主意时（第 10 节，原型 v8.4「提到所属 Task 的主会话里」）：这个 Task 下带「待处理」的卡，按时间接在 Task 页左边的对话后面，
 * 每条带按钮：「批准」「拒绝」（这台电脑能指挥时）、「仍然通过」（验收未过）、「打开」。这些只在网页里画，不写进 Chat 的线程。
 * 手机上只有「打开」。
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { HeroButton } from "@/components/HeroButton";
import { useLocalRunner } from "@/lib/local/LocalRunnerProvider";
import { WAIT_LABEL, canCommand, isPendingWait, type BoardCard } from "@/lib/board/cards";
import { overrule } from "@/lib/board/cloud";
import { showWorkspaceToast } from "@/lib/toast";
import { cardHref } from "./CardPill";
import s from "@/styles/v2-board.module.css";

const at = (card: BoardCard) => card.session?.updatedAt ?? card.item.card?.run?.updatedAt ?? card.item.card?.handback?.finishedAt ?? card.item.updatedAt;

export function PendingNotes({ cards, handheld, onChanged }: { cards: BoardCard[]; handheld: boolean; onChanged: () => void }) {
  const list = cards.filter((card) => isPendingWait(card.wait)).sort((a, b) => at(a).localeCompare(at(b)));
  if (!list.length) return null;
  return <div className={s.notes} aria-label="等你的事项">{list.map((card) => <Note key={card.item.id} card={card} handheld={handheld} onChanged={onChanged} />)}</div>;
}

function Note({ card, handheld, onChanged }: { card: BoardCard; handheld: boolean; onChanged: () => void }) {
  const router = useRouter();
  const local = useLocalRunner();
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState<string | null>(null);
  const { item, wait, session } = card;
  const handback = item.card?.handback ?? null;
  const detail = wait === "review_failed" && handback ? `${handback.met}/${handback.total} 条达到${handback.headline ? `：${handback.headline}` : ""}`
    : item.card?.run?.lastActivity?.text ?? null;
  const decide = async (decision: "allow" | "deny") => {
    if (!session) return;
    setBusy(true);
    try {
      const { pendingPermissions } = await local.runner.getSession(session.id);
      const request = pendingPermissions[0];
      if (request) await local.runner.decidePermission(session.id, request.requestId, { decision });
      await local.refresh();
      showWorkspaceToast({ text: decision === "allow" ? "已批准" : "已拒绝" });
    } catch (error) {
      showWorkspaceToast({ text: error instanceof Error ? error.message : "没成功，请重试" });
    } finally { setBusy(false); }
  };
  const pass = async () => {
    if (!handback || !reason?.trim()) return;
    setBusy(true);
    try {
      await overrule(item.id, handback.id, reason.trim());
      showWorkspaceToast({ text: "已算通过" });
      setReason(null);
      onChanged();
    } catch (error) {
      showWorkspaceToast({ text: error instanceof Error ? error.message : "没成功，请重试" });
    } finally { setBusy(false); }
  };
  const canDecide = wait === "approval" && canCommand({ ready: local.phase === "ready", handheld, hasSession: !!session });
  return (
    <div className={s.note} data-testid="pending-note">
      <p><b>「{item.title}」</b>{wait ? WAIT_LABEL[wait] : null}{detail ? `：${detail}` : ""}</p>
      {reason !== null ? (
        <form className={s.noteReason} onSubmit={(event) => { event.preventDefault(); void pass(); }}>
          <input autoFocus value={reason} maxLength={200} placeholder="原因" aria-label="仍然通过的原因" onChange={(event) => setReason(event.target.value)} />
          <HeroButton variant="primary" size="sm" type="submit" isDisabled={busy || !reason.trim()}>仍然通过</HeroButton>
          <HeroButton variant="ghost" size="sm" onPress={() => setReason(null)}>取消</HeroButton>
        </form>
      ) : (
        <div className={s.noteActions}>
          {canDecide ? <><HeroButton variant="primary" size="sm" onPress={() => void decide("allow")} isDisabled={busy}>批准</HeroButton><HeroButton variant="secondary" size="sm" onPress={() => void decide("deny")} isDisabled={busy}>拒绝</HeroButton></> : null}
          {wait === "review_failed" && handback && !handheld ? <HeroButton variant="secondary" size="sm" onPress={() => setReason("")}>仍然通过</HeroButton> : null}
          <HeroButton variant="ghost" size="sm" onPress={() => router.push(cardHref(item.id))}>打开</HeroButton>
        </div>
      )}
    </div>
  );
}
