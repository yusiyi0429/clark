"use client";

import { Quote, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState, type RefObject } from "react";

/**
 * 框选一段话 → 查它的出处。
 *
 * 一号位说的第二件事：他会框住一句话问「这句哪来的」。所以选中就该出现这个入口，而
 * 不是让他去找一个「溯源」菜单——他框住那句话的时候，手已经在那句话上了。
 *
 * `scope` 限定它只认某一栏里的选中。对话栏和文档面板各挂一个，各自只管自己那块地：
 * 一个全局浮层在拖动选中跨过分栏时会抖，而且它没法知道被框住的那句话属于哪个上下文
 * ——而上下文正是溯源要用的东西。
 */
export function SelectionCue({ scope }: { scope: RefObject<HTMLElement | null> }) {
  const router = useRouter();
  const [sel, setSel] = useState<{ text: string; x: number; y: number } | null>(null);

  useEffect(() => {
    const read = () => {
      const s = window.getSelection();
      if (!s || s.isCollapsed || s.rangeCount === 0) return setSel(null);

      const range = s.getRangeAt(0);
      const host = scope.current;
      if (!host || !host.contains(range.commonAncestorContainer)) return setSel(null);

      const text = s.toString().trim();
      // 少于四个字的选中大多是手滑，不是提问。
      if (text.length < 4) return setSel(null);

      const r = range.getBoundingClientRect();
      setSel({
        text,
        x: Math.min(Math.max(r.left + r.width / 2, 96), window.innerWidth - 96),
        y: r.top - 8,
      });
    };

    // 用 mouseup/keyup 而不是 selectionchange：拖选过程中每一帧都会触发
    // selectionchange，浮层会跟着鼠标乱跳。松手那一刻再出现才是对的。
    document.addEventListener("mouseup", read);
    document.addEventListener("keyup", read);
    const clear = () => setSel(null);
    document.addEventListener("mousedown", clear);
    window.addEventListener("scroll", clear, true);
    return () => {
      document.removeEventListener("mouseup", read);
      document.removeEventListener("keyup", read);
      document.removeEventListener("mousedown", clear);
      window.removeEventListener("scroll", clear, true);
    };
  }, [scope]);

  if (!sel) return null;

  return (
    <div
      style={{ left: sel.x, top: sel.y }}
      /* `.floating-thick`（见 globals.css）。这条工具条按定义就停在他刚划的那行字上面。
         `overflow-hidden` 留着：里面两枚按钮的 hover 底要被圆角切住 —— 边框换成
         `box-shadow` 的环之后这件事照旧（环画在盒子外沿，不参与裁剪）。 */
      className="floating-thick animate-rise fixed z-40 -translate-x-1/2 -translate-y-full overflow-hidden rounded-lg"
    >
      <div className="flex items-stretch divide-x divide-hairline">
        <Cue
          icon={<Search className="size-3.5" />}
          label="查找出处"
          onClick={() => {
            router.push(`/trace?q=${encodeURIComponent(sel.text.slice(0, 200))}`);
            setSel(null);
          }}
        />
        <Cue
          icon={<Quote className="size-3.5" />}
          label="引用"
          onClick={() => {
            window.dispatchEvent(
              new CustomEvent("clark:quote", { detail: sel.text }),
            );
            window.getSelection()?.removeAllRanges();
            setSel(null);
          }}
        />
      </div>
    </div>
  );
}

function Cue({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className="flex items-center gap-1.5 px-2.5 py-1.5 text-sm text-ink transition-colors duration-fast ease-swift hover:bg-neutral-wash"
    >
      <span className="text-ink-faint">{icon}</span>
      {label}
    </button>
  );
}
