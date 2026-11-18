import { splitStableBlocks } from "./smoothText";

/**
 * 伙伴的一条回复拆成气泡和卡片（设计稿 6.2）。
 * - 卡片：以标题开头的一节（吞到下一个标题或末尾）、表格、代码块 / 富块 / 公式块、长清单；相邻的非标题卡片料并成一张。
 * - 单独一行的加粗当小标题，吞到下一个小标题：里面有卡片料就整节成卡（标题是小标题），否则整节一个气泡。
 *   小标题紧跟着又是加粗行（中间只隔空行）：并成一节，标题取第一行。
 * - 其余是气泡；以冒号结尾的段落和紧跟着的短清单并成一个气泡。
 * - 流式中 `segments` 只往后长：还没写完、或还可能被后面的内容改写的块（标题还可能往下吞、卡片料还可能并上下一块、
 *   冒号结尾的话还要看下一块、短清单还可能变长）连同它后面已经到的文字放进 `tail`。
 *   还没定下来的加粗小标题一节，尾巴一律是卡片壳子（同 # 那一节），只会展开成全文，不会从气泡变成卡。
 */

export type ReplySegment =
  | { kind: "bubble"; markdown: string }
  | { kind: "card"; markdown: string; title: string; summary: string };
export type ReplyTail = { kind: "bubble" | "card"; markdown: string; title: string } | null;

