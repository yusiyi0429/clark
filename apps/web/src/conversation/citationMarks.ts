/**
 * 出处标记（10/14）：回答里句末位置的出处链接显示成一个很小的标记（conversation/citations.tsx 的 CitationMark）。
 *
 * Agent 的新写法（apps/api/src/sourceCitations.ts）：正文直接陈述，出处写成紧跟在那一句末尾的 `[资料名称](地址)`，
 * 地址是 `cite:<ref>`、原网址，或没有引用标记也没有网址时的 `cite:source`。
 * 这个 remark 插件在 Markdown 语法树上判断每个出处链接是不是「句末的出处」：
 * - 前面接着一句话（不是段首、不是「来源：」「见」「据」这类引出语），后面是句末标点、段尾或换行 → 标记；
 * - 链接本身是句子的一部分（如「[《经营原则》](cite:…)写明」「来源：[…](cite:…)」）→ 照旧显示名称；
 * - 旧写法里括号中只有出处的（`（[《X》](cite:…)）`，或括号里只有书名号资料名 `（《X》）`）：去掉括号，显示成标记。
 * 正文开头的「《X》写明」不回改。
 */

type MdNode = {
  type: string;
  value?: string;
  url?: string;
  children?: MdNode[];
  data?: { hProperties?: Record<string, unknown> } & Record<string, unknown>;
};

/** 标记在 hast / React 属性里的名字：CitationAnchor 见到它就画成标记。 */
export const CITE_MARK_PROP = "data-cite-mark";
/** 没有引用标记也没有网址的出处（只显示名称）。与 apps/api/src/sourceCitations.ts 的 NAMED_SOURCE_REF 同一口径。 */
export const NAMED_SOURCE = "cite:source";

