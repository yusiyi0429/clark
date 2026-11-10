"use client";

/**
 * 引导里选伙伴（形象、性格）：一次只放一个，放大居中，两边是上一个、下一个的影子，像游戏选角色（设计稿 17.1）。
 * 左右键、触屏左右滑、点两边的影子或箭头都能切，首尾相接。当前居中的就是选中的那个（受控：value / onChange）。
 * sealing：按下「选定」那一下，两边的影子退开，中间那个应一声。
 */

import { useEffect, useRef, type PointerEvent, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { PresenceCapsule, type CapsulePose } from "@/components/coagent/PresenceCapsule";
import { isFigureSkin, type CoAgentSkin } from "@/components/coagent/skin";
import { BUDDY_PERSONALITIES, type BuddyPersonality } from "@/components/buddy/PersonalityPicker";
import s from "./buddy-carousel.module.css";

/** 横向滑动超过这么多才算切换，免得点一下被当成滑动。 */
const SWIPE = 40;

export function BuddyCarousel<T extends string>({ items, value, onChange, label, kind, sealing = false, children }: {
  items: readonly { id: T; label: string }[];
  value: T;
  onChange: (next: T) => void;
  /** 给读屏的组名。 */
  label: string;
  /** figure：形象，放大的台子；card：性格，一张话卡。 */
  kind: "figure" | "card";
  sealing?: boolean;
  children: (id: T, active: boolean) => ReactNode;
}) {
  const count = items.length;
  const index = Math.max(0, items.findIndex((item) => item.id === value));
  const go = (delta: number) => { if (!sealing) onChange(items[(index + delta + count) % count].id); };
  const latest = useRef(go);
  latest.current = go;
  /** 刚滑过一下：松手时浏览器还会补一次点击，别让它再点中影子。 */
  const swiped = useRef(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if ((event.target as HTMLElement | null)?.closest?.("input, textarea, select, [contenteditable=true]")) return;
      event.preventDefault();
      latest.current(event.key === "ArrowLeft" ? -1 : 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /** 左右滑：在台子上按下，松开（松在哪都算）时横向挪过 SWIPE 才切。 */
  const onPointerDown = (event: PointerEvent<HTMLElement>) => {
    const start = { x: event.clientX, y: event.clientY };
    swiped.current = false;
    const up = (end: globalThis.PointerEvent) => {
      window.removeEventListener("pointercancel", cancel);
      const dx = end.clientX - start.x;
      swiped.current = Math.abs(dx) >= SWIPE && Math.abs(dx) > Math.abs(end.clientY - start.y);
      if (swiped.current) latest.current(dx < 0 ? 1 : -1);
    };
    const cancel = () => window.removeEventListener("pointerup", up);
    window.addEventListener("pointerup", up, { once: true });
    window.addEventListener("pointercancel", cancel, { once: true });
  };

  return (
    <div className={s.carousel} data-kind={kind} data-sealing={sealing || undefined}>
      <button type="button" className={s.arrow} data-side="prev" aria-label="上一个" title="上一个" tabIndex={-1} onClick={() => go(-1)}>
        <ChevronLeft size={16} strokeWidth={1.8} />
      </button>
      <div className={s.track} role="radiogroup" aria-label={label} onPointerDown={onPointerDown}
        // 形象里的图片不许被拖走：浏览器一拖图就把这一下取消了。
        onDragStart={(event) => event.preventDefault()}>
        {items.map((item, position) => {
          // 首尾相接：离当前最近的那一侧算位置，再远的藏起来。
          let offset = position - index;
          if (offset > count / 2) offset -= count;
          if (offset < -count / 2) offset += count;
          const active = offset === 0;
          return (
            <div key={item.id} className={s.slide} data-offset={Math.max(-2, Math.min(2, offset))} role="radio" aria-checked={active} aria-label={item.label}
              tabIndex={active ? 0 : -1} onClick={active ? undefined : () => { if (!sealing && !swiped.current) onChange(item.id); swiped.current = false; }}>
              <div className={s.seal}>{children(item.id, active)}</div>
            </div>
          );
        })}
      </div>
      <button type="button" className={s.arrow} data-side="next" aria-label="下一个" title="下一个" tabIndex={-1} onClick={() => go(1)}>
        <ChevronRight size={16} strokeWidth={1.8} />
      </button>
    </div>
  );
}

/** 台上的伙伴：stage 是选形象时中间那个（最大），hero 是之后几页顶上那个。探出半身的形象本身小，放得更大一些。 */
export function BuddyFigure({ skin, name, pose, level, size }: { skin: CoAgentSkin; name: string; pose: CapsulePose; level: number; size: "stage" | "hero" }) {
  return (
    <span className={s.figure} data-size={size} data-tall={isFigureSkin(skin) || undefined} aria-hidden="true">
      <PresenceCapsule skin={skin} name={name} pose={pose} level={level} />
    </span>
  );
}

/** 性格：一张话卡，名字加一句它在同一个场景里会说的话。 */
export function PersonalityCard({ id }: { id: BuddyPersonality }) {
  const item = BUDDY_PERSONALITIES.find((entry) => entry.id === id);
  if (!item) return null;
  return <div className={s.card}><span className={s.cardLabel}>{item.label}</span><span className={s.cardSample}>{item.sample}</span></div>;
}
