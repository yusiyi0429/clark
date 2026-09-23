"use client";

import { useMemo } from "react";
import { ChevronRight, Flag } from "lucide-react";
import type { Card } from "@/lib/api/client";
import { renderCard } from "@/cards/registry";
import { payloadOf, type CapabilityPayload, type IssuePayload, type MissionPayload } from "@/cards/payloads";
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

/** Radar promotion 把战略影响保存在 originRef；只对 Radar Issue 显示，DRI 不虚构摘要。 */
export function radarIssueSummary(origin: IssuePayload["originRef"]): string | null {
  if (!origin || typeof origin !== "object") return null;
  const strategicImpact = (origin as { strategicImpact?: unknown }).strategicImpact;
  return typeof strategicImpact === "string" && strategicImpact.trim() ? strategicImpact.trim() : null;
}

function HomeBoardContent({ cards, onCard, onNavigate }: Props) {
  const display = useBattlefieldDisplay();
  const radar = cards.find((card) => card.kind === "radar");
  const battlefields = cards.filter((card) => card.kind === "battlefield");
  const issues = useMemo(() => cards.filter((card) => card.kind === "issue"), [cards]);
  /** Mission 只在入口显示数量与跳转，不在首页展开；数量从同一份 Card 集合算，不保存汇总。 */
  const missions = useMemo(() => cards.filter((card) => card.kind === "mission"), [cards]);

  const strategy = issues.filter((card) => payloadOf<IssuePayload>(card).location.level === "company");
  const capabilities = issues.filter((card) => payloadOf<IssuePayload>(card).location.level === "capability");
  type CapabilityItem = { id: string; code: string; sortOrder: number; name: string; group: string; outcome: string; issues: Card[] };
  /** 首页能力面板 = 注册能力（按 sortOrder）∪ Issue 派生分组；注册能力即使还没有 Issue 也要出现。 */
  const capabilityItems = useMemo(() => {
    const items = new Map<string, CapabilityItem>();
    for (const card of cards) {
      if (card.kind !== "capability") continue;
      const payload = payloadOf<CapabilityPayload>(card);
      items.set(payload.capabilityId, {
        id: payload.capabilityId,
        code: payload.code,
        sortOrder: payload.sortOrder,
        name: payload.name,
        group: payload.group,
        outcome: payload.sixMonthOutcome,
        issues: [],
      });
    }
    for (const card of capabilities) {
      const location = payloadOf<IssuePayload>(card).location;
      const key = location.level === "capability" ? location.capabilityId : "其他";
      const item = items.get(key) ?? { id: key, code: "", sortOrder: Number.MAX_SAFE_INTEGER, name: key, group: "", outcome: "", issues: [] };
      item.issues.push(card);
      items.set(key, item);
    }
    return [...items.values()].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  }, [cards, capabilities]);

  function issueRow(card: Card) {
    const payload = payloadOf<IssuePayload>(card);
    const summary = payload.origin === "radar" ? radarIssueSummary(payload.originRef) : null;
    const summaryId = `issue-summary-${card.objectRef.id}`;
    return (
      <button
        key={card.id}
        type="button"
        className={b.issue}
        data-urgency={payload.urgency.level}
        onClick={() => onNavigate(`/issues/${card.objectRef.id}`)}
        aria-label={`${payload.urgency.level === "red" ? "需要尽快决策" : "待决策"}：${card.title}`}
        {...(summary ? { "aria-describedby": summaryId } : {})}
      >
        <span className={`${b.dot} ${b[payload.urgency.level]}`} aria-hidden="true" />
        <span className={b.issueText}>
          <span>{card.title}</span>
          {payload.urgency.decisionBy ? <small>决定期限 {payload.urgency.decisionBy.slice(0, 10)}</small> : null}
          {summary ? <span id={summaryId} className={b.issuePreview} role="tooltip">{summary}</span> : null}
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
          <div className={b.divider} aria-hidden="true" />
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
        <button type="button" className={b.missionEntry} onClick={() => onNavigate("/missions")}>
          <Flag size={13} aria-hidden="true" />
          查看 {missions.length} 个 Mission
        </button>
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
        <div className={b.divider} aria-hidden="true" />
        {capabilityItems.length ? (
          <div className={b.capabilityItems}>
            {capabilityItems.map((item) => (
              <section key={item.id} className={b.capabilityGroup} data-capability-category={item.id}>
                <h3>
                  {item.code ? <span className={b.capabilityCode}>{item.code}</span> : null}
                  {item.name}
                  {item.group ? <small className={b.capabilityCategory}>{item.group}</small> : null}
                </h3>
                {item.outcome ? <p className={b.capabilityOutcome}>{item.outcome}</p> : null}
                {item.code ? (
                  <button
                    type="button"
                    className={b.capabilityMissions}
                    onClick={() => onNavigate(`/missions?capabilityId=${encodeURIComponent(item.id)}`)}
                  >
                    <Flag size={11} aria-hidden="true" />
                    Mission · {missions.filter((card) => payloadOf<MissionPayload>(card).capabilityId === item.id).length}
                  </button>
                ) : null}
                {item.issues.length ? item.issues.map(issueRow) : <p className={b.empty}>暂无待决策议题</p>}
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
