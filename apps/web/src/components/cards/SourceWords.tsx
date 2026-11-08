/** 本人原话（设计 16.8）：卡、派活单草稿上的 sourceWords，规划员从本人的话里原样摘的片段。为空不画。 */
export function SourceWords({ words, className }: { words: readonly string[]; className: string }) {
  if (!words.length) return null;
  return <blockquote className={className} data-testid="source-words">{words.map((word, index) => <p key={index}>{word}</p>)}</blockquote>;
}
