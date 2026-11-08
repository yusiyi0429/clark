/**
 * 本人原话（设计 16.8）：卡、派活单草稿上的 sourceWords，规划员从本人的话里原样摘的片段。为空不画。
 * B 的契约还没带这个字段时先这样读，契约出来以后换成类型上的字段。
 */
export function sourceWordsOf(value: object | null | undefined): string[] {
  const words = (value as { sourceWords?: unknown } | null | undefined)?.sourceWords;
  return Array.isArray(words) ? words.filter((word): word is string => typeof word === "string" && !!word.trim()) : [];
}

export function SourceWords({ words, className }: { words: string[]; className: string }) {
  if (!words.length) return null;
  return <blockquote className={className} data-testid="source-words">{words.map((word, index) => <p key={index}>{word}</p>)}</blockquote>;
}
