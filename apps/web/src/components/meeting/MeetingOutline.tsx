"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { ListTree } from "lucide-react";
import { readingScroller, readingTopInset, scrollToElement } from "./readingScroll";
import s from "@/styles/meeting-workspace.module.css";
import { FadeText } from "@/lib/home/overflowFade";

/**
 * 会议页目录（feedback 10 / H07）：
 * - 宽屏：目录在正文左侧，跟着 DetailFrame 的 `.ts-detail` 滚动吸顶（position: sticky），不是另一个滚动框，滚轮照常滚正文；
 * - 窄屏、矮屏或放大：目录收成正文右上角一颗「目录」钮，点开浮在正文上面，不挤正文；
 * - 滚动时高亮当前议题和议题里的小节；点目录定位时让出页头；右侧 Agent 栏展开收起、内容变高时，正在读的那一段不跳走。
 * 页面里的章节用 `data-outline="<key>"`，议题里的小节用 `data-outline-sub="<key>"` 标记。
 */

export type OutlineItem = {
  key: string;
  label: string;
  /** 目录钮上的短名（窄屏）。 */
  short?: string;
  hint?: string;
  tone?: "pending" | "decided" | "dismissed" | "neutral";
  children?: { key: string; label: string }[];
};

export type OutlineActive = { key: string | null; sub: string | null };

