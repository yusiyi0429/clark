import type { EventBody } from "../eventLog.js";

/** 压缩了上下文的那条提示（设计 17.2 第 42 条，契约 notice context_compacted）。 */
export const CONTEXT_COMPACTED: EventBody = { type: "notice", level: "info", code: "context_compacted", text: "压缩了上下文" };

/**
 * 上下文用了多少（契约 LocalContextUsage、事件 context_usage）：变了才报，免得事件太密。
 * 这一轮中间（每次模型回复后）只在百分比（取整）变了时报，上限读不到时不报；每轮做完（force）数变了就报。
 */
export class ContextReporter {
  private sent: { used: number; max: number | null } | null = null;

  constructor(private readonly emit: (e: EventBody) => void) {}

  report(used: number, max: number | null, force = false): void {
    const last = this.sent;
    if (last && last.used === used && last.max === max) return;
    const percent = (u: number, m: number | null) => (m ? Math.round((u / m) * 100) : null);
    if (!force && (max === null || (last && percent(last.used, last.max) === percent(used, max)))) return;
    this.sent = { used, max };
    this.emit({ type: "context_usage", usedTokens: used, maxTokens: max });
  }
}
