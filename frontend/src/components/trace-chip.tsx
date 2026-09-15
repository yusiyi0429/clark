import Link from "next/link";
import type { Trace, TraceKind } from "@/lib/data/types";
import { cn } from "@/lib/utils";

/**
 * 溯源标记 —— 论文式，一个上标。
 *
 * 每一条事实性陈述都带着它的出处。出处以前是一枚写满字的徽章（色条 + 「外部事实」+
 * 来源全文），排在句末。问题是**它比句子还响**：一段五行的报告里排着七八枚灰底方块，
 * 眼睛先看到的是那一排方块，读者要绕过它们才读得到话。溯源本该是可核对的保证，
 * 不是版面的主角。
 *
 * 所以改成论文的做法：句末一个上标数字，颜色留一档（外部 / 内部 / 推断各不同），
 * 出处全文进 `title`，有对象的点得开。存在感降到最低，但一条都没少 ——
 * 「凭什么这么说」永远问得出来。
 */

const KIND: Record<TraceKind, { label: string; text: string }> = {
  ext: { label: "外部事实", text: "text-factual" },
  int: { label: "内部事实", text: "text-confirmed" },
  human: { label: "人的判断", text: "text-ink-muted" },
  agent: { label: "推断", text: "text-judgment" },
  judgment: { label: "已登记判断", text: "text-solid" },
  peer: { label: "同僚 Agent", text: "text-ink-muted" },
};

/**
 * 只要名字、不要出处的场合（链路图上把知识关系折起来时）。出处那一串是长的那部分，
 * 名字只有四个字 —— 折起来之后仍然答得出「是外面变了还是我们自己在说话」。
 */
export const TRACE_KIND_LABEL: Record<TraceKind, string> = {
  ext: KIND.ext.label,
  int: KIND.int.label,
  human: KIND.human.label,
  agent: KIND.agent.label,
  judgment: KIND.judgment.label,
  peer: KIND.peer.label,
};

export function TraceChip({ trace, n = 1 }: { trace: Trace; n?: number }) {
  const kind = KIND[trace.kind];
  const title = `${kind.label} · ${trace.source}`;
  const shell =
    "ml-[1px] align-super text-[0.625rem] leading-none font-medium tabular-nums";

  if (trace.href) {
    return (
      <Link
        href={trace.href}
        title={title}
        aria-label={title}
        className={cn(shell, kind.text, "rounded-[2px] hover:underline hover:underline-offset-2")}
      >
        [{n}]
      </Link>
    );
  }

  return (
    <span title={title} aria-label={title} className={cn(shell, kind.text, "opacity-70")}>
      [{n}]
    </span>
  );
}

export function TraceChips({ traces }: { traces: Trace[] }) {
  if (traces.length === 0) return null;
  return (
    <>
      {traces.map((t, i) => (
        <TraceChip key={`${t.kind}-${t.source}-${i}`} trace={t} n={i + 1} />
      ))}
    </>
  );
}
