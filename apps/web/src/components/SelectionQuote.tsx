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

/**
 * 当前选区 → 浮出位置与文字；不在容器里、没选中文字时为 null。
 * `within`：只认落在这类元素里的选区（对话里只认消息正文，卡片、思考行上的字不浮出）。
 */
export function readSelection(host: HTMLElement, selection: Selection | null, within?: string): Selected | null {
  if (!selection || selection.isCollapsed) return null;
  const text = selection.toString().trim();
  const anchor = selection.anchorNode;
  if (!text || !anchor || !host.contains(anchor)) return null;
  if (within) {
    const element = anchor.nodeType === 1 ? (anchor as Element) : anchor.parentElement;
    if (!element?.closest(within)) return null;
  }
  const rect = selection.getRangeAt(0).getBoundingClientRect();
  const hostRect = host.getBoundingClientRect();
  return {
    top: rect.top - hostRect.top + host.scrollTop - 40,
    left: Math.max(8, Math.min(rect.left - hostRect.left + rect.width / 2 - TOOLBAR_W / 2, host.clientWidth - TOOLBAR_W - 8)),
    text,
  };
}

export function useSelectionQuote(hostRef: RefObject<HTMLElement | null>, options: { within?: string } = {}) {
  const [selected, setSelected] = useState<Selected | null>(null);
  const { within } = options;

  const clear = useCallback(() => {
    setSelected(null);
    window.getSelection()?.removeAllRanges();
  }, []);

  const onMouseUp = useCallback(() => {
    const host = hostRef.current;
    setSelected(host ? readSelection(host, window.getSelection(), within) : null);
  }, [hostRef, within]);

  return { selected, clear, onMouseUp };
}

/** 划词浮出的那一枚按钮。挂在滚动容器里，容器要 relative。对话正文里写「引用」（引用进当前对话的输入框）。 */
export function SelectionToolbar({ selected, onQuote, label = "批注提问" }: { selected: Selected | null; onQuote: () => void; label?: string }) {
  if (!selected) return null;
  return (
    <div className={s.toolbar} style={{ top: selected.top, left: selected.left }}>
      <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={onQuote}>
        <MessageSquareQuote size={14} aria-hidden="true" />
        {label}
      </button>
    </div>
  );
}
