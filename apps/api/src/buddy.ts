import type { TBuddy } from "@warmap/contracts";
import type { Query } from "./meetingStore.js";

/** 本人的伙伴：没选过就是 null（页面守卫据此先请本人选伙伴）。 */
export async function readBuddy(q: Query, personId: string): Promise<TBuddy | null> {
  const row = (await q("SELECT name, form FROM person_buddies WHERE person_id = $1", [personId])).rows[0] as TBuddy | undefined;
  return row ? { name: row.name, form: row.form } : null;
}

/** 名字去掉首尾空白再存；空白名字由调用方先挡掉。 */
export async function saveBuddy(q: Query, personId: string, input: TBuddy): Promise<TBuddy> {
  const buddy = { name: input.name.trim(), form: input.form };
  await q(`INSERT INTO person_buddies (person_id, name, form) VALUES ($1, $2, $3)
    ON CONFLICT (person_id) DO UPDATE SET name = EXCLUDED.name, form = EXCLUDED.form, updated_at = now()`, [personId, buddy.name, buddy.form]);
  return buddy;
}
