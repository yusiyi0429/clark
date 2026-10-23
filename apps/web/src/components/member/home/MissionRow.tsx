"use client";

/**
 * Mission 卡片里时间轴下面那一行 Mission 切换（照样稿 home-tabs-v5）：只靠字号分选中，不画底线。
 * - 选「全部」：「全部」大字，其余 Mission 中号灰字；选某个 Mission：它大字，其余（含「全部」）更小更淡（data-size 记 large / medium / small）。
 * - 「全部」后面小字是 Mission 个数；每个 Mission 带色点，没选中的长名字截断，选中的写全。
 * - 一行放不下时横向滑动，右边还有没露出来的就渐隐（data-more）。
 * - 回退显示上个月时行尾写「M 月」；聚焦的 Mission 有任务卡时行尾出「Mission 卡 ›」。
 */
import { useEffect, useRef, useState } from "react";
import { Button } from "ts-design/primitives";
import type { THomePlanResponse } from "@warmap/contracts";
import { tone, type Navigate } from "./planFormat";
import s from "@/styles/mission-plan-card.module.css";

export function MissionRow({ plan, focus, onChoose, onNavigate }: {
  plan: THomePlanResponse;
  focus: string | null;
  onChoose: (missionId: string | null) => void;
  onNavigate: Navigate;
}) {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const [more, setMore] = useState(false);
  // 每一项的宽度都看着（选中时字号有过渡），右边还有没滑到的就渐隐；滑到头就不隐。
  useEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    const check = () => setMore(row.scrollLeft + row.clientWidth < row.scrollWidth - 1);
    const observer = new ResizeObserver(check);
    observer.observe(row);
    for (const tab of row.children) observer.observe(tab);
    row.addEventListener("scroll", check, { passive: true });
    return () => {
      observer.disconnect();
      row.removeEventListener("scroll", check);
    };
  }, [plan.missions]);
  // 选中的那项放大后可能伸出行的右边：等字号过渡完，只在这一行里横向滚到它（不动整页）。
  useEffect(() => {
    const row = rowRef.current;
    const tab = row?.querySelector('[aria-selected="true"]');
    if (!row || !tab) return;
    const timer = setTimeout(() => {
      const box = row.getBoundingClientRect(), at = tab.getBoundingClientRect();
      const by = at.left < box.left ? at.left - box.left : at.right > box.right ? Math.min(at.right - box.right, at.left - box.left) : 0;
      if (by) row.scrollBy({ left: by, behavior: "smooth" });
    }, 240);
    return () => clearTimeout(timer);
  }, [focus]);

  const size = (selected: boolean) => (selected ? "large" : focus === null ? "medium" : "small");
  const cardId = plan.missions.find((mission) => mission.missionId === focus)?.cardId;
  return (
    <div className={s.switcher}>
      <div ref={rowRef} className={s.missions} role="tablist" aria-label="Mission" data-more={more || undefined}>
        <button type="button" role="tab" className={s.mission} data-mission="all" data-size={size(focus === null)} aria-selected={focus === null} onClick={() => onChoose(null)}>
          <span className={s.name}>全部</span>
          <span className={s.total}>{plan.missions.length}</span>
        </button>
        {plan.missions.map((mission) => (
          <button key={mission.missionId} type="button" role="tab" className={s.mission} data-mission={mission.missionId} data-size={size(focus === mission.missionId)}
            aria-selected={focus === mission.missionId} title={mission.title} onClick={() => onChoose(mission.missionId)}>
            <i className={s.dot} style={tone(mission.color)} aria-hidden />
            <span className={s.name}>{mission.title}</span>
          </button>
        ))}
      </div>
      {plan.fallbackFrom ? <span className={s.month}>{Number(plan.fallbackFrom.slice(5, 7))} 月</span> : null}
      {cardId && (
        <Button variant="ghost" size="sm" className={s.cardLink} data-mission-card data-origin={`/me/mission-cards/${encodeURIComponent(cardId)}`}
          onPress={(event) => onNavigate(`/me/mission-cards/${encodeURIComponent(cardId)}`, event.target as Element)}>
          Mission 卡 ›
        </Button>
      )}
    </div>
  );
}
