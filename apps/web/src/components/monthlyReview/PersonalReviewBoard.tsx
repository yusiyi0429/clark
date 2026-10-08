"use client";

/**
 * 通知栏里的「个人复盘」看板（spec personal-review §3–§5）：全员看得到谁交了、谁没交（看不到内容），给没交的人一点压力。
 * 个人复盘由 Co-Agent 先按天枢里的材料起草；本人看过、改好后提交。想改得更好：连了 AI 工具的复制一句话让它补充改写，没连的「授权开始」，或上传材料让 Co-Agent 重新起草。
 * CEO 对没交的人可以「不等了，继续」（逐人跳过）。
 */
import { useCallback, useEffect, useState } from "react";
import { Card as HeroCard } from "@heroui/react";
import { Check, ChevronRight } from "lucide-react";
import type { TPersonalReviewBoard, TPersonalReviewBoardRow, TPersonalReviewPayload } from "@warmap/contracts";
import { ContextMark } from "@/components/ContextMark";
import { useConfirm } from "@/components/ConfirmDialog";
import { browserApi } from "@/lib/api/client";
import { requestError } from "./reviewApi";
import { REVIEW_INSTRUCTION, openConnectionDialog, personalDone, personalStatusText, runPersonalReviewAction } from "./personalReviewApi";
import n from "@/styles/notifications.module.css";
import a from "@/styles/notice-actions.module.css";
import b from "./personal-review-board.module.css";

type Navigate = (href: string, origin?: Element | null) => void;

