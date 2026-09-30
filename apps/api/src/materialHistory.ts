import type { TMaterialBlockHistoryEntry, TMaterialRemovedView, TMaterialRevisionView } from "@warmap/contracts";
import { diffHtmlMaterialLines, diffMaterialBlocks, splitHtmlMaterialLines, splitMaterialBlocks } from "./materialDiff.js";

export type MaterialHistoryRevision = TMaterialRevisionView & { body: string };
export type RemovedBlock = TMaterialRemovedView & { previous: string | null; index: number };

/** Carry block identity through each adjacent diff, including unchanged blocks between edits. */
export function materialHistory(revisions: MaterialHistoryRevision[], format: "markdown" | "html") {
  const split = format === "html" ? splitHtmlMaterialLines : splitMaterialBlocks;
  const diff = format === "html" ? diffHtmlMaterialLines : diffMaterialBlocks;
  let histories: TMaterialBlockHistoryEntry[][] = [];
  let removed: RemovedBlock[] = [];
  for (let i = 0; i < revisions.length; i++) {
    const current = revisions[i];
    const texts = split(current.body);
    if (!i) { histories = texts.map(() => []); continue; }
    const before = split(revisions[i - 1].body);
    const next: TMaterialBlockHistoryEntry[][] = [];
    let oldIndex = 0;
    for (const block of diff(revisions[i - 1].body, current.body)) {
      const change = block.change;
      const metadata = { version: current.version, requestedBy: current.requestedBy, at: current.at, annotation: current.annotation };
      if (change?.kind === "removed") {
        if (format === "markdown" || change.before.replace(/<[^>]*>/g, "").trim())
          removed.push({ ...metadata, id: `v${current.version}-${oldIndex}`, text: change.before, restorable: true,
            previous: before[oldIndex - 1] ?? null, index: oldIndex });
        oldIndex++;
      } else {
        const history = change?.kind === "added" ? [] : histories[oldIndex++] ?? [];
        next.push(format === "html" ? [] : change ? [{ ...metadata, kind: change.kind,
          before: change.kind === "modified" ? change.before : "" }, ...history].slice(0, 5) : history);
      }
    }
    // A later exact reappearance retires that deletion, even if the block is deleted again later.
    const present = new Set(texts);
    removed = removed.filter((item) => !present.has(item.text));
    histories = next;
  }
  return { histories, removed: removed.reverse() };
}

/** Find block offsets without rebuilding the document, preserving surrounding Markdown/HTML source. */
export function restoreMaterialBlock(body: string, removed: RemovedBlock, format: "markdown" | "html"): string {
  const normalized = body.replace(/\r\n/g, "\n");
  const blocks = (format === "html" ? splitHtmlMaterialLines : splitMaterialBlocks)(normalized);
  let cursor = 0;
  const offsets = blocks.map((text) => {
    const start = normalized.indexOf(text, cursor);
    cursor = start + text.length;
    return { start, end: cursor };
  });
  const previous = removed.previous === null ? -1 : blocks.indexOf(removed.previous);
  const separator = format === "html" ? "\n" : "\n\n";
  if (previous >= 0) {
    const position = offsets[previous].end;
    return normalized.slice(0, position) + separator + removed.text + normalized.slice(position);
  }
  const position = offsets[Math.min(removed.index, blocks.length)]?.start;
  if (position !== undefined) return normalized.slice(0, position) + removed.text + separator + normalized.slice(position);
  if (format === "html") {
    const closing = /<\/body\s*>/i.exec(normalized);
    if (closing) return normalized.slice(0, closing.index) + removed.text + "\n" + normalized.slice(closing.index);
  }
  return normalized + (normalized ? separator : "") + removed.text;
}
