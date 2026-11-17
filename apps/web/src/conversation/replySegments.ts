import { splitStableBlocks } from "./smoothText";

/**
 * 伙伴的一条回复拆成气泡和卡片（设计稿 6.2）。
 * - 卡片：以标题开头的一节（吞到下一个标题或末尾）、表格、代码块 / 富块 / 公式块、长清单；相邻的非标题卡片料并成一张。
 * - 其余是气泡；以冒号结尾的段落和紧跟着的短清单并成一个气泡。
 * - 流式中最后一块没写完、或最后一节标题还可能往下吞，放进 `tail`，不进 `segments`。
 */

export type ReplySegment =
  | { kind: "bubble"; markdown: string }
  | { kind: "card"; markdown: string; title: string; summary: string };
export type ReplyTail = { kind: "bubble" | "card"; markdown: string; title: string } | null;

type PartKind = "heading" | "code" | "table" | "list" | "paragraph";
/** 一段：空行隔开的一个结构（段落、清单、表格、代码……）。`open`：围栏或公式块还没关上。 */
type Part = { kind: PartKind; lines: string[]; open: boolean };

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
  for (const block of splitStableBlocks(text)) {
    block.split("\n").forEach((line, index) => {
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
      else parts.push({ kind, lines: [line], open: false });
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

function cardTitle(markdown: string): string {
  return truncate(lineText(markdown.split("\n")[0]), TITLE_CHARS);
}

/** 标题来源那一行之后第一行有内容的文字（跳过表格分隔行、围栏行）。 */
function cardSummary(markdown: string): string {
  for (const line of markdown.split("\n").slice(1)) {
    if (isDelimiterRow(line) || FENCE.test(line) || MATH.test(line)) continue;
    const text = lineText(line);
    if (text) return truncate(text, SUMMARY_CHARS);
  }
  return "";
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

type Group = { kind: "bubble" | "card"; parts: Part[]; heading: boolean };

function group(parts: Part[]): Group[] {
  const groups: Group[] = [];
  for (let at = 0; at < parts.length; ) {
    const part = parts[at];
    let end = at + 1;
    if (part.kind === "heading") {
      while (end < parts.length && parts[end].kind !== "heading") end++;
    } else if (isCardMaterial(part)) {
      while (end < parts.length && isCardMaterial(parts[end])) end++;
    } else if (part.kind === "paragraph" && /[：:]$/.test(part.lines.join("\n").trimEnd())
      && parts[end]?.kind === "list" && !isLongList(parts[end])) {
      end++;
    }
    const card = part.kind === "heading" || isCardMaterial(part);
    groups.push({ kind: card ? "card" : "bubble", parts: parts.slice(at, end), heading: part.kind === "heading" });
    at = end;
  }
  return groups;
}

function markdownOf(group: Group): string {
  return group.parts.flatMap((part) => part.lines).join("\n").trimEnd();
}

export function splitReply(markdown: string, streaming = false): { segments: ReplySegment[]; tail: ReplyTail } {
  const groups = group(toParts(markdown));
  let tail: ReplyTail = null;
  const last = groups.at(-1);
  if (streaming && last) {
    const unfinished = !/\n[ \t]*\n\s*$/.test(markdown) || last.parts.some((part) => part.open) || last.heading;
    if (unfinished) {
      groups.pop();
      const text = markdownOf(last);
      tail = { kind: last.kind, markdown: text, title: last.kind === "card" ? cardTitle(text) : "" };
    }
  }
  const segments = groups.map((group): ReplySegment => {
    const text = markdownOf(group);
    return group.kind === "card"
      ? { kind: "card", markdown: text, title: cardTitle(text), summary: cardSummary(text) }
      : { kind: "bubble", markdown: text };
  });
  return { segments, tail };
}
