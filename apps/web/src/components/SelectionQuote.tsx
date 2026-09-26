"use client";

import { useCallback, useState, type RefObject } from "react";
import { MessageSquareQuote } from "lucide-react";
import s from "@/styles/selection-quote.module.css";

/**
 * 划词 → 引用提问（clark `provenance/selection-quote.tsx`）。
 * 坐标相对滚动容器（加回 scrollTop），工具条跟着内容滚；左边界双向夹取，贴右沿划词也不被切掉。
 */
export type Selected = { top: number; left: number; text: string };

const TOOLBAR_W = 104;

export function useSelectionQuote(hostRef: RefObject<HTMLElement | null>) {
  const [selected, setSelected] = useState<Selected | null>(null);

  const clear = useCallback(() => {
    setSelected(null);
    window.getSelection()?.removeAllRanges();
  }, []);

  const onMouseUp = useCallback(() => {
    const host = hostRef.current;
    const selection = window.getSelection();
    if (!host || !selection || selection.isCollapsed) {
      setSelected(null);
      return;
    }
    const text = selection.toString().trim();
    const anchor = selection.anchorNode;
    if (!text || !anchor || !host.contains(anchor)) {
      setSelected(null);
      return;
    }
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    setSelected({
      top: rect.top - hostRect.top + host.scrollTop - 40,
      left: Math.max(8, Math.min(rect.left - hostRect.left + rect.width / 2 - TOOLBAR_W / 2, host.clientWidth - TOOLBAR_W - 8)),
      text,
    });
  }, [hostRef]);

  return { selected, clear, onMouseUp };
}

/** 划词浮出的那一枚按钮。挂在滚动容器里，容器要 relative。 */
export function SelectionToolbar({ selected, onQuote }: { selected: Selected | null; onQuote: () => void }) {
  if (!selected) return null;
  return (
    <div className={s.toolbar} style={{ top: selected.top, left: selected.left }}>
      <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={onQuote}>
        <MessageSquareQuote size={14} aria-hidden="true" />
        引用提问
      </button>
    </div>
  );
}
