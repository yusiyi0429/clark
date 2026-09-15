"use client";

import { readingJudgments } from "@/lib/agent/a4/blocks/reading";
import type { ReportBlocks } from "@/lib/agent/a4/blocks/schema";
import { BlockShell, ConfidenceBadge, EvidenceRefs, InlineCites } from "./chrome";

export function JudgmentOverview({ report, onQuote }: { report: ReportBlocks; onQuote?: (text: string) => void }) {
  const judgments = readingJudgments(report);
  if (!judgments.length) return null;
  return (
    <section className="mt-5 rounded-lg border border-hairline bg-neutral-wash/40 px-4 py-4" aria-label="对这个议题的判断">
      <h3 className="report text-lg font-medium text-ink">对这个议题的判断</h3>
      <p className="meta mt-1 text-ink-faint">Agent 提出 · 供您追问和挑战，尚未形成决议</p>
      <div className="mt-4 space-y-4">
        {judgments.slice(0, 3).map(({ block: b, index }, i) => (
          <BlockShell key={index} index={-index - 2} refs={b.evidenceRefs} alwaysShow className="border-t border-hairline pt-3 first:border-0 first:pt-0">
            <p className="report text-read font-medium text-ink"><span className="mr-2 text-ink-faint">{i + 1}.</span><InlineCites text={b.claim} /></p>
            <div className="mt-2 flex flex-wrap items-center gap-2"><ConfidenceBadge confidence={b.confidence} missing={b.defaulted?.includes("confidence")} /><EvidenceRefs refs={b.evidenceRefs} />{!b.evidenceRefs.length && <span className="meta text-ink-faint">未附外部证据 · 判断待验证</span>}</div>
            <div className="mt-2 flex items-start gap-3"><details className="min-w-0 flex-1">
              <summary className="meta cursor-pointer text-ink-muted">依据与待挑战的问题</summary>
              <dl className="meta mt-2 space-y-2 leading-relaxed text-ink-muted">
                <div><dt className="font-medium text-ink">判断理由</dt><dd><InlineCites text={b.reasoningSummary || "报告未交代判断理由。"} /></dd></div>
                <div><dt className="font-medium text-ink">什么会推翻它</dt><dd><InlineCites text={b.falsifyCondition || "报告尚未说明，需要追问。"} /></dd></div>
                <div><dt className="font-medium text-ink">还需验证</dt><dd><InlineCites text={[b.upgradeCondition, ...b.internalValidationHooks].filter(Boolean).join("；") || "报告尚未说明验证条件。"} /></dd></div>
              </dl>
            </details>
            {onQuote && <button type="button" data-print-hide className="meta shrink-0 text-judgment hover:underline" onClick={() => onQuote(`关于这条判断：「${b.claim}」\n请解释它的依据、成立条件，以及什么证据会推翻它。`)}>就这条追问</button>}</div>
          </BlockShell>
        ))}
      </div>
      {judgments.length > 3 && <details className="mt-4 border-t border-hairline pt-3"><summary className="meta cursor-pointer text-ink-muted">其余 {judgments.length - 3} 条判断</summary><ol className="report mt-3 space-y-3 text-sm text-ink-muted">{judgments.slice(3).map(({ block, index }) => <li key={index}><BlockShell index={-index - 2} refs={block.evidenceRefs} alwaysShow><InlineCites text={block.claim} /><EvidenceRefs refs={block.evidenceRefs} /></BlockShell></li>)}</ol></details>}
    </section>
  );
}
