"use client";

import { useMemo } from "react";
import { ChevronRight } from "lucide-react";
import type { Card } from "@/lib/api/client";
import { renderCard } from "@/cards/registry";
import { payloadOf, type IssuePayload } from "@/cards/payloads";
import { BattlefieldDisplayProvider, useBattlefieldDisplay } from "@/cards/battlefieldDisplay";
import b from "@/styles/home-board.module.css";
import r from "@/styles/radar.module.css";

type Props = {
  cards: Card[];
  onCard: (card: Card) => void;
  onNavigate: (href: string) => void;
};

/** 首页固定布局：战略 → Radar/战场 → 公司能力。一个 Issue 只会出现在唯一主归属。 */
export function HomeBoard(props: Props) {
  return (
    <BattlefieldDisplayProvider>
      <HomeBoardContent {...props} />
    </BattlefieldDisplayProvider>
  );
}

function HomeBoardContent({ cards, onCard, onNavigate }: Props) {
  const display = useBattlefieldDisplay();
  const radar = cards.find((card) => card.kind === "radar");
  const battlefields = cards.filter((card) => card.kind === "battlefield");
  const issues = useMemo(() => cards.filter((card) => card.kind === "issue"), [cards]);

  const strategy = issues.filter((card) => payloadOf<IssuePayload>(card).location.level === "company");
  const capabilities = issues.filter((card) => payloadOf<IssuePayload>(card).location.level === "capability");
  const capabilityGroups = useMemo(() => {
    const groups = new Map<string, Card[]>();
    for (const card of capabilities) {
      const location = payloadOf<IssuePayload>(card).location;
      const key = location.level === "capability" ? location.capabilityId : "其他";
      groups.set(key, [...(groups.get(key) ?? []), card]);
    }
    return [...groups.entries()];
  }, [capabilities]);

  function issueRow(card: Card) {
    const payload = payloadOf<IssuePayload>(card);
    return (
      <button
        key={card.id}
        type="button"
        className={b.issue}
        data-urgency={payload.urgency.level}
        onClick={() => onNavigate(`/issues/${card.objectRef.id}`)}
        aria-label={`${payload.urgency.level === "red" ? "需要尽快决策" : "待决策"}：${card.title}`}
      >
        <span className={`${b.dot} ${b[payload.urgency.level]}`} aria-hidden="true" />
        <span className={b.issueText}>
          <span>{card.title}</span>
          {payload.urgency.decisionBy ? <small>决定期限 {payload.urgency.decisionBy.slice(0, 10)}</small> : null}
        </span>
        <ChevronRight size={14} className={b.issueArrow} aria-hidden="true" />
      </button>
    );
  }

  return (
    <div className={b.board} data-testid="decision-home">
      <div className={b.top}>
        <section className={`${b.panel} ${b.strategy}`} data-origin="strategy">
          <h2>公司战略议题</h2>
          <div className={b.strategicIssues}>
            {strategy.length ? strategy.map(issueRow) : <p className={b.empty}>暂无跨战场待决策议题</p>}
          </div>
        </section>
        <div className={b.radarWrapper}>
          {radar ? (
            <button
              type="button"
              className={`${b.panel} ${b.radar}`}
              data-origin="radar"
              onClick={() => onNavigate("/radar")}
            >
              <h2>雷达信号</h2>
              <small className={b.radarStatus}>
                {payloadOf<{ unreadCount: number }>(radar).unreadCount > 0
                  ? `${payloadOf<{ unreadCount: number }>(radar).unreadCount} 条未读`
                  : "看看外面的变化"}
              </small>
              <span className={`${r.stage} ${b.scanStage}`} aria-hidden="true">
                <span className={r.scope}>
                  <span className={r.crosshair} />
                  <span className={r.sweep} />
                  <span className={r.center} />
                </span>
              </span>
              <ChevronRight size={16} className={r.launch} aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </div>

      <div className={b.battlefieldToolbar} data-testid="battlefield-toolbar">
        <span>战场</span>
        <div className={b.modeSwitch} role="group" aria-label="战场展示方式" data-mode={display.mode}>
          <i aria-hidden="true" />
          <button type="button" aria-pressed={display.mode === "decisions"} onClick={() => display.setMode("decisions")}>
            待决策
          </button>
          <button type="button" aria-pressed={display.mode === "progress"} onClick={() => display.setMode("progress")}>
            进展
          </button>
        </div>
      </div>
      <div className={b.battlefields}>
        {battlefields.map((card) => (
          <div key={card.id} className={b.battlefield}>
            {renderCard({ card, collection: cards, onCard, onNavigate })}
          </div>
        ))}
      </div>

      <section className={`${b.panel} ${b.capabilities}`} data-origin="capabilities">
        <h2>公司能力</h2>
        {capabilityGroups.length ? (
          <div className={b.capabilityItems}>
            {capabilityGroups.map(([capabilityId, group]) => (
              <section key={capabilityId} className={b.capabilityGroup} data-capability-category={capabilityId}>
                <h3>{capabilityId}</h3>
                {group.map(issueRow)}
              </section>
            ))}
          </div>
        ) : (
          <p className={b.empty}>暂无需要关注的能力建设议题</p>
        )}
      </section>
    </div>
  );
}
