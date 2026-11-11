import type { TLocalSessionDraft } from "@warmap/contracts";

type Listener = (d: TLocalSessionDraft) => void;
interface State { text: string; timer: NodeJS.Timeout | null; sentAt: number; shown: boolean }

/**
 * 「正在写」的草稿（契约 LocalSessionDraft）：只推给正在看的网页，不写盘、不占编号。
 * 执行方每来几个字报一次这一段的全文，这里合并成每 intervalMs 至多一条（第一条马上发，最后一条一定发出去）。
 */
export class Drafts {
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly states = new Map<string, State>();

  constructor(private readonly intervalMs = 80) {}

  subscribe(sessionId: string, fn: Listener): () => void {
    const set = this.listeners.get(sessionId) ?? new Set<Listener>();
    set.add(fn);
    this.listeners.set(sessionId, set);
    return () => set.delete(fn);
  }

  /** 正在写的这一段到目前为止的全文；空串是这一段不写了（网页清掉草稿，之前没发过就不发）。 */
  set(sessionId: string, text: string): void {
    const s = this.states.get(sessionId) ?? { text: "", timer: null, sentAt: 0, shown: false };
    this.states.set(sessionId, s);
    s.text = text;
    // 清掉马上发（排在这一轮结束之前），不等合并
    if (!text && s.timer) { clearTimeout(s.timer); s.timer = null; s.sentAt = 0; }
    if (s.timer) return;
    const wait = s.sentAt + this.intervalMs - Date.now();
    if (wait <= 0) this.flush(sessionId, s);
    else s.timer = setTimeout(() => this.flush(sessionId, s), wait);
  }

  /** 这一段写完了（assistant_text 到了，网页拿它替换草稿）：还没发的草稿不再发。 */
  done(sessionId: string): void {
    const s = this.states.get(sessionId);
    if (!s) return;
    if (s.timer) clearTimeout(s.timer);
    this.states.delete(sessionId);
  }

  private flush(sessionId: string, s: State) {
    s.timer = null;
    if (this.states.get(sessionId) !== s) return;
    if (!s.text && !s.shown) return;
    s.sentAt = Date.now();
    s.shown = Boolean(s.text);
    const draft: TLocalSessionDraft = { type: "draft", sessionId, text: s.text };
    for (const fn of this.listeners.get(sessionId) ?? []) fn(draft);
  }
}