type PartKind = "heading" | "code" | "table" | "list" | "paragraph";
/** 一段：空行隔开的一个结构（段落、清单、表格、代码……）。`start`：第一行的行号。`open`：围栏或公式块还没关上。 */
type Part = { kind: PartKind; start: number; lines: string[]; open: boolean };

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const MATH = /^ {0,3}\$\$/;
const HEADING = /^ {0,3}#{1,6}(?:[ \t]|$)/;
const TABLE_ROW = /^ {0,3}\|/;
const LIST_ITEM = /^([ \t]*)(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;
const SHORT_LIST_ITEMS = 5;
const SHORT_LIST_ITEM_CHARS = 24;
const TITLE_CHARS = 40;
const SUMMARY_CHARS = 60;

function lineKind(line: string): PartKind {
  if (FENCE.test(line) || MATH.test(line)) return "code";
  if (HEADING.test(line)) return "heading";
  if (TABLE_ROW.test(line)) return "table";
  if (LIST_ITEM.test(line) && /^ {0,3}\S/.test(line)) return "list";
  return "paragraph";
}

/** 开围栏 / 公式块的这一行：返回等着收尾的记号；一行写完的 `$$…$$` 不算开着。 */
function opening(line: string): string | null {
  const fence = FENCE.exec(line)?.[1];
  if (fence) return fence[0].repeat(3);
  if (MATH.test(line) && (line.match(/\$\$/g)?.length ?? 0) % 2 === 1) return "$$";
  return null;
}

function closes(line: string, close: string): boolean {
  if (close === "$$") return line.includes("$$");
  return FENCE.exec(line)?.[1].startsWith(close) ?? false;
}

/** 这一行接在上一段里：清单的缩进续行、松散清单的下一项、没隔空行的续行；标题、围栏、公式块总是新起一段。 */
function continues(last: Part, line: string, kind: PartKind, blank: boolean): boolean {
  if (last.kind === "list" && /^[ \t]/.test(line)) return true;
  if (kind === "heading" || kind === "code") return false;
  if (last.kind === "code" && !last.open) return false;
  if (!blank) return true;
  return last.kind === "list" && kind === "list";
}

/**
 * 先用 splitStableBlocks 切顶层块（不在代码块、清单、引用、表格中间切），块里再按空行细分：
 * splitStableBlocks 不在清单、表格前面切（「三件事：」和它的清单、代码块和紧跟的表格在一块里），这里要分开分别归类；
 * 它也不认 `$$` 公式块，公式块里的空行在这里接回去。
 */
function toParts(text: string): Part[] {
  const parts: Part[] = [];
  let close: string | null = null;
  let blank = false;
  let lineNumber = -1;
  for (const block of splitStableBlocks(text)) {
    block.split("\n").forEach((line, index) => {
      lineNumber += 1;
      const last = parts.at(-1);
      if (close && last) {
        last.lines.push(line);
        if (closes(line, close)) {
          close = null;
          last.open = false;
        }
        return;
      }
      if (!line.trim()) {
        last?.lines.push(line);
        blank = true;
        return;
      }
      const kind = lineKind(line);
      const fence = opening(line);
      if (last && index > 0 && continues(last, line, kind, blank)) last.lines.push(line);
      else parts.push({ kind, start: lineNumber, lines: [line], open: false });
      if (fence) {
        close = fence;
        parts.at(-1)!.open = true;
      }
      blank = false;
    });
  }
  return parts;
}

/** 去掉 Markdown 记号：行首的清单符号、标题井号、引用号，行内的 `**`、反引号、`$$`。 */
function plain(line: string): string {
  return line
    .replace(/^[ \t]*(?:(?:[-*+]|\d{1,9}[.)]|#{1,6}|>)(?=[ \t]|$)[ \t]*)*/, "")
    .replace(/\*\*|`|\$\$/g, "")
    .trim();
}

function cells(row: string): string {
  return row.trim().replace(/^\||\|$/g, "").split("|").map((cell) => plain(cell)).join(" · ");
}

function truncate(text: string, max: number): string {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : text;
}

function isDelimiterRow(line: string): boolean {
  return line.includes("|") && /^[\s|:-]*-[\s|:-]*$/.test(line);
}

function lineText(line: string): string {
  return TABLE_ROW.test(line) ? cells(line) : plain(line);
}

/** 只有记号的围栏行、`$$` 行：不当标题、摘要（代码卡不取围栏上的语言名）。 */
function isMarkerLine(line: string): boolean {
  return FENCE.test(line) || /^ {0,3}\$\$[ \t]*$/.test(line);
}

/** 卡的标题和摘要：第一、第二行有内容的文字（跳过表格分隔行、围栏行）。 */
function describeCard(markdown: string): { title: string; summary: string } {
  const texts: string[] = [];
  for (const line of markdown.split("\n")) {
    if (texts.length === 2) break;
    if (isDelimiterRow(line) || isMarkerLine(line)) continue;
    const text = lineText(line);
    if (text) texts.push(text);
  }
  return { title: truncate(texts[0] ?? "", TITLE_CHARS), summary: truncate(texts[1] ?? "", SUMMARY_CHARS) };
}

/** 长清单：超过 5 项，或有嵌套，或有一项超过 24 个字。 */
function isLongList(part: Part): boolean {
  const base = LIST_ITEM.exec(part.lines[0])?.[1].length ?? 0;
  let items = 0;
  for (const line of part.lines) {
    const indent = LIST_ITEM.exec(line)?.[1].length;
    if (indent === undefined) continue;
    if (indent > base) return true;
    items += 1;
    if (items > SHORT_LIST_ITEMS || [...plain(line)].length > SHORT_LIST_ITEM_CHARS) return true;
  }
  return false;
}

function isCardMaterial(part: Part): boolean {
  return part.kind === "code" || part.kind === "table" || (part.kind === "list" && isLongList(part));
}

function endsWithColon(part: Part): boolean {
  return part.kind === "paragraph" && /[：:]$/.test(part.lines.join("\n").trimEnd());
}

/** 单独一行的加粗（小标题）：整行是一对 `**…**`，行尾可带冒号（在 `**` 里外都算），前后空白不算。 */
const BOLD_LINE = /^\s*\*\*(?:(?!\*\*).)*\S(?:(?!\*\*).)*\*\*[：:]?\s*$/;

/** 这一段只有一行，整行是加粗：当小标题，和后面各段合成一节（本人 11/18）。 */
function isBoldHeading(part: Part): boolean {
  const lines = part.lines.filter((line) => line.trim());
  return part.kind === "paragraph" && lines.length === 1 && BOLD_LINE.test(lines[0]);
}

/**
 * 一组：拼成一个气泡或一张卡的连续几段，`parts[from, to)`。
 * `lookahead`：这一组拼成什么还要看下一段（标题、加粗小标题往下吞、卡片料并上下一块、冒号结尾的话并上短清单）。
 * `bold`：以加粗小标题开头的一节，成卡时标题用小标题的文字。
 */
type Group = { kind: "bubble" | "card"; from: number; to: number; lookahead: boolean; bold?: boolean };

function group(parts: Part[]): Group[] {
  const groups: Group[] = [];
  for (let from = 0; from < parts.length; ) {
    const part = parts[from];
    let to = from + 1;
    if (part.kind === "heading") {
      while (to < parts.length && parts[to].kind !== "heading") to++;
    } else if (isBoldHeading(part)) {
      // 小标题后面紧跟着又是加粗行：并进这一节。再吞到下一个小标题（# 标题或加粗行）；里面有卡片料就整节成卡，否则整节一个气泡。
      while (to < parts.length && isBoldHeading(parts[to])) to++;
      while (to < parts.length && parts[to].kind !== "heading" && !isBoldHeading(parts[to])) to++;
      const card = parts.slice(from + 1, to).some(isCardMaterial);
      groups.push({ kind: card ? "card" : "bubble", from, to, lookahead: true, bold: true });
      from = to;
      continue;
    } else if (isCardMaterial(part)) {
      while (to < parts.length && isCardMaterial(parts[to])) to++;
    } else if (endsWithColon(part) && parts[to]?.kind === "list" && !isLongList(parts[to])) {
      to++;
    }
    const card = part.kind === "heading" || isCardMaterial(part);
    groups.push({ kind: card ? "card" : "bubble", from, to, lookahead: card || to === from + 1 && endsWithColon(part) });
    from = to;
  }
  return groups;
}

/** 卡的标题和摘要；加粗小标题开头的卡，标题去掉末尾的冒号。 */
function describeGroup(group: Group, markdown: string): { title: string; summary: string } {
  const described = describeCard(markdown);
  if (!group.bold) return described;
  const title = lineText(markdown.split("\n")[0]).replace(/[：:]$/, "");
  return { title: truncate(title, TITLE_CHARS), summary: described.summary };
}

/**
 * 这一段的类别定了：第一行已经写完；或者还没写完，但已经不是某个块记号的半截——
 * 「-」「#」「``」「$」「1」「1.」这类再写一个字可能变成清单、标题、围栏、公式，要等；
 * 「**注意**」「`npm`」「12个人」「1.5倍」、汉字开头当场就算。
 */
const MARKER_PREFIX = /^(?:[-*+]|#{1,6}|`{1,2}|~{1,2}|\$|\d{1,9}[.)]?)$/;

function begun(part: Part, last: number): boolean {
  return part.start < last || !MARKER_PREFIX.test(part.lines[0].trimStart());
}

/**
 * 流式中这一段以后不会再变（`last` 是最后一行、可能还没写完那一行的行号）：
 * 后面已经起了一段且类别定了，或者自己后面有一行写完的空行（清单、没关上的围栏不算，空行后面还能接）。
 */
function closed(parts: Part[], index: number, last: number): boolean {
  const next = parts[index + 1];
  if (next && begun(next, last)) return true;
  const part = parts[index];
  if (part.kind === "list" || part.open) return false;
  let content = part.lines.length - 1;
  while (content > 0 && !part.lines[content].trim()) content--;
  return content + 1 < part.lines.length && part.start + content + 1 < last;
}

/**
 * 流式中这一组以后不会再变：最后一段关上了；要看下一段的，下一段的类别也定了
 * （清单要等它关上，免得短清单再变长；加粗行要等它关上，免得后面接上字、不再是小标题）。
 */
function settled(parts: Part[], group: Group, last: number): boolean {
  if (!closed(parts, group.to - 1, last)) return false;
  if (!group.lookahead) return true;
  const next = parts[group.to];
  return next !== undefined && begun(next, last) && (next.kind !== "list" && !isBoldHeading(next) || closed(parts, group.to, last));
}

function markdownOf(parts: Part[]): string {
  return parts.flatMap((part) => part.lines).join("\n").trimEnd();
}

// 块的序号被按块的表情（reaction 的 part）用到：改拆分规则会让历史上的表情挂到别的块上。
export function splitReply(markdown: string, streaming = false): { segments: ReplySegment[]; tail: ReplyTail } {
  const parts = toParts(markdown);
  const groups = group(parts);
  const last = markdown.split("\n").length - 1;
  const done = streaming ? groups.findIndex((group) => !settled(parts, group, last)) : -1;
  const segments = (done === -1 ? groups : groups.slice(0, done)).map((group): ReplySegment => {
    const text = markdownOf(parts.slice(group.from, group.to));
    return group.kind === "card" ? { kind: "card", markdown: text, ...describeGroup(group, text) } : { kind: "bubble", markdown: text };
  });
  if (done === -1) return { segments, tail: null };
  const pending = groups[done];
  const text = markdownOf(parts.slice(pending.from));
  // 加粗小标题那一节还没定下来：先出卡片壳子，写完再按有没有卡片料定成卡或气泡。
  const kind = pending.bold ? "card" : pending.kind;
  return { segments, tail: { kind, markdown: text, title: kind === "card" ? describeGroup(pending, text).title : "" } };
}
