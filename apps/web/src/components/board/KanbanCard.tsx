"use client";

/**
 * Task 页看板上的一张卡（原型 v8.4 kcard，第 11.2、19.6 节）：标题、岗位和模型、对第几条标准（圆圈数字）。
 * 进行中写当前计划条目「第 3/6 步」和用时；有标记的写标记词；已完成写「已纳入 v2」或「v2 准备中」。
 * 「开始」只在本机连着、Claude Code 干的卡、这台电脑能指挥时出现；卡在别的电脑上跑，标那台电脑的名字，没有按钮。
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { TCardDraftView } from "@warmap/contracts";
import { HeroButton } from "@/components/HeroButton";
import { WAIT_LABEL, circled, deliverableLabel, waitTone, type BoardCard } from "@/lib/board/cards";
import { cardRole, draftRole } from "@/lib/team/roles";
import { Glyph, cardHref, stepText } from "./CardPill";
import s from "@/styles/v2-board.module.css";

const minutesSince = (iso: string | null | undefined, now: number) => (iso ? Math.max(0, Math.round((now - Date.parse(iso)) / 60_000)) : null);
export const elapsedText = (minutes: number | null) => minutes === null ? null : minutes < 60 ? `已用 ${minutes} 分钟` : `已用 ${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;

/** 卡上写岗位名和模型（第 19.1 节：不再写执行方）；没配岗位的不写。 */
function Role({ card }: { card: BoardCard }) {
  const role = cardRole(card.item);
  if (!role) return null;
  const model = card.session?.modelLabel ?? card.item.card?.model?.label ?? null;
  return (
    <div className={s.exec}>
      <span className={s.ex}><Glyph agent />{role.name}</span>
      {model ? <span className={s.model}>{model}</span> : null}
    </div>
  );
}

export function KanbanCard({ card, canStart, elsewhere, onStart, now }: { card: BoardCard; canStart: boolean; elsewhere: string | null; onStart: () => void; now: number }) {
  const router = useRouter();
  const { item, stage, wait } = card;
  const criterion = item.card?.criterion?.index ?? null;
  const open = () => router.push(cardHref(item.id));
  const step = stepText(card);
  const plan = item.card?.run?.plan;
  return (
    <div className={s.card} role="link" tabIndex={0} data-card={item.id} data-tone={wait ? waitTone(wait) : undefined} data-done={stage === "done" || undefined}
      onClick={(event) => { if (!(event.target as HTMLElement).closest("button, a")) open(); }}
      onKeyDown={(event) => { if (event.key === "Enter" && event.target === event.currentTarget) open(); }}>
      <Link href={cardHref(item.id)} className={s.title}>{item.title}</Link>
      {wait ? <div className={s.row}><span className={s.tag} data-tone={waitTone(wait)}>{WAIT_LABEL[wait]}</span>{item.card?.run?.lastActivity ? <span className={s.faint}>{item.card.run.lastActivity.text}</span> : null}</div> : null}
      {stage !== "done" ? <Role card={card} /> : null}
      {stage === "doing" && !wait ? (
        <>
          <div className={s.live}><span className={s.pulse} aria-hidden /><span>{plan?.current ?? "进行中"}{step ? ` ${step}` : ""}</span></div>
          {plan && plan.total ? <div className={s.bar}><span style={{ width: `${Math.round((plan.done / plan.total) * 100)}%` }} /></div> : null}
        </>
      ) : null}
      {stage === "review" ? <div className={s.live}><span className={s.pulse} aria-hidden /><span>Agent 逐条核对</span></div> : null}
      {elsewhere ? <div className={s.lockLine}>在 {elsewhere} 上跑</div> : null}
      <div className={s.foot}>
        {criterion ? <span className={s.crit} title={item.card?.criterion?.text}>{circled(criterion)}</span> : null}
        {stage === "done" ? <span className={s.faint}>{deliverableLabel(item) ?? "已完成"}</span> : null}
        <span className={s.grow} />
        {stage === "doing" && !wait ? <span className={s.faint}>{elapsedText(minutesSince(card.item.card?.run?.startedAt ?? card.session?.createdAt, now))}</span> : null}
        {stage === "todo" && canStart && !elsewhere ? <HeroButton variant="primary" size="sm" onPress={onStart}>开始</HeroButton> : null}
      </div>
    </div>
  );
}

export function DraftCard({ draft, onAccept, onDismiss, busy }: { draft: TCardDraftView; onAccept: () => void; onDismiss: () => void; busy: boolean }) {
  const role = draftRole(draft);
  return (
    <div className={s.card} data-draft data-testid="draft-card">
      <div className={s.row}><span className={s.draftTag}>草稿</span>{draft.criterionIndex ? <span className={s.crit}>{circled(draft.criterionIndex)}</span> : null}</div>
      <p className={s.title}>{draft.title}</p>
      {role ? <div className={s.exec}><span className={s.ex}><Glyph agent />{role.name}</span></div> : null}
      {draft.why ? <p className={s.why}>{draft.why}</p> : null}
      <div className={s.foot}>
        <span className={s.grow} />
        <HeroButton variant="ghost" size="sm" onPress={onDismiss} isDisabled={busy}>不要</HeroButton>
        <HeroButton variant="secondary" size="sm" onPress={onAccept} isDisabled={busy}>放进看板</HeroButton>
      </div>
    </div>
  );
}
