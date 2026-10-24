/** The selected text stays separate from the user's own message until they send it. */
export type QuoteSource = {
  label?: string;
  scope?: string;
  objectType?: string;
  objectId?: string;
  missionId?: string;
  field?: string;
  sourceRound?: number;
  sourceVersion?: number;
  /** 月度计划逐段评审：plan-review = 对这一段的意见；plan-rewrite = 按意见重写这一段（Agent 据此决定只复述还是写入）。 */
  intent?: string;
};
export type TextQuote = { id: string; text: string; source?: QuoteSource };
/** 本地存着的输入条草稿（去掉首尾空白）；存储不可用时当作没有。 */
export function storedDraft(key: string): string {
  try { return localStorage.getItem(key)?.trim() ?? ""; } catch { return ""; }
}

/**
 * draft：「起草文档」这类入口预填进输入条的一句话；输入条里已有草稿时不覆盖。
 * send：代一号位直接发出一条消息（「按意见重写」）：带自己的引用，不动输入条里的草稿和已挂的引用块；onResult 回报服务端是否接下。
 */
export type QuotePrefill = {
  text: string;
  nonce: number;
  source?: QuoteSource;
  draft?: string;
  send?: { message: string; quotes: TextQuote[]; onResult?: (accepted: boolean) => void };
};

const PREFIX = "[天枢引用上下文 v1]\n";

/** Keep the existing conversation contract and persist the exact selection and source with the turn. */
export function quotedMessage(message: string, quotes: TextQuote[]): string {
  if (!quotes.length) return message;
  return PREFIX + JSON.stringify({ message, quotes: quotes.map(({ text, source }) => ({ text, source })) }, null, 2);
}

/** 页面上下文（演示战场页等）放在发给 Agent 的文字最前面，界面上不显示。 */
export const PAGE_CONTEXT_MARK = "【页面】";
export function stripPageContext(content: string): string {
  if (content.startsWith(PAGE_CONTEXT_MARK)) return content.replace(/^【页面】[^\n]*\n\n/u, "");
  // 早先场次里没有标记的战场页上下文
  return content.replace(/^正在讨论战场「[^\n]*」（[^\n]*战场id=[^\n]*）\n\n/u, "");
}

/**
 * 这句话是在哪个战场页问的：三个战场页共用一条「天枢」对话，每条提问上标出战场（巡检 P1-18）。
 * 只认消息最前面的页面上下文；其它页面发的没有。
 */
export function pageContextBattlefield(content: string): string | null {
  return /^(?:【页面】)?正在讨论战场「([^」\n]+)」（[^\n]*战场id=[^\n]*）\n\n/u.exec(content)?.[1] ?? null;
}

/** History displays a compact reference. Malformed or older messages always remain readable in full. */
export function readQuotedMessage(raw: string): { message: string; quotes: TextQuote[] } {
  const content = stripPageContext(raw);
  const original = { message: content, quotes: [] };
  if (!content.startsWith(PREFIX)) return original;
  try {
    const value: unknown = JSON.parse(content.slice(PREFIX.length));
    if (!value || typeof value !== "object") return original;
    const body = value as { message?: unknown; quotes?: unknown };
    if (typeof body.message !== "string" || !Array.isArray(body.quotes) || !body.quotes.length) return original;
    const quotes: TextQuote[] = [];
    for (const [index, entry] of body.quotes.entries()) {
      if (!entry || typeof entry !== "object" || typeof entry.text !== "string" || !entry.text.trim()) return original;
      if (entry.source !== undefined && (!entry.source || typeof entry.source !== "object" || Array.isArray(entry.source))) return original;
      const source = entry.source as QuoteSource | undefined;
      if (source && Object.entries(source).some(([key, value]) =>
        ["sourceRound", "sourceVersion"].includes(key) ? typeof value !== "number" : typeof value !== "string")) return original;
      quotes.push({ id: `sent-${index}`, text: entry.text, source });
    }
    return { message: body.message, quotes };
  } catch { return original; }
}

export function appendQuote(quotes: TextQuote[], next: TextQuote): TextQuote[] {
  const previous = quotes.find((item) => item.text === next.text && JSON.stringify(item.source) === JSON.stringify(next.source));
  // A fresh selection gets its own id even when it replaces an existing chip: an older send must not clear it.
  return previous ? quotes.map((item) => item.id === previous.id ? next : item) : [...quotes, next];
}

/** 对话里某条消息被选中一段挂成「回复」时，来源上带的标记；其余挂上的内容（材料、议题、战场……）叫「批注」。 */
export const MESSAGE_REPLY = "message-reply";
export const isReplyQuote = (quote: TextQuote): boolean => quote.source?.intent === MESSAGE_REPLY;

/** 同一句（同一来源）的引用。 */
const sameQuote = (a: TextQuote, b: TextQuote) => a.id === b.id || (a.text === b.text && JSON.stringify(a.source) === JSON.stringify(b.source));

/**
 * 发送失败放回引用（D5）：放回的排在前面（它们本来就先加），期间新加的留在后面；
 * 期间又引了同一句的，留新的那条、不重复。
 */
export function restoreQuotes(current: TextQuote[], restored: TextQuote[]): TextQuote[] {
  const back = restored.filter((item) => !current.some((existing) => sameQuote(existing, item)));
  return back.length ? [...back, ...current] : current;
}