const SOURCE_URL = /^(?:cite:|https?:\/\/)/i;
/** 几个出处链接连着写时中间的分隔。 */
const BETWEEN = /^[\s、，,；;]*$/u;
/** 括号开头（可带「见」「据」「来源：」这类引出语）。 */
const OPEN_PAREN = /[（(]\s*(?:见|参见|详见|据|来源[：:]?|出处[：:]?|依据[：:]?)?\s*$/u;
const CLOSE_PAREN = /^\s*[）)]/u;
/** 链接前是这些时，链接是句子成分（名称要读出来），不画成标记。 */
const LEAD_IN = /(?:[：:、]|参考|参见|详见|根据|依据|按照|来自|出自|引自|来源|出处|(?:^|[\s，,。；;（(])(?:见|据|和|与|及|或))\s*$/u;
/** 链接后是这些时，链接在句末：句末标点、闭合引号括号、换行、段尾。 */
const CLAUSE_END = /^[ \t]*(?:$|\n|[。．.，,；;：:！!？?、）)」』”’"\]])/u;

/** 括号里只有书名号资料名（可带版本、章节、日期）：旧写法句末重复的出处。 */
const TITLE = String.raw`《[^《》\n]{1,60}》(?:\s*(?:第\s*\d+\s*[版节段页条]|\d{1,2}\/\d{1,2}(?:\s*版)?|\d{1,2}\s*月(?:\s*\d{1,2}\s*日)?(?:\s*版)?|\d{4}-\d{2}-\d{2}|v\d+))*`;
const PAREN_TITLES = new RegExp(String.raw`\s*[（(]\s*(?:见|据|来源[：:]?|出处[：:]?)?\s*(${TITLE}(?:\s*[、，,；;]\s*${TITLE})*)\s*[）)]`, "gu");
const ONE_TITLE = new RegExp(TITLE, "gu");

const isSourceLink = (node: MdNode | undefined): node is MdNode => node?.type === "link" && typeof node.url === "string" && SOURCE_URL.test(node.url.trim());
const isText = (node: MdNode | undefined): node is MdNode & { value: string } => node?.type === "text" && typeof node.value === "string";

function markLink(node: MdNode) {
  node.data = { ...node.data, hProperties: { ...node.data?.hProperties, [CITE_MARK_PROP]: "" } };
}

/** 文字节点里括号中只有资料名的，换成「只显示名称」的出处标记（前面得接着一句话、后面是句末）。 */
function expandParenTitles(children: MdNode[]): MdNode[] {
  const out: MdNode[] = [];
  for (const child of children) {
    if (!isText(child) || !child.value.includes("《")) { out.push(child); continue; }
    const value = child.value;
    let cursor = 0;
    let changed = false;
    for (const match of value.matchAll(PAREN_TITLES)) {
      const at = match.index!;
      const before = value.slice(cursor, at);
      const after = value.slice(at + match[0].length);
      // 段首的括号、后面还接着话的括号（「（《X》）里提到」）不动。
      if (!value.slice(0, at).trim() || !CLAUSE_END.test(after)) continue;
      out.push({ type: "text", value: before });
      for (const title of match[1].match(ONE_TITLE) ?? []) {
        const link: MdNode = { type: "link", url: NAMED_SOURCE, children: [{ type: "text", value: title.trim() }] };
        markLink(link);
        out.push(link);
      }
      cursor = at + match[0].length;
      changed = true;
    }
    if (!changed) { out.push(child); continue; }
    out.push({ type: "text", value: value.slice(cursor) });
  }
  return out;
}

/** 一串连着的出处链接 [start, end]（中间只有分隔符）：判断是不是句末的出处，是就画成标记。 */
function markRuns(children: MdNode[]) {
  for (let start = 0; start < children.length; start++) {
    if (!isSourceLink(children[start])) continue;
    let end = start;
    while (isSourceLink(children[end + 2]) && isText(children[end + 1]) && BETWEEN.test(children[end + 1].value!)) end += 2;
    const links = children.slice(start, end + 1).filter(isSourceLink);
    if (links.every((link) => link.data?.hProperties?.[CITE_MARK_PROP] !== undefined)) { start = end; continue; }
    const prev = children[start - 1];
    const next = children[end + 1];
    let prevText = isText(prev) ? prev.value : null;
    let nextText = isText(next) ? next.value : null;
    // 旧写法：括号里只有出处，去掉括号。
    let stripped = false;
    if (prevText !== null && nextText !== null && OPEN_PAREN.test(prevText) && CLOSE_PAREN.test(nextText)) {
      prevText = prevText.replace(OPEN_PAREN, "").replace(/\s+$/u, "");
      nextText = nextText.replace(CLOSE_PAREN, "");
      stripped = true;
    }
    const before = prev !== undefined && (prevText === null || (prevText.trim() !== "" && !LEAD_IN.test(prevText)));
    const after = next === undefined || (nextText !== null && CLAUSE_END.test(nextText));
    if (before && after) {
      if (stripped) { prev!.value = prevText!; next!.value = nextText!; }
      for (const link of links) markLink(link);
      for (let index = start + 1; index < end; index += 2) children[index].value = "";
    }
    start = end;
  }
}

function walk(node: MdNode) {
  if (!node.children || node.type === "link") return;
  node.children = expandParenTitles(node.children);
  markRuns(node.children);
  for (const child of node.children) walk(child);
}

/** remark 插件：接在对话正文的 remark 插件之后。 */
export function remarkCitationMarks() {
  return (tree: MdNode) => walk(tree);
}

/**
 * 流式中还在长的最后一块：末尾没写完、看得出是出处的链接先不显示，写完再一起出来——句末的出处直接以标记出现，不先闪一下名称。
 * 看得出是出处：地址已经写到 `cite:`，或名称以书名号「《」开头（`[《名称`、`[《名称》]`、`[《名称》](https://…`）。
 * 其他没写完的链接（「详见 [交付排期](https://exam」）照旧交给 remend 只显示文字；太长（80 字以上）的未闭合方括号当普通文字。
 */
export function holdOpenLink(text: string): string {
  const match = /\[([^[\]\n]{0,80})(?:\](?:\(([^)\s]*))?)?$/u.exec(text);
  if (!match) return text;
  const source = match[1].startsWith("《") || (match[2] ?? "").startsWith("cite:");
  return source ? text.slice(0, match.index).replace(/[ \t]+$/u, "") : text;
}
