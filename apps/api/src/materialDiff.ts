import type { TMaterialBlock, TMaterialChangeSpan } from "@warmap/contracts";

/** Keep Markdown syntax in each block; whitespace between blocks belongs to layout, not the diff. */
export function splitMaterialBlocks(body: string): string[] {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const blocks: string[] = [];
  let pending: string[] = [];
  let fence = false;
  let table = false;
  const flush = () => { if (pending.length) blocks.push(pending.join("\n")); pending = []; table = false; };
  for (const line of lines) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      if (!fence) flush();
      pending.push(line);
      fence = !fence;
      if (!fence) flush();
    } else if (fence) pending.push(line);
    else if (!line.trim()) flush();
    else if (/^\s*\|.*\|\s*$/.test(line)) {
      if (!table) flush();
      table = true;
      pending.push(line);
    } else if (/^\s{0,3}#{1,6}\s/.test(line)) {
      flush(); blocks.push(line);
    } else if (/^\s{0,3}(?:[-*+]\s|\d+[.)]\s)/.test(line)) {
      flush(); pending.push(line);
    } else {
      if (table) flush();
      pending.push(line);
    }
  }
  flush();
  return blocks;
}

function lcsPairs<T>(before: T[], after: T[]): [number, number][] {
  const width = after.length + 1;
  const dp = new Uint32Array((before.length + 1) * width);
  for (let i = before.length - 1; i >= 0; i--)
    for (let j = after.length - 1; j >= 0; j--)
      dp[i * width + j] = before[i] === after[j] ? 1 + dp[(i + 1) * width + j + 1]
        : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
  const pairs: [number, number][] = [];
  for (let i = 0, j = 0; i < before.length && j < after.length;) {
    if (before[i] === after[j]) { pairs.push([i++, j++]); }
    else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) i++;
    else j++;
  }
  return pairs;
}

/** Align blocks with Myers O(ND); abandon a completely different middle after 2,000 edits. */
function linePairs(before: string[], after: string[]): [number, number][] {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let oldEnd = before.length, newEnd = after.length;
  while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) { oldEnd--; newEnd--; }
  const pairs: [number, number][] = Array.from({ length: start }, (_, index) => [index, index]);
  const n = oldEnd - start, m = newEnd - start;
  const limit = Math.min(2_000, n + m);
  const offset = limit + 1;
  const furthest = new Int32Array(2 * limit + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= limit; d++) {
    for (let k = -d; k <= d; k += 2) {
      const index = offset + k;
      let x = k === -d || (k !== d && furthest[index - 1] < furthest[index + 1])
        ? furthest[index + 1] : furthest[index - 1] + 1;
      let y = x - k;
      while (x < n && y < m && before[start + x] === after[start + y]) { x++; y++; }
      furthest[index] = x;
      if (x >= n && y >= m) { found = d; break; }
    }
    if (found >= 0) { trace.push(furthest.slice()); break; }
    if (d < limit) trace.push(furthest.slice());
  }
  if (found >= 0) {
    let x = n, y = m;
    const middle: [number, number][] = [];
    for (let d = found; d > 0; d--) {
      const previous = trace[d - 1];
      const k = x - y;
      const previousK = k === -d || (k !== d && previous[offset + k - 1] < previous[offset + k + 1]) ? k + 1 : k - 1;
      const previousX = previous[offset + previousK];
      const previousY = previousX - previousK;
      while (x > previousX && y > previousY) middle.push([start + --x, start + --y]);
      x = previousX; y = previousY;
    }
    while (x > 0 && y > 0) middle.push([start + --x, start + --y]);
    for (let index = middle.length - 1; index >= 0; index--) pairs.push(middle[index]);
  }
  for (let i = 0; i < before.length - oldEnd; i++) pairs.push([oldEnd + i, newEnd + i]);
  return pairs;
}

