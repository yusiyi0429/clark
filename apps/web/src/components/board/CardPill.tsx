"use client";

/**
 * 本月泳道格子里的小卡（原型 v8.4 pill）：待开始写执行方和标题；进行中有个呼吸点和「3/6」；验收中写「验收中」；
 * 带标记的先写标记词（等你批准、等你回复、已暂停、验收未过、受阻）；已完成打勾。点开是卡的子会话页。
 */
import Link from "next/link";
import type { BoardCard } from "@/lib/board/cards";
import { WAIT_LABEL, isAgentCard, waitTone } from "@/lib/board/cards";
import s from "@/styles/v2-month.module.css";

export const cardHref = (id: string) => `/me/cards/${encodeURIComponent(id)}`;

/** 进行中走到第几步：本机会话没折出计划时用云端摘要。 */
export function stepText(card: BoardCard): string | null {
  const plan = card.item.card?.run?.plan;
  if (plan && plan.total) return `${Math.min(plan.total, plan.done + 1)}/${plan.total}`;
  return null;
}

export function Glyph({ agent }: { agent: boolean }) {
  return agent ? <i className={s.glyph} aria-label="Claude Code">&gt;_</i> : <i className={s.glyph} data-self aria-label="本人">我</i>;
}

export function CardPill({ card }: { card: BoardCard }) {
  const { item, stage, wait } = card;
  const common = { href: cardHref(item.id), className: s.pill, title: item.title, "data-card": item.id };
  if (wait) return <Link {...common} data-tone={waitTone(wait)}><b>{WAIT_LABEL[wait]}</b><span>{item.title}</span></Link>;
  if (stage === "done") return <Link {...common} data-done><span className={s.ok} aria-hidden>✓</span><span>{item.title}</span></Link>;
  if (stage === "review") return <Link {...common}><span className={s.pulse} aria-hidden /><span>{item.title}</span><em>验收中</em></Link>;
  if (stage === "doing") {
    const step = stepText(card);
    return <Link {...common}><span className={s.pulse} aria-hidden /><span>{item.title}</span>{step ? <em>{step}</em> : null}</Link>;
  }
  return <Link {...common}><Glyph agent={isAgentCard(item)} /><span>{item.title}</span></Link>;
}
