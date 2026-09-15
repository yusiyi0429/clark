import Link from "next/link";
import { StandingTag } from "@/components/standing-tag";
import type { Judgment } from "@/lib/data/types";
import { cn } from "@/lib/utils";

/**
 * 一组判断，每条一行：编号、它此刻的原话、它站得稳不稳。
 *
 * 三个地方是同一行 —— 一个答案落在哪条判断上、一个议题动摇了哪条判断、一位 DRI
 * 在为哪句话给方案。长成三种样子，一号位就会以为它们是三种东西；而这个产品全部的
 * 说服力建立在「这些编号背后是同一批持久对象」，那么它们在屏幕上就得长得一模一样。
 *
 * 编号列宽度写死：`04-J1` 与 `06-J1` 对齐成一列，扫下来才看得出这是一份清单，而不是
 * 三段各自换行的文字。整行都点得开 —— 点得开就说明它是一个对象。
 *
 * 每条都带 `StandingTag`，因为「有哪几条」几乎从不是一号位想知道的事，「其中哪一条
 * 现在站不住」才是。
 */
export function JudgmentList({
  judgments,
  className,
}: {
  judgments: Judgment[];
  className?: string;
}) {
  return (
    <ul className={cn("space-y-2.5", className)}>
      {judgments.map((judgment) => (
        <li key={judgment.id} className="flex items-baseline gap-3">
          <span className="meta w-11 shrink-0 text-ink-faint">
            {judgment.id}
          </span>
          {/*
           * 站得稳不稳换到原话**下面**，不再挤在同一行右端。
           * 这份清单会出现在 26rem 宽的侧栏里 —— 一行里塞下编号、原话和一句
           * 「v2 · 已确认 · 1 个任务验证过」之后，留给原话的只剩十来个字宽，
           * 一句话被折成六行。判断的原话是这一行的主语，不能是被挤剩的那一截。
           */}
          <span className="min-w-0 flex-1">
            <Link
              href={`/judgments/${judgment.id}`}
              className="report block rounded-[3px] text-md text-ink underline decoration-transparent underline-offset-[3px] transition-colors hover:decoration-hairline"
            >
              {judgment.statement}
            </Link>
            <StandingTag judgment={judgment} className="mt-0.5 block" />
          </span>
        </li>
      ))}
    </ul>
  );
}