function changedSpans(before: string, after: string): TMaterialChangeSpan[] {
  if (before.length * after.length > 1_000_000) return [{ text: after, changed: true }];
  const oldChars = Array.from(before);
  const newChars = Array.from(after);
  const pairs = [...lcsPairs(oldChars, newChars), [oldChars.length, newChars.length] as [number, number]];
  const spans: TMaterialChangeSpan[] = [];
  const push = (text: string, changed: boolean) => {
    if (!text) return;
    const last = spans.at(-1);
    if (last?.changed === changed) last.text += text;
    else spans.push({ text, changed });
  };
  let oldPrevious = -1, newPrevious = -1;
  for (const [oldIndex, newIndex] of pairs) {
    const deleted = oldIndex > oldPrevious + 1;
    if (newIndex > newPrevious + 1 || deleted) push(newChars.slice(newPrevious + 1, newIndex).join(""), true);
    if (newIndex < newChars.length) push(newChars[newIndex], deleted);
    else if (deleted && spans.length) spans[spans.length - 1].changed = true;
    oldPrevious = oldIndex;
    newPrevious = newIndex;
  }
  return spans;
}

/** 两块字面上有一半以上相同，才算「改了这一块」；否则是删了一块、另加了一块。 */
function similar(before: string, after: string): boolean {
  // 超长的块不做逐字比较：开头或结尾 20 个字一样就当作同一块改了。
  if (before.length > 500 || after.length > 500) return before.slice(0, 20) === after.slice(0, 20) || before.slice(-20) === after.slice(-20);
  const oldChars = Array.from(before), newChars = Array.from(after);
  return (2 * lcsPairs(oldChars, newChars).length) / (oldChars.length + newChars.length) >= 0.5;
}

function diffBlocks(before: string[], after: string[]): TMaterialBlock[] {
  const matches = [...linePairs(before, after), [before.length, after.length] as [number, number]];
  const blocks: TMaterialBlock[] = [];
  let oldStart = 0, newStart = 0;
  for (const [oldEnd, newEnd] of matches) {
    if ((oldEnd - oldStart) * (newEnd - newStart) > 2_500) {
      for (let i = oldStart; i < oldEnd; i++) blocks.push({ text: "", change: { kind: "removed", before: before[i] } });
      for (let i = newStart; i < newEnd; i++) blocks.push({ text: after[i], change: { kind: "added" } });
      if (oldEnd < before.length) blocks.push({ text: after[newEnd], change: null });
      oldStart = oldEnd + 1;
      newStart = newEnd + 1;
      continue;
    }
    // 同一个空档里按顺序配对：旧块在后面找到相似的新块才算改了，中间跳过的新块是加的，找不到的旧块是删的。
    let next = newStart;
    for (let i = oldStart; i < oldEnd; i++) {
      let match = next;
      while (match < newEnd && !similar(before[i], after[match])) match++;
      if (match === newEnd) { blocks.push({ text: "", change: { kind: "removed", before: before[i] } }); continue; }
      for (; next < match; next++) blocks.push({ text: after[next], change: { kind: "added" } });
      blocks.push({ text: after[match], change: { kind: "modified", before: before[i], spans: changedSpans(before[i], after[match]) } });
      next = match + 1;
    }
    for (; next < newEnd; next++) blocks.push({ text: after[next], change: { kind: "added" } });
    if (oldEnd < before.length) blocks.push({ text: after[newEnd], change: null });
    oldStart = oldEnd + 1;
    newStart = newEnd + 1;
  }
  return blocks;
}

export function diffMaterialBlocks(beforeBody: string, afterBody: string): TMaterialBlock[] {
  return diffBlocks(splitMaterialBlocks(beforeBody), splitMaterialBlocks(afterBody));
}

export function splitHtmlMaterialLines(body: string): string[] {
  return body.replace(/\r\n/g, "\n").split("\n").filter((line) => line.trim().length > 0);
}

export function diffHtmlMaterialLines(beforeBody: string, afterBody: string): TMaterialBlock[] {
  return diffBlocks(splitHtmlMaterialLines(beforeBody), splitHtmlMaterialLines(afterBody));
}
