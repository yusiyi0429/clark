import type { Query } from "./meetingStore.js";

export async function listSeenMarks(q: Query, personId: string): Promise<string[]> {
  const result = await q("SELECT key FROM person_seen_marks WHERE person_id = $1 ORDER BY seen_at, key", [personId]);
  return result.rows.map((row) => row.key as string);
}

export async function markSeen(q: Query, personId: string, key: string, now: Date): Promise<void> {
  await q(
    "INSERT INTO person_seen_marks (person_id, key, seen_at) VALUES ($1, $2, $3) ON CONFLICT (person_id, key) DO NOTHING",
    [personId, key, now],
  );
}

export async function clearSeenMark(q: Query, personId: string, key: string): Promise<void> {
  await q("DELETE FROM person_seen_marks WHERE person_id = $1 AND key = $2", [personId, key]);
}
