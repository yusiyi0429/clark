import type { TBuddy } from "@warmap/contracts";
import type { Query } from "./meetingStore.js";

/** 伙伴名字最多占多宽（单位见 buddyNameUnits）：6 个汉字、12 个窄字母，或混着写；Miles 胶囊按这个上限封顶。 */
export const BUDDY_NAME_UNITS = 12;

/**
 * 伙伴名字占多宽（去掉首尾空白后）：小写字母（m、w 除外）、数字、空格和 . , - _ ' 算 1，其余（汉字、全角、大写字母、
 * m、w、别的符号）算 2。按胶囊上 10px 字的实际宽度分的两档：大写 W、M 和 @ 比一个汉字还宽。网页那份（useBuddy）同一条规矩。
 */
export function buddyNameUnits(name: string): number {
  let units = 0;
  for (const char of name.trim()) units += /^[a-ln-vx-z0-9 .,\-_']$/.test(char) ? 1 : 2;
  return units;
}

type StoredBuddy = Required<TBuddy>;

/** 本人的伙伴：没选过就是 null（页面守卫据此先请本人选伙伴）。 */
export async function readBuddy(q: Query, personId: string): Promise<StoredBuddy | null> {
  const row = (await q("SELECT name, form, personality FROM person_buddies WHERE person_id = $1", [personId])).rows[0] as StoredBuddy | undefined;
  return row ? { name: row.name, form: row.form, personality: row.personality } : null;
}

/** 名字去掉首尾空白再存；空白名字由调用方先挡掉。没带性格时沿用原来的，新伙伴是沉稳靠谱（列默认值）。 */
export async function saveBuddy(q: Query, personId: string, input: TBuddy): Promise<StoredBuddy> {
  const row = (await q(`INSERT INTO person_buddies (person_id, name, form, personality) VALUES ($1, $2, $3, COALESCE($4, 'steady'))
    ON CONFLICT (person_id) DO UPDATE SET name = EXCLUDED.name, form = EXCLUDED.form,
      personality = COALESCE($4, person_buddies.personality), updated_at = now()
    RETURNING name, form, personality`, [personId, input.name.trim(), input.form, input.personality ?? null])).rows[0] as StoredBuddy;
  return { name: row.name, form: row.form, personality: row.personality };
}
