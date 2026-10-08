/** Anchors refer to rendered text, so Markdown punctuation never enters the selection. */
export type TextAnchor = { quote: string; prefix: string; suffix: string; startOffset: number };

export function normalizeAnchorText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Chrome's paragraph selection may end at offset 0 of the next element. */
export function fieldSelectionRange(node: HTMLElement, selection: Selection | null): Range | null {
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null;
  const picked = selection.getRangeAt(0);
  if (!node.contains(picked.startContainer) && !node.contains(picked.endContainer)) return null;
  const bounds = document.createRange(); bounds.selectNodeContents(node);
  const range = picked.cloneRange();
  if (range.compareBoundaryPoints(Range.START_TO_START, bounds) < 0) range.setStart(bounds.startContainer, bounds.startOffset);
  if (range.compareBoundaryPoints(Range.END_TO_END, bounds) > 0) range.setEnd(bounds.endContainer, bounds.endOffset);
  const quote = normalizeAnchorText(range.toString());
  return quote && quote === normalizeAnchorText(picked.toString()) ? range : null;
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

/** A revision records the whole field; show its smallest changed passage. */
export function revisionAnchor(before: string, after: string): TextAnchor | null {
  const oldText = normalizeAnchorText(before), nextText = normalizeAnchorText(after);
  if (!nextText || oldText === nextText) return null;
  let start = 0, end = nextText.length, oldEnd = oldText.length;
  while (start < Math.min(oldText.length, nextText.length) && oldText[start] === nextText[start]) start++;
  while (end > start && oldEnd > start && nextText[end - 1] === oldText[oldEnd - 1]) { end--; oldEnd--; }
  // Deletions leave a small adjacent anchor instead of bringing old text back.
  if (start === end) { start = Math.max(0, start - 1); end = Math.min(nextText.length, end + 1); }
  return { quote: nextText.slice(start, end), prefix: nextText.slice(Math.max(0, start - 200), start), suffix: nextText.slice(end, end + 200), startOffset: start };
}

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
      if (!match) return [];
      let sentenceStart = match[0], sentenceEnd = match[1];
      while (sentenceStart > 0 && !/[。！？.!?\n]/.test(visible[sentenceStart - 1])) sentenceStart--;
      while (sentenceEnd < visible.length && !/[。！？.!?\n]/.test(visible[sentenceEnd])) sentenceEnd++;
      return [{ id: note.id, start: positions[match[0]], end: positions[match[1] - 1] + 1, sentenceStart, sentenceEnd }];
    }).sort((left, right) => left.start - right.start);
    // One icon per sentence, including overlapping selections and revision links.
    const groups: { ids: string[]; start: number; end: number; sentenceStart: number; sentenceEnd: number }[] = [];
    for (const range of ranges) {
      const group = groups.find((group) => range.start <= group.end || (range.sentenceStart === group.sentenceStart && range.sentenceEnd === group.sentenceEnd));
      if (group) { group.ids.push(...range.id.split(" ")); group.end = Math.max(group.end, range.end); }
      else groups.push({ ...range, ids: range.id.split(" ") });
    }
    const attached = new Set(ranges.flatMap((range) => range.id.split(" ")));
    const unmatched = [...new Set(notes.flatMap((note) => note.id.split(" ")).filter((id) => !attached.has(id)))];
    const spans = new Map<Tree, Tree[]>();
    for (const { node, start, end } of nodes) {
      const relevant = groups.filter((range) => range.start < end && range.end > start);
      if (!relevant.length) continue;
      const cuts = [...new Set([start, end, ...relevant.flatMap((range) => [Math.max(start, range.start), Math.min(end, range.end)])])].sort((a, b) => a - b);
      const replacement: Tree[] = [];
      for (let i = 0; i < cuts.length - 1; i++) {
        const a = cuts[i], b = cuts[i + 1];
        const covered = relevant.filter((range) => range.start <= a && range.end >= b);
        const text: Tree = { type: "text", value: (node.value ?? "").slice(a - start, b - start) };
        replacement.push(covered.length ? { type: "element", tagName: "mark", properties: { dataAnnotationIds: covered.flatMap((range) => range.ids).join(" ") }, children: [text] } : text);
        for (const range of relevant.filter((range) => range.end === b)) replacement.push({ type: "element", tagName: "span", properties: { dataAnnotationBubble: [...new Set(range.ids)].join(" ") }, children: [] });
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
    if (unmatched.length) {
      const tail = tree.children?.at(-1);
      const bubble: Tree = { type: "element", tagName: "span", properties: { dataAnnotationBubble: unmatched.join(" ") }, children: [] };
      if (tail?.tagName === "p") tail.children?.push(bubble);
      else tree.children?.push({ type: "element", tagName: "p", properties: { dataAnnotationFallback: true }, children: [bubble] });
    }
  };
}
