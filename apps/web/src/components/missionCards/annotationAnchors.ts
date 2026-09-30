/** Anchors refer to rendered text, so Markdown punctuation never enters the selection. */
export type TextAnchor = { quote: string; prefix: string; suffix: string; startOffset: number };

export function normalizeAnchorText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function locateAnchor(text: string, anchor: TextAnchor): [number, number] | null {
  const quote = normalizeAnchorText(anchor.quote);
  if (!quote) return null;
  const candidates: number[] = [];
  for (let at = text.indexOf(quote); at >= 0; at = text.indexOf(quote, at + 1)) candidates.push(at);
  const contextual = candidates.filter((at) => (!anchor.prefix || text.slice(0, at).endsWith(anchor.prefix)) && (!anchor.suffix || text.slice(at + quote.length).startsWith(anchor.suffix)));
  const at = contextual.length === 1 ? contextual[0] : contextual.includes(anchor.startOffset) ? anchor.startOffset : candidates.length === 1 ? candidates[0] : -1;
  return at < 0 ? null : [at, at + quote.length];
}

type Tree = { type: string; value?: string; tagName?: string; properties?: Record<string, unknown>; children?: Tree[] };
export type MarkAnchor = TextAnchor & { id: string; stale?: boolean };

/** Mark HAST text nodes without flattening headings, lists, links, emphasis or tables. */
export function annotationMarks(notes: MarkAnchor[]) {
  return () => (tree: Tree) => {
    const nodes: { node: Tree; start: number; end: number }[] = [];
    let raw = "";
    const gather = (node: Tree) => {
      if (node.type === "text") {
        const start = raw.length;
        raw += node.value ?? "";
        nodes.push({ node, start, end: raw.length });
      } else node.children?.forEach(gather);
    };
    gather(tree);
    const positions: number[] = [];
    let visible = "";
    for (let index = 0; index < raw.length; index++) {
      if (/\s/.test(raw[index])) {
        if (visible && visible.at(-1) !== " ") { visible += " "; positions.push(index); }
      } else { visible += raw[index]; positions.push(index); }
    }
    if (visible.endsWith(" ")) { visible = visible.slice(0, -1); positions.pop(); }
    const ranges = notes.filter((note) => !note.stale).flatMap((note) => {
      const match = locateAnchor(visible, note);
      return match ? [{ id: note.id, start: positions[match[0]], end: positions[match[1] - 1] + 1 }] : [];
    });
    const spans = new Map<Tree, Tree[]>();
    for (const { node, start, end } of nodes) {
      const relevant = ranges.filter((range) => range.start < end && range.end > start);
      if (!relevant.length) continue;
      const cuts = [...new Set([start, end, ...relevant.flatMap((range) => [Math.max(start, range.start), Math.min(end, range.end)])])].sort((a, b) => a - b);
      const replacement: Tree[] = [];
      for (let i = 0; i < cuts.length - 1; i++) {
        const a = cuts[i], b = cuts[i + 1];
        const covered = relevant.filter((range) => range.start <= a && range.end >= b);
        const text: Tree = { type: "text", value: (node.value ?? "").slice(a - start, b - start) };
        replacement.push(covered.length ? { type: "element", tagName: "mark", properties: { dataAnnotationIds: covered.map((range) => range.id).join(" ") }, children: [text] } : text);
        for (const range of relevant.filter((range) => range.end === b)) replacement.push({ type: "element", tagName: "span", properties: { dataAnnotationBubble: range.id }, children: [] });
      }
      spans.set(node, replacement);
    }
    const replace = (parent: Tree) => {
      parent.children = parent.children?.flatMap((node) => {
        if (spans.has(node)) return spans.get(node)!;
        replace(node); return [node];
      });
    };
    replace(tree);
  };
}
