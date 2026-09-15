"use client";

import { MessageSquareQuote } from "lucide-react";
import { useCallback, useState, type RefObject } from "react";

/**
 * 划词 → 引用提问。
 *
 * 这块屏幕上有几处文字值得被追问：深研报告、追加调查的轻报告、判断板上那几条、参谋在
 * 对话里说的话。谁装了这个 hook 谁就能被划。
 *
 * **划词只剩这一件事。** 原来还有「溯源」和「记成判断」：溯源在句末那枚上标里一直都在
 * （`trace-chip`），判断本来就由对谈萃取落到判断板上 —— 浮层上并排三枚按钮，等于每次
 * 划中一句话都要先做一次选择，而他划那句话的时候想的是「就这句问一下」。
 *
 * 定位算的是**相对滚动容器**的坐标（`scrollTop` 要加回去），所以工具条跟着内容滚，
 * 不会在滚动时留在原地。左边界做了双向夹取：贴着容器右沿划词时，工具条不该被切掉半截。
 */

export type Selected = { top: number; left: number; text: string };

/** 那一枚按钮的宽度 —— 夹取要按真实宽度算，否则贴右沿划词会被切掉半截。 */
const TOOLBAR_W = 104;

export function useSelectionQuote(hostRef: RefObject<HTMLElement | null>) {
  const [selected, setSelected] = useState<Selected | null>(null);

  const clear = useCallback(() => {
    setSelected(null);
    window.getSelection()?.removeAllRanges();
  }, []);

  const onMouseUp = useCallback(() => {
    const host = hostRef.current;
    const sel = window.getSelection();
    if (!host || !sel || sel.isCollapsed) {
      setSelected(null);
      return;
    }
    const text = sel.toString().trim();
    const anchor = sel.anchorNode;
    if (!text || !anchor || !host.contains(anchor)) {
      setSelected(null);
      return;
    }
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    setSelected({
      top: rect.top - hostRect.top + host.scrollTop - 40,
      left: Math.max(
        8,
        Math.min(
          rect.left - hostRect.left + rect.width / 2 - TOOLBAR_W / 2,
          host.clientWidth - TOOLBAR_W - 8,
        ),
      ),
      text,
    });
  }, [hostRef]);

  return { selected, clear, onMouseUp };
}

/** 划词浮出的那一枚按钮。挂在滚动容器里，容器要 `relative`。 */
export function SelectionToolbar({
  selected,
  onQuote,
}: {
  selected: Selected | null;
  onQuote: () => void;
}) {
  if (!selected) return null;
  return (
    <div
      /* `.floating-thick`（见 globals.css）—— 同 `selection-cue`，划词浮出来的东西
         压着的就是他刚划中的那段正文。 */
      className="floating-thick animate-fade absolute z-20 flex overflow-hidden rounded-lg"
      style={{ top: selected.top, left: selected.left }}
    >
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={onQuote}
        className="meta flex items-center gap-1.5 px-3 py-2 font-medium text-ink transition-colors duration-fast hover:bg-neutral-wash"
      >
        <MessageSquareQuote className="size-3.5" aria-hidden />
        引用提问
      </button>
    </div>
  );
}
