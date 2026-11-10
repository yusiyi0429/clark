"use client";

/**
 * 页头「验收标准」（原型 v8.4 treeHtml）：Task → 验收标准 → 各执行事项，平时不放在页面上，点了才出来。
 * 每条标准下写几件在哪一步，对「其他」的卡另起一组。
 */
import Link from "next/link";
import { Popover } from "ts-design/primitives";
import { TianshuPortalTheme } from "ts-design";
import type { THomePlanTask } from "@warmap/contracts";
import { HeroButton } from "@/components/HeroButton";
import { STAGES, WAIT_LABEL, circled, type BoardCard } from "@/lib/board/cards";
import type { TaskBoard } from "@/lib/board/useTaskBoard";
import { cardHref } from "./CardPill";
import s from "@/styles/v2-board.module.css";
import m from "@/styles/account-menu.module.css";

export function criterionSummary(cards: BoardCard[]): string {
  if (!cards.length) return "暂无事项";
  const pending = cards.filter((card) => card.wait && card.wait !== "blocked").length;
  const blocked = cards.filter((card) => card.wait === "blocked").length;
  const parts = [pending ? `${pending} 件待处理` : null, blocked ? `${blocked} 件受阻` : null,
    ...STAGES.map((stage) => { const n = cards.filter((card) => card.stage === stage.id && !card.wait).length; return n ? `${n} 件${stage.label}` : null; })];
  return parts.filter(Boolean).join(" · ");
}

export function CriteriaTree({ board, task, cards }: { board: TaskBoard; task: THomePlanTask | null; cards: BoardCard[] }) {
  const other = cards.filter((card) => !card.item.card?.criterion);
  const groups = [
    ...board.criteria.map((criterion) => ({ key: String(criterion.index), mark: circled(criterion.index), text: criterion.text, cards: cards.filter((card) => card.item.card?.criterion?.index === criterion.index) })),
    ...(other.length ? [{ key: "other", mark: "·", text: "其他", cards: other }] : []),
  ];
  return (
    <Popover>
      <HeroButton variant="secondary" size="sm">验收标准</HeroButton>
      <Popover.Content placement="bottom end" offset={8} className={m.popover}>
        <TianshuPortalTheme>
          <Popover.Dialog className={s.tree} aria-label="验收标准">
            <div className={s.treeRoot}><b>{task?.name ?? "Task"}</b><small>{board.criteria.length} 条</small></div>
            <div className={s.treeKids}>
              {groups.map((group) => (
                <div key={group.key} className={s.treeCrit}>
                  <span className={s.crit}>{group.mark}</span>
                  <p>{group.text}</p>
                  <small>{criterionSummary(group.cards)}</small>
                  {group.cards.length ? (
                    <div className={s.treeCards}>
                      {group.cards.map((card) => (
                        <Link key={card.item.id} href={cardHref(card.item.id)} className={s.treeCard}>
                          <span>{card.item.title}</span>
                          <span className={s.tag} data-tone={card.wait ? (card.wait === "approval" || card.wait === "reply" ? "wait" : "warn") : card.stage === "done" ? "done" : undefined}>
                            {card.wait ? WAIT_LABEL[card.wait] : STAGES.find((stage) => stage.id === card.stage)?.label}
                          </span>
                        </Link>
                      ))}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </Popover.Dialog>
        </TianshuPortalTheme>
      </Popover.Content>
    </Popover>
  );
}
