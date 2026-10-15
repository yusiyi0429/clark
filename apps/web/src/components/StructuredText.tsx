import type { ReactNode } from "react";

/**
 * Agent 写的说明文字按「结论先行、结构化」展示（2026-10 反馈会议）：
 * - 以「- / • / 1.」开头的行排成要点列表；每条里的 **加粗** 是核心结论或待判断的问题，后面接「：解释」；
 * - 没有要点的短文字照旧一段话，只把 **加粗** 记号换成粗体（不让星号原样露出来）。
 * 纯展示层，只认文字里已有的记号，不改数据库。
 */
const BULLET_RE = /^(?:[-*•·]|\d{1,2}[.、)])\s+(.*)$/;
const BOLD_RE = /\*\*([^*\n]+)\*\*/g;

export function inlineBold(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(BOLD_RE)) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    parts.push(<strong key={match.index}>{match[1]}</strong>);
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.length ? parts : [text];
}

/** 把一段文字拆成「要点列表 / 段落」块；没有内容返回空数组。 */
export function structuredBlocks(text: string | null | undefined): { kind: "list" | "para"; items: string[] }[] {
  const blocks: { kind: "list" | "para"; items: string[] }[] = [];
  for (const raw of (text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const bullet = BULLET_RE.exec(line);
    const kind = bullet ? "list" : "para";
    const body = bullet ? bullet[1] : line;
    const tail = blocks[blocks.length - 1];
    if (kind === "list" && tail?.kind === "list") tail.items.push(body);
    else blocks.push({ kind, items: [body] });
  }
  return blocks;
}

/** 直接放进父容器：段落是 <p>，要点是 <ul>（样式由父容器的 `> p` / `> ul` 规则给）。 */
export function StructuredText({ text }: { text: string | null | undefined }) {
  const blocks = structuredBlocks(text);
  return (
    <>
      {blocks.map((block, index) => block.kind === "list"
        ? <ul key={index}>{block.items.map((item, at) => <li key={at}>{inlineBold(item)}</li>)}</ul>
        : <p key={index}>{inlineBold(block.items[0])}</p>)}
    </>
  );
}