/** 看板是全员共享的现算视图：进页面、回到前台、复盘有变动时重读；30 秒兜底轮询。 */
export function usePersonalReviewBoard() {
  const [board, setBoard] = useState<TPersonalReviewBoard | null>(null);
  const [mine, setMine] = useState<TPersonalReviewPayload | null>(null);
  const load = useCallback(async () => {
    try {
      const { data } = await browserApi.GET("/api/personal-reviews/board");
      if (!data) return;
      setBoard(data.board);
      const self = data.board?.rows.find((row) => row.isSelf && !personalDone(row.status));
      if (!self) { setMine(null); return; }
      const detail = await browserApi.GET("/api/personal-reviews/{personalReviewId}", { params: { path: { personalReviewId: self.personalReviewId } } });
      setMine(detail.data?.review ?? null);
    } catch { /* 下次再取 */ }
  }, []);
  useEffect(() => {
    void load();
    const refresh = () => { if (document.visibilityState === "visible") void load(); };
    const timer = window.setInterval(refresh, 30_000);
    window.addEventListener("focus", refresh);
    window.addEventListener("monthly-review-changed", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("monthly-review-changed", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [load]);
  return { board, mine, reload: load };
}

export function PersonalReviewBoard({ onNavigate }: { onNavigate: Navigate }) {
  const { board, mine, reload } = usePersonalReviewBoard();
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const { ask, dialog } = useConfirm();
  if (!board || !board.rows.length) return null;

  const month = Number(board.period.slice(5));
  const done = board.counts.submitted + board.counts.skipped;
  const selfRow = board.rows.find((row) => row.isSelf);
  const copy = async () => {
    try { await navigator.clipboard.writeText(REVIEW_INSTRUCTION); setCopied(true); setError(""); }
    catch { setError("复制失败，请到复盘页手动复制。"); }
  };
  const skip = async (row: TPersonalReviewBoardRow) => {
    const action = row.actions.find((candidate) => candidate.actionType === "personal-review.skip");
    if (!action || !(await ask(`不等 ${row.personName} 了，继续？跳过会记在名单上，大家都看得到。`, "不等了，继续"))) return;
    setBusy(row.personalReviewId); setError("");
    try { await runPersonalReviewAction(action); await reload(); }
    catch (cause) { setError(requestError(cause, "没有跳过成功，请重试。")); }
    finally { setBusy(null); }
  };

  return <HeroCard<"section"> render={(props) => <section {...props} />} className={n.card} data-notice="personal-review" aria-label={`${month} 月个人复盘`}>
    <HeroCard.Header<"header"> render={(props) => <header {...props} />} className={n.glassHeader}>
      <ContextMark kind="monthly" className={n.glyph} />
      <span className={n.identity}>
        <strong>{month} 月个人复盘<b className={`${n.count} ${b.ratio}`} aria-label={`已交 ${done} / ${board.counts.total}`}>{done}/{board.counts.total}</b></strong>
        <small>{board.complete ? "已交齐，进入战场复盘" : "交齐后进入战场复盘，再到 CEO 出下月任务卡"}</small>
      </span>
    </HeroCard.Header>
    <div className={n.tray}>
      {selfRow && !personalDone(selfRow.status) ? <SelfBlock row={selfRow} mine={mine} month={month} copied={copied} onCopy={() => void copy()} onNavigate={onNavigate} /> : null}
      {selfRow && personalDone(selfRow.status) ? <p className={b.selfDone} role="status"><Check size={15} aria-hidden />你的 {month} 月复盘已提交</p> : null}
      {error ? <p className={a.error} role="alert">{error}</p> : null}
      <ul className={b.roster} aria-label="提交情况">
        {board.rows.map((row) => {
          const tone = row.status === "submitted" ? "done" : row.status === "skipped" ? "skipped" : "open";
          const skipAction = row.actions.some((candidate) => candidate.actionType === "personal-review.skip");
          const label = <><span className={b.name}>{row.personName}{row.isSelf ? <em>（你）</em> : null}</span><span className={b.state} data-tone={tone}>{personalStatusText(row.status, false)}</span></>;
          return <li key={row.personalReviewId} className={b.row} data-tone={tone}>
            {row.href
              ? <button type="button" className={b.open} onClick={(event) => onNavigate(row.href!, (event.target as Element).closest("[data-notice]"))} aria-label={`打开 ${row.personName} 的复盘`}>{label}<ChevronRight size={14} aria-hidden /></button>
              : <span className={b.open}>{label}</span>}
            {skipAction ? <button type="button" className={b.skip} disabled={busy === row.personalReviewId} onClick={() => void skip(row)}>跳过</button> : null}
          </li>;
        })}
      </ul>
    </div>
    {dialog}
  </HeroCard>;
}

function SelfBlock({ row, mine, month, copied, onCopy, onNavigate }: {
  row: TPersonalReviewBoardRow; mine: TPersonalReviewPayload | null; month: number; copied: boolean;
  onCopy: () => void; onNavigate: Navigate;
}) {
  const open = (from: Element | null) => row.href && onNavigate(row.href, from);
  const connected = mine?.toolConnected ?? false;
  const title = row.status === "draft" ? `Co-Agent 已起草你的 ${month} 月复盘，确认后提交`
    : row.status === "draft_failed" ? "起草没有成功，可以上传材料重试或直接写"
      : `Co-Agent 正在起草你的 ${month} 月复盘`;
  const detail = row.status === "draft" ? (connected ? "看一遍改好后提交；也可以复制指令让你的 AI 读手边的周复盘补充改写。没交的名字大家都看得到" : "看一遍改好后提交；想让你的 AI 帮忙补充，先授权。没交的名字大家都看得到")
    : row.status === "draft_failed" ? "按天枢里的 Mission 和进展没能起草，上传你的复盘材料再试"
      : "按你的 Mission 和执行事项进展起草，一般一两分钟";
  return <div className={a.push}>
    <div className={a.openRow}>
      <button type="button" className={n.item} data-tone="amber" onClick={(event) => open((event.target as Element).closest("[data-notice]"))} aria-label={`打开我的复盘：${title}`}>
        <span className={n.mark} aria-hidden="true" />
        <span className={n.itemText}><span>{title}</span><small>{detail}</small></span>
        <ChevronRight size={15} aria-hidden="true" />
      </button>
    </div>
    {row.status === "draft" || row.status === "draft_failed" ? <div className={a.handle}>
      <div className={a.actions}>
        <button type="button" data-emphasis="" onClick={(event) => open((event.target as Element).closest("[data-notice]"))}>{row.status === "draft" ? "去确认提交" : "上传材料重试"}</button>
        {connected
          ? <button type="button" onClick={onCopy}>{copied ? "已复制，发给你的 AI" : "复制给 AI 的指令"}</button>
          : <button type="button" onClick={openConnectionDialog}>授权开始</button>}
      </div>
    </div> : null}
  </div>;
}
