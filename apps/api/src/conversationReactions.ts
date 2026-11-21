import { MESSAGE_REACTION_MAX, type TConversationReaction } from "@warmap/contracts";
import type { Query } from "./meetingStore.js";

/** 本人在一条消息的一块上挂的表情：每块一个，换掉这一块原来的；null 删掉这一块的。只动本人的，伙伴点的不动。 */
export async function saveReaction(q: Query, personId: string, scope: string, reaction: TConversationReaction): Promise<TConversationReaction> {
  const key = [personId, scope, reaction.runId, reaction.role, reaction.part];
  if (reaction.emoji) {
    await q(`INSERT INTO conversation_reactions (person_id, scope, run_id, role, part, emojis, reactor) VALUES ($1, $2, $3, $4, $5, ARRAY[$6::text], 'person')
      ON CONFLICT (person_id, scope, run_id, role, reactor, part) DO UPDATE SET emojis = EXCLUDED.emojis`, [...key, reaction.emoji]);
  } else {
    await q("DELETE FROM conversation_reactions WHERE person_id = $1 AND scope = $2 AND run_id = $3 AND role = $4 AND part = $5 AND reactor = 'person'", key);
  }
  return { runId: reaction.runId, role: reaction.role, part: reaction.part, emoji: reaction.emoji };
}

/** 伙伴在一条消息上点一个表情（记在第 0 块：伙伴只点本人的话，它只有一块）：并进伙伴那一行（同一个只算一个、满了不再加），回整组。 */
export async function addBuddyReaction(q: Query, input: { personId: string; scope: string; runId: string; role: "user" | "assistant"; emoji: string }): Promise<string[]> {
  const row = (await q(`INSERT INTO conversation_reactions (person_id, scope, run_id, role, part, emojis, reactor) VALUES ($1, $2, $3, $4, 0, ARRAY[$5::text], 'buddy')
    ON CONFLICT (person_id, scope, run_id, role, reactor, part) DO UPDATE SET emojis = CASE
      WHEN $5::text = ANY(conversation_reactions.emojis) OR cardinality(conversation_reactions.emojis) >= $6::int THEN conversation_reactions.emojis
      ELSE conversation_reactions.emojis || $5::text END
    RETURNING emojis`, [input.personId, input.scope, input.runId, input.role, input.emoji, MESSAGE_REACTION_MAX])).rows[0];
  return row.emojis as string[];
}

/** 读历史时把这段对话里的表情接到对应那条消息上（一次查询）：本人的按块放 reactions（-1 原样给），伙伴的放 buddyReactions。 */
export async function withReactions<H extends { messages: { runId: string; role: string }[] }>(q: Query, personId: string, scope: string, history: H): Promise<H> {
  const rows = (await q("SELECT run_id, role, part, emojis, reactor FROM conversation_reactions WHERE person_id = $1 AND scope = $2 ORDER BY part",
    [personId, scope])).rows as { run_id: string; role: string; part: number; emojis: string[]; reactor: string }[];
  if (!rows.length) return history;
  const mine = new Map<string, { part: number; emoji: string }[]>();
  const buddy = new Map<string, string[]>();
  for (const row of rows) {
    const key = `${row.role}:${row.run_id}`;
    if (row.reactor === "buddy") buddy.set(key, row.emojis);
    else mine.set(key, [...(mine.get(key) ?? []), { part: row.part, emoji: row.emojis[0] }]);
  }
  return {
    ...history,
    messages: history.messages.map((message) => {
      const reactions = mine.get(`${message.role}:${message.runId}`);
      const buddyReactions = buddy.get(`${message.role}:${message.runId}`);
      return reactions || buddyReactions ? { ...message, ...(reactions ? { reactions } : {}), ...(buddyReactions ? { buddyReactions } : {}) } : message;
    }),
  };
}
