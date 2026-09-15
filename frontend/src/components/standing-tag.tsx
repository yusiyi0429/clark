import type { Judgment } from "@/lib/data/types";
import { cn } from "@/lib/utils";

/**
 * 一条判断现在站得稳不稳。
 *
 * 四个状态，四种说法，没有第五种。`unverified` 不是 `confirmed` 的次品，它是大多数
 * 假设的诚实状态；一条全公司都在赌、但零个真实任务验证过的判断，是 Clark 能摆在
 * 一号位面前最有用的一样东西 —— 所以那个 0 要写出来，不能省。
 */
export function StandingTag({
  judgment,
  className,
}: {
  judgment: Judgment;
  className?: string;
}) {
  const { standing, verifiedByTasks: n } = judgment;

  const text =
    standing === "shaking"
      ? "动摇中"
      : standing === "unverified"
        ? n === 0
          ? "假设 · 0 个任务验证过"
          : `假设 · ${n} 个任务验证过`
        : standing === "dropped"
          ? "已放弃"
          : n === 0
            ? "已确认 · 尚无任务验证"
            : `已确认 · ${n} 个任务验证过`;

  const tone =
    standing === "shaking"
      ? "text-counter"
      : standing === "unverified"
        ? "text-judgment"
        : "text-ink-faint";

  return (
    <span className={cn("meta shrink-0", tone, className)}>
      v{judgment.version} · {text}
    </span>
  );
}
