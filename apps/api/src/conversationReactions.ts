import type { TConversationReaction } from "@warmap/contracts";
import type { Query } from "./meetingStore.js";

/** 本人挂的表情（同一个只算一个）：整组替换，空的就删掉这一行。 */
export async function saveReaction(q: Query, personId: string, scope: string, reaction: TConversationReaction): Promise<TConversationReaction> {
  const emojis = [...new Set(reaction.emojis)];
  if (emojis.length) {
    await q(`INSERT INTO conversation_reactions (person_id, scope, run_id, role, emojis) VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (person_id, scope, run_id, role) DO UPDATE SET emojis = EXCLUDED.emojis`,
    [personId, scope, reaction.runId, reaction.role, emojis]);
  } else {
    await q("DELETE FROM conversation_reactions WHERE person_id = $1 AND scope = $2 AND run_id = $3 AND role = $4",
      [personId, scope, reaction.runId, reaction.role]);
  }
  return { runId: reaction.runId, role: reaction.role, emojis };
}

/** 读历史时把本人在这段对话里挂的表情接到对应那条消息上（一次查询）。 */
export async function withReactions<H extends { messages: { runId: string; role: string }[] }>(q: Query, personId: string, scope: string, history: H): Promise<H> {
  const rows = (await q("SELECT run_id, role, emojis FROM conversation_reactions WHERE person_id = $1 AND scope = $2", [personId, scope])).rows;
  if (!rows.length) return history;
  const byMessage = new Map(rows.map((row) => [`${row.role}:${row.run_id}`, row.emojis as string[]]));
  return {
    ...history,
    messages: history.messages.map((message) => {
      const reactions = byMessage.get(`${message.role}:${message.runId}`);
      return reactions ? { ...message, reactions } : message;
    }),
  };
}
