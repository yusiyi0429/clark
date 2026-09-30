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
};
export type TextQuote = { id: string; text: string; source?: QuoteSource };
export type QuotePrefill = { text: string; nonce: number; source?: QuoteSource };

const PREFIX = "[天枢引用上下文 v1]\n";

/** Keep the existing conversation contract and persist the exact selection and source with the turn. */
export function quotedMessage(message: string, quotes: TextQuote[]): string {
  if (!quotes.length) return message;
  return PREFIX + JSON.stringify({ message, quotes: quotes.map(({ text, source }) => ({ text, source })) }, null, 2);
}

/** History displays a compact reference. Malformed or older messages always remain readable in full. */
export function readQuotedMessage(content: string): { message: string; quotes: TextQuote[] } {
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
