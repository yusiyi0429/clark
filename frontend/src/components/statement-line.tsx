import { TraceChips } from "@/components/trace-chip";
import { asSentence } from "@/lib/agent/plain-text";
import type { Statement } from "@/lib/data/types";
import { cn } from "@/lib/utils";

/**
 * One assertion followed by its provenance. The chips sit inline at the end of
 * the sentence rather than on their own line so the eye reads claim-then-source
 * as a single unit — that adjacency is the whole point.
 *
 * 有 `label` 的（S02 的依据）先出一句加粗的判断，正文接在同一段里往下读。
 * **加粗是这里做的，不是模型写 `**` 写出来的** —— 屏幕按纯文本渲染，星号会原样显示，
 * 而 `rules.ts` 的 `FE-md` 正是在挡它。内容归 prompt，粗体归这一层。
 */
export function StatementLine({
  statement,
  className,
}: {
  statement: Statement;
  className?: string;
}) {
  const label = statement.label?.trim();
  return (
    <p className={cn("text-[0.9375rem] leading-[1.75] text-ink", className)}>
      {/*
        * 句末标点由 `asSentence` 补：模型给 label 时一半带句号一半不带，不带的那一半
        * 和正文黏成一句（「瓶颈正在换层 NEC 全 AI 部门的核心创新不是…」）。
        */}
      {label && <strong className="font-medium text-ink">{asSentence(label)}</strong>}
      {label && " "}
      {statement.text}
      <TraceChips traces={statement.traces} />
    </p>
  );
}

export function StatementList({
  statements,
  className,
}: {
  statements: Statement[];
  className?: string;
}) {
  return (
    <div className={cn("space-y-2", className)}>
      {statements.map((s, i) => (
        <StatementLine key={i} statement={s} />
      ))}
    </div>
  );
}
