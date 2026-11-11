import type { FileChange } from "./fileChanges";

/** 测试用：在改前那份里把第 n 个 find 换成 replace，造出改后那份和逐处的位置（本机切好的样子）。 */
export function edited(before: string, edits: [find: string, replace: string, nth?: number][]): { before: string; after: string; changes: FileChange[] } {
  const spots = edits.map(([find, replace, nth = 0], index) => {
    let at = -1;
    for (let n = 0; n <= nth; n += 1) at = before.indexOf(find, at + 1);
    if (at < 0) throw new Error(`没找到 ${find}`);
    return { id: `c${index + 1}`, start: at, end: at + find.length, replace };
  }).sort((x, y) => x.start - y.start);
  let after = "";
  let cursor = 0;
  const changes: FileChange[] = [];
  for (const spot of spots) {
    after += before.slice(cursor, spot.start);
    const from = after.length;
    after += spot.replace;
    changes.push({ id: spot.id, before: { start: spot.start, end: spot.end }, after: { start: from, end: after.length } });
    cursor = spot.end;
  }
  after += before.slice(cursor);
  return { before, after, changes };
}
