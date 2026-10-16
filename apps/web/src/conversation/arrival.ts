/**
 * 柔和输出（B2）：把流式回答按「到达批次」切成一段段 span，每段第一次出现时由浅到深淡入。
 *
 * 做法与 Streamdown 的 animate 插件同理（新字包进带动画的 span，已经显示的字不再动画），差别在切法：
 * Streamdown 按空白切词，中文整句没有空格、追加的字不会淡入；按字切则每个汉字一个 span。
 * 这里按「这一帧新到的字」切：几个字也单独成段，段数只和到达的次数有关。
 * 段的位置只追加不改，React 复用已有的 span，只给新段挂新节点——CSS 动画只在挂载时播一次，所以旧字不会重播。
 */

/** 一条正在流式的回答的到达记录：每次渲染时文字累计到哪（hast 文字计数）。 */
export type ArrivalLog = { marks: number[]; text: string; generation: number };

export function createArrivalLog(): ArrivalLog {
  return { marks: [], text: "", generation: 0 };
}

/** 文字不是在上一次的基础上接着长（换了一段新回答），到达记录从头开始；只是收掉了末尾（如块尾的空行）照旧沿用。 */
function follow(log: ArrivalLog, text: string) {
  if (!text.startsWith(log.text) && !log.text.startsWith(text)) {
    log.marks = [];
    log.generation += 1;
  }
  log.text = text;
}

function record(log: ArrivalLog, total: number) {
  if (total > (log.marks.at(-1) ?? 0)) log.marks.push(total);
}

/** 在 [start, end) 里按到达记录切开。 */
function cut(marks: readonly number[], start: number, end: number): [number, number][] {
  const parts: [number, number][] = [];
  let cursor = start;
  for (const mark of marks) {
    if (mark <= cursor) continue;
    if (mark >= end) break;
    parts.push([cursor, mark]);
    cursor = mark;
  }
  parts.push([cursor, end]);
  return parts;
}

type HastNode = { type: string; value?: string; tagName?: string; properties?: Record<string, unknown>; children?: HastNode[] };

const isKatex = (node: HastNode) => {
  const names = node.properties?.className;
  return Array.isArray(names) && names.some((name) => name === "katex" || name === "katex-display");
};

/**
 * rehype 插件（接在 react-markdown 上）：按到达记录把文字节点切成 `<span data-arrival>`。
 * 只含空白的文字节点（块与块之间的换行）不包，免得 `<ol>`、`<tr>` 里出现 span。
 * `source` 是这次渲染的原文：原文不是接着上次长的，记录从头开始。
 */
export function rehypeArrival(log: ArrivalLog, source?: string) {
  return () => (tree: HastNode) => {
    if (source !== undefined) follow(log, source);
    let count = 0;
    const walk = (node: HastNode) => {
      if (!node.children) return;
      const next: HastNode[] = [];
      for (const child of node.children) {
        if (child.type !== "text") {
          // 公式（KaTeX 已渲染好的那一棵）整块出现，不切进去：切开会打乱 KaTeX 的排版结构。
          if (!isKatex(child)) walk(child);
          next.push(child);
          continue;
        }
        const value = child.value ?? "";
        const start = count;
        count += value.length;
        if (!value.trim()) {
          next.push(child);
          continue;
        }
        for (const [from, to] of cut(log.marks, start, count)) {
          next.push({ type: "element", tagName: "span", properties: { dataArrival: "" }, children: [{ type: "text", value: value.slice(from - start, to - start) }] });
        }
      }
      node.children = next;
    };
    walk(tree);
    record(log, count);
  };
}
