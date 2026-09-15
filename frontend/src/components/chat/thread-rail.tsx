"use client";

import { useEffect, useState } from "react";
import type { AdvisorMessage } from "@/lib/data/types";
import { cn } from "@/lib/utils";

/**
 * 对话导航条 —— 贴在对话栏左边缘的那一列短横线。
 *
 * 一场把议题聊到收敛的对话有十几轮。滚回去找「我刚才问那句话时它是怎么答的」，靠滚轮
 * 是找不到的：屏幕上全是等长的灰段落，没有地标。这一列短横线就是地标 —— 一根线一轮
 * 提问，悬停时把那一问摊开，点一下跳过去。
 *
 * 只标**他问的**，不标参谋答的。理由是他在找的东西永远以自己的问题为坐标（「我问预算
 * 那次」），而不是以答案为坐标 —— 答案是他要去读的，不是他要认的。
 *
 * 对话不长时它不出现（少于 3 轮）：三根线的导航条比直接滚还慢，而屏幕上多一列东西
 * 是要付代价的。
 */
export function ThreadRail({
  messages,
  scroller,
}: {
  messages: AdvisorMessage[];
  scroller: React.RefObject<HTMLDivElement | null>;
}) {
  const asks = messages.filter((m) => m.role === "user");
  const [active, setActive] = useState<string | null>(null);

  /*
   * 滚到哪了就亮哪一根。用 IntersectionObserver 而不是 scroll 事件：后者每帧都要量
   * 一遍所有锚点的位置，一场长对话里那是几十次 `getBoundingClientRect`。
   */
  useEffect(() => {
    const root = scroller.current;
    if (!root || asks.length < 3) return;
    const io = new IntersectionObserver(
      (entries) => {
        const hit = entries.find((e) => e.isIntersecting);
        if (hit) setActive(hit.target.id.replace("turn-", ""));
      },
      { root, rootMargin: "-20% 0px -70% 0px" },
    );
    for (const m of asks) {
      const el = document.getElementById(`turn-${m.id}`);
      if (el) io.observe(el);
    }
    return () => io.disconnect();
  }, [asks, scroller]);

  if (asks.length < 3) return null;

  return (
    <nav
      aria-label="跳到某一轮"
      className="group/rail absolute top-0 bottom-0 left-0 z-10 flex w-6 flex-col items-center justify-center gap-2 py-6"
    >
      {asks.map((m) => (
        <button
          key={m.id}
          type="button"
          onClick={() =>
            document
              .getElementById(`turn-${m.id}`)
              ?.scrollIntoView({ behavior: "smooth", block: "start" })
          }
          className="group/tick relative flex h-3 w-full items-center"
        >
          <span
            className={cn(
              "h-px w-full rounded-full transition-colors duration-fast",
              active === m.id ? "bg-ink" : "bg-hairline-strong group-hover/tick:bg-ink-faint",
            )}
          />
          {/* 悬停摊开那一问。卡片压在对话上方，不挤版面 —— 导航是临时动作。 */}
          <span className="pointer-events-none absolute top-1/2 left-full z-20 ml-1 hidden w-64 -translate-y-1/2 rounded-lg border border-hairline-strong bg-surface px-3 py-2 shadow-e2 group-hover/tick:block">
            <span className="clamp-3 block text-sm leading-relaxed text-ink">{m.text}</span>
          </span>
        </button>
      ))}
    </nav>
  );
}