export function MeetingOutline({ items, active, onJump, label = "会议目录" }: {
  items: OutlineItem[];
  active: OutlineActive;
  onJump: (key: string, sub?: string) => void;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || toggleRef.current?.contains(target)) return;
      setOpen(false);
    };
    // Escape 只收起目录浮层：标记已处理，外壳（C-06）就不会接着关掉整页。
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      toggleRef.current?.focus({ preventScroll: true });
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const current = items.find((item) => item.key === active.key);
  const list = (onPick: () => void) => (
    <ol className={s.tocList}>
      {items.map((item) => {
        const selected = item.key === active.key;
        return (
          <li key={item.key}>
            <button type="button" data-active={selected} aria-current={selected ? "location" : undefined} onClick={() => { onJump(item.key); onPick(); }}>
              <FadeText className={s.tocLabel}>{item.label}</FadeText>
              {item.hint ? <em data-tone={item.tone ?? "neutral"}>{item.hint}</em> : null}
            </button>
            {selected && item.children?.length ? (
              <ol className={s.tocSub}>
                {item.children.map((child) => (
                  <li key={child.key}>
                    <button type="button" data-active={child.key === active.sub} onClick={() => { onJump(item.key, child.key); onPick(); }}>
                      {child.label}
                    </button>
                  </li>
                ))}
              </ol>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
  return (
    <>
      <div className={s.tocBar} data-toc-bar>
        <button ref={toggleRef} type="button" className={s.tocToggle} aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((value) => !value)}>
          <ListTree size={14} aria-hidden="true" />
          <span>目录</span>
          {current ? <span className={s.tocCurrent}>{current.short ?? current.label}</span> : null}
        </button>
        {open ? (
          <div ref={panelRef} id={panelId} className={s.tocPanel} role="dialog" aria-label={label}>
            {list(() => setOpen(false))}
          </div>
        ) : null}
      </div>
      <nav className={s.tocAside} aria-label={label}>
        <p className={s.tocHead}>{label}</p>
        {list(() => undefined)}
      </nav>
    </>
  );
}

/** 当前停在哪一节：分界线是页头下沿再往下一点，取最后一个越过分界线的章节；滚到底时取最后一个露出来的章节。 */
export function pickOutline(sections: { key: string; top: number }[], boundary: number, atBottom: boolean, viewportBottom: number): string | null {
  if (!sections.length) return null;
  let key = sections[0].key;
  for (const section of sections) if (section.top <= boundary) key = section.key;
  if (atBottom) {
    const visible = sections.filter((section) => section.top < viewportBottom);
    if (visible.length) key = visible[visible.length - 1].key;
  }
  return key;
}

/**
 * scroll-spy：监听 `.ts-detail` 的滚动（不另建滚动框）。点目录定位后先锁住目标章节，直到用户自己滚动，
 * 避免最后几节到不了分界线时高亮跳回上一节。
 */
export function useOutlineSpy(rootRef: RefObject<HTMLElement | null>, enabled: boolean, revision: string) {
  const [active, setActive] = useState<OutlineActive>({ key: null, sub: null });
  const pinned = useRef<OutlineActive | null>(null);
  useEffect(() => {
    const root = rootRef.current;
    const scroller = readingScroller(root);
    if (!enabled || !root || !scroller) return;
    let frame = 0;
    const compute = () => {
      frame = 0;
      const box = scroller.getBoundingClientRect();
      const boundary = box.top + readingTopInset(scroller) + 24;
      const elements = [...root.querySelectorAll<HTMLElement>("[data-outline]")];
      const key = pinned.current?.key ?? pickOutline(elements.map((element) => ({ key: element.dataset.outline ?? "", top: element.getBoundingClientRect().top })),
        boundary, scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2, box.top + scroller.clientHeight);
      let sub: string | null = pinned.current?.sub ?? null;
      if (!pinned.current?.sub) {
        const owner = elements.find((element) => element.dataset.outline === key);
        for (const element of owner?.querySelectorAll<HTMLElement>("[data-outline-sub]") ?? []) {
          if (element.getBoundingClientRect().top <= boundary) sub = element.dataset.outlineSub ?? null;
        }
      }
      setActive((current) => (current.key === key && current.sub === sub ? current : { key, sub }));
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(compute);
    };
    const release = () => {
      if (!pinned.current) return;
      pinned.current = null;
      schedule();
    };
    const onKey = (event: KeyboardEvent) => {
      if (["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown", " "].includes(event.key)) release();
    };
    compute();
    scroller.addEventListener("scroll", schedule, { passive: true });
    scroller.addEventListener("wheel", release, { passive: true });
    scroller.addEventListener("touchmove", release, { passive: true });
    window.addEventListener("keydown", onKey);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    observer?.observe(root);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      scroller.removeEventListener("scroll", schedule);
      scroller.removeEventListener("wheel", release);
      scroller.removeEventListener("touchmove", release);
      window.removeEventListener("keydown", onKey);
      observer?.disconnect();
    };
  }, [enabled, rootRef, revision]);

  const jump = useCallback((key: string, sub?: string) => {
    const root = rootRef.current;
    if (!root) return;
    const selector = sub ? `[data-outline-sub="${CSS.escape(sub)}"]` : `[data-outline="${CSS.escape(key)}"]`;
    const element = root.querySelector<HTMLElement>(selector);
    if (!element) return;
    pinned.current = { key, sub: sub ?? null };
    setActive({ key, sub: sub ?? null });
    scrollToElement(element);
  }, [rootRef]);

  return { active, jump };
}

const ANCHOR_CANDIDATES = "[data-outline], [data-outline-sub], article, li, h3, h4, p";

/**
 * 正在读的那一段不跳走：记住视口顶部那一块元素和它离顶部的距离；正文宽度变了（右侧 Agent 栏展开 / 收起、窗口缩放）
 * 或上面的内容变高了（历史读回来），把那一块放回原来的位置。原生 scroll anchoring 会因为阅读区 padding 变化被抑制，所以自己做。
 */
export function useReadingAnchor(rootRef: RefObject<HTMLElement | null>, enabled: boolean, resetKey = "") {
  useEffect(() => {
    const root = rootRef.current;
    const scroller = readingScroller(root);
    if (!enabled || !root || !scroller || typeof ResizeObserver === "undefined") return;
    let anchor: { element: HTMLElement; offset: number } | null = null;
    let adjusting = 0;
    let frame = 0;
    const capture = () => {
      frame = 0;
      if (adjusting) return;
      if (scroller.scrollTop <= 0) {
        anchor = null;
        return;
      }
      const top = scroller.getBoundingClientRect().top;
      const line = top + readingTopInset(scroller);
      let best: HTMLElement | null = null;
      for (const element of root.querySelectorAll<HTMLElement>(ANCHOR_CANDIDATES)) {
        const rect = element.getBoundingClientRect();
        if (rect.height && rect.top <= line && rect.bottom > line) best = element;
        else if (rect.top > line) {
          best ??= element;
          break;
        }
      }
      anchor = best ? { element: best, offset: best.getBoundingClientRect().top - top } : null;
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(capture);
    };
    const restore = () => {
      if (!anchor?.element.isConnected) return;
      const delta = anchor.element.getBoundingClientRect().top - scroller.getBoundingClientRect().top - anchor.offset;
      if (Math.abs(delta) < 1) return;
      adjusting += 1;
      scroller.scrollTop += delta;
      window.requestAnimationFrame(() => {
        adjusting = Math.max(0, adjusting - 1);
      });
    };
    capture();
    scroller.addEventListener("scroll", schedule, { passive: true });
    const observer = new ResizeObserver(restore);
    observer.observe(root);
    observer.observe(scroller);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      scroller.removeEventListener("scroll", schedule);
      observer.disconnect();
    };
  }, [enabled, rootRef, resetKey]);
}

const RETURN_KEY = "tianshu:reading-return";

/** 跳到别的页面（外部信号、别的会议）之前记下读到哪个议题、离页头多远；回到这一页时恢复。 */
export function saveReadingPosition(key: string, root: HTMLElement | null): void {
  const scroller = readingScroller(root);
  if (!root || !scroller) return;
  const top = scroller.getBoundingClientRect().top;
  const line = top + readingTopInset(scroller);
  let section: HTMLElement | null = null;
  for (const element of root.querySelectorAll<HTMLElement>("[data-outline]")) if (element.getBoundingClientRect().top <= line) section = element;
  const value = { key, outline: section?.dataset.outline ?? null, offset: section ? section.getBoundingClientRect().top - top : 0, scrollTop: scroller.scrollTop, at: Date.now() };
  try {
    window.sessionStorage.setItem(RETURN_KEY, JSON.stringify(value));
  } catch {
    // 存不了就只是回来时从头读，不影响跳转。
  }
}

/** 回到同一页（同一份视图）时恢复到离开前的议题；只用一次，半小时后失效。必须写在 useRememberedScroll 之后。 */
export function useRestoreReadingPosition(key: string, rootRef: RefObject<HTMLElement | null>, enabled: boolean): void {
  useLayoutEffect(() => {
    if (!enabled) return;
    let saved: { key: string; outline: string | null; offset: number; scrollTop: number; at: number } | null = null;
    try {
      saved = JSON.parse(window.sessionStorage.getItem(RETURN_KEY) ?? "null");
    } catch {
      saved = null;
    }
    if (!saved || saved.key !== key || Date.now() - saved.at > 30 * 60_000) return;
    try {
      window.sessionStorage.removeItem(RETURN_KEY);
    } catch {
      // 忽略
    }
    const root = rootRef.current;
    const scroller = readingScroller(root);
    if (!root || !scroller) return;
    const section = saved.outline ? root.querySelector<HTMLElement>(`[data-outline="${CSS.escape(saved.outline)}"]`) : null;
    if (section) scroller.scrollTop += section.getBoundingClientRect().top - scroller.getBoundingClientRect().top - saved.offset;
    else scroller.scrollTop = saved.scrollTop;
  }, [enabled, key, rootRef]);
}
