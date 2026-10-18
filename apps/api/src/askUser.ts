import { defineTool } from "@earendil-works/pi-coding-agent";
import { AskUserInput, type TAskAnswerInput, type TAskAnswerRecord, type TAskUserInput, type TConversationCard } from "@warmap/contracts";

/**
 * Agent 向本人提问（10/18 定，10/30 第二版）：对话里 Agent 要收集本人的回答时调 ask_user，一次 1–4 题、每题 2–4 个选项，
 * 可以标推荐。提问卡挂在这一轮回答后面（随运行记录存下，同其他对话卡），这一轮就停；
 * 本人在弹窗里一题一页作答，答案作为本人的下一条消息发回来（routes/conversations.ts 按提问卡核对、重写原文、存下问答记录）。
 */
export type QuestionsCard = Extract<TConversationCard, { kind: "questions" }>;
export type AskUser = (questions: TAskUserInput["questions"]) => QuestionsCard;

export const ASK_USER_RULES = `# 向本人提问

缺少只有本人才能定的信息（取舍、偏好、范围、口径），而且它会明显改变回答时，用 ask_user 提问，不在正文里用文字列问题，也不用回答末尾的选项块代替。能查到的先查，不问；按最可能的理解作答、写明假设就够的，不问。要问的一次问完（最多 4 题），每题 2–4 个具体选项，最可能的那个标 recommended；界面另给「其他」自己写和跳过，选项里不写「其他」。ask_user 单独调用，不和别的工具放在同一步；调用前最多写一句为什么要问，调用后这一轮结束。本人的回答会作为下一条消息发回来，按回答接着做；跳过的题按最稳妥的理解处理，并在回答里说明。`;

/** 个人复盘页的提交前核对（复盘确认环节）：用同一个提问工具。 */
export const PERSONAL_REVIEW_CHECK_RULES = `# 个人复盘提交前核对

currentObject 是本人这个月的个人复盘。本人要在提交前核对时，对照本月 Mission 和 selfReview，找出需要本人拿主意的地方（某条算不算达成、偏差原因、计划外的事怎么写、下个月还做不做），用 ask_user 一次问完；没有要问的就直接说可以提交。收到回答后，逐栏写出要改的那一栏和改后的整段，由本人在复盘里改。`;

/** 题目整理：选项去掉首尾空白；推荐只认第一个。同一题里选项重复时交还给模型重写。 */
function normalized(questions: TAskUserInput["questions"]): TAskUserInput["questions"] {
  return questions.map((item) => {
    let recommended = false;
    const options = item.options.map(({ label, detail, recommended: marked }) => {
      const keep = Boolean(marked) && !recommended;
      if (keep) recommended = true;
      return { label: label.trim(), ...(detail?.trim() ? { detail: detail.trim() } : {}), ...(keep ? { recommended: true } : {}) };
    });
    if (new Set(options.map((option) => option.label)).size !== options.length) throw new Error(`「${item.question}」的选项有重复，请改成彼此不同的选项再问。`);
    return { question: item.question.trim(), options };
  });
}

/** ask_user：登记提问卡后让这一轮停下（pi 的 terminate）；一轮只问一次。asked() 给运行时判断这一轮停在提问上。 */
export function makeAskTool(ask: AskUser) {
  let asked = false;
  const tool = defineTool({
    name: "ask_user",
    label: "向本人提问",
    description: "向本人提问，收集只有本人能定的信息：一次 1–4 题，每题 2–4 个具体选项，最可能的那个 recommended=true。界面一题一页作答，另给「其他」和跳过。调用后这一轮结束，本人的回答作为下一条消息发回来。",
    parameters: AskUserInput,
    execute: async (_id, args) => {
      if (asked) throw new Error("这一轮已经提过问了，等本人回答。");
      const card = ask(normalized(args.questions));
      asked = true;
      return {
        content: [{ type: "text" as const, text: `已把 ${card.questions.length} 个问题交给本人作答。这一轮到此结束，不再写正文；本人的回答会作为下一条消息发回来。` }],
        details: { askId: card.askId },
        terminate: true,
      };
    },
  });
  return { tool, asked: () => asked };
}

type Query = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;

/** 这条对话里的提问卡（随回答存在运行记录里）与它是否已经回答过。 */
export async function loadAsk(q: Query, conversationId: string, askId: string): Promise<{ card: QuestionsCard; answered: boolean } | null> {
  const found = await q(
    `SELECT r.input_snapshot -> 'cards' AS cards FROM conversation_messages m JOIN agent_runs r ON r.id = m.run_id
      WHERE m.conversation_id = $1 AND m.role = 'assistant' AND r.input_snapshot -> 'cards' @> $2::jsonb LIMIT 1`,
    [conversationId, JSON.stringify([{ kind: "questions", askId }])]);
  const card = ((found.rows[0] as { cards?: TConversationCard[] } | undefined)?.cards ?? [])
    .find((item): item is QuestionsCard => item.kind === "questions" && item.askId === askId);
  if (!card) return null;
  const answered = await q("SELECT 1 FROM conversation_messages WHERE conversation_id = $1 AND role = 'user' AND meta -> 'answers' ->> 'askId' = $2 LIMIT 1",
    [conversationId, askId]);
  return { card, answered: answered.rows.length > 0 };
}

/**
 * 按提问卡核对本人的作答，生成问答记录（存在作答消息上）和交给 Agent 的原文。
 * 每题选一个选项或自己写一句；两样都没有的算跳过。题号不在卡上、重复、选项下标越界、同时选了又写了，都退回。
 */
export function readAnswers(card: QuestionsCard, input: TAskAnswerInput): { record: TAskAnswerRecord; text: string } | { error: string } {
  const given = new Map<string, TAskAnswerInput["items"][number]>();
  for (const item of input.items) {
    if (given.has(item.questionId) || !card.questions.some((question) => question.id === item.questionId)) return { error: "回答和提问对不上" };
    if (item.option !== undefined && item.text !== undefined) return { error: "一题只能选一个，或者自己写" };
    given.set(item.questionId, item);
  }
  const items: TAskAnswerRecord["items"] = [];
  for (const question of card.questions) {
    const item = given.get(question.id);
    const base = { questionId: question.id, question: question.question };
    if (item?.option !== undefined) {
      const option = question.options[item.option];
      if (!option) return { error: "回答和提问对不上" };
      items.push({ ...base, kind: "option", answer: option.label, ...(option.recommended ? { recommended: true } : {}) });
    } else if (item?.text?.trim()) {
      items.push({ ...base, kind: "other", answer: item.text.trim() });
    } else {
      items.push({ ...base, kind: "skipped" });
    }
  }
  const lines = items.map((item, index) => `${index + 1}. ${item.question}\n答：${item.kind === "skipped" ? "跳过"
    : `${item.answer}${item.recommended ? "（采纳推荐）" : item.kind === "other" ? "（自己写的）" : ""}`}`);
  return { record: { askId: card.askId, items }, text: `（回答你上一轮的提问）\n${lines.join("\n")}` };
}
