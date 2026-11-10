/**
 * 蓝点「点了就藏」（17.2 第 25 条，11/09 补）：打开子会话或项目对话的那一刻，在页面状态里记成「刚看过」，左栏马上不画它的蓝点，work-seen 在后台发。
 * 记的时候带上那一刻的停下时间（子会话 updatedAt、项目 lastActivityAt）：之后云端又说 unseen、而且时间比记下的新，蓝点照常出现，不把以后真有的新提醒藏掉。
 * 只存在这一页的内存里，刷新以后以云端的 unseen 为准。黄点、灰点不看它。
 */
export type SeenKind = "sub" | "project";
export type SeenMarks = ReadonlyMap<string, string>;

export const seenKey = (kind: SeenKind, id: string) => `${kind}:${id}`;

/** 记一个「刚看过」：marker 是那一刻的停下时间（没有记空串，之后任何有时间的新停下都算更新的）。 */
export const withSeen = (marks: SeenMarks, kind: SeenKind, id: string, marker: string | null): Map<string, string> =>
  new Map(marks).set(seenKey(kind, id), marker ?? "");

/** 云端说 unseen，且不是刚看过的那一次（没记过、或这次的停下时间比记下的新）才画蓝点。 */
export function showUnseen(unseen: boolean, marks: SeenMarks | undefined, kind: SeenKind, id: string, marker: string | null): boolean {
  if (!unseen) return false;
  const at = marks?.get(seenKey(kind, id));
  return at === undefined || (!!marker && marker > at);
}
