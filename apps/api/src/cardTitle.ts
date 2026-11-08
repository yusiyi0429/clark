/**
 * 卡标题的规矩（草稿卡、规划员的派活单；左栏要显示全）：照 Claude Code 给会话起名，一个短的动宾短语，细节都放进交代和完成标准。
 * 云端的拆卡作业（cardPlanAgent.ts）照它校验，不合格让模型重写标题，不硬截断；本机规划员的交代（cardSplits.ts）里写着同一段。
 */
export const CARD_TITLE_RULE = "标题是一个短的动宾短语，中文 12 个字以内（英文 6 个词以内），像给会话起的名字：不带括号、冒号、句号，不重复项目名；"
  + "细节都写进交代和完成标准，不放进标题。例如「本机按岗位拉起会话」「云端汇总本机上报」「派活单网页」「并行卡独立工作区」「排期文档修改建议」";

/** 中文、全角字符算 2，其余算 1：32 约是 16 个汉字或 6 个英文词，比规矩里的 12 个字留一点余地。 */
const WIDE = /[⺀-鿿가-힯豈-﫿︰-﹏＀-￯]/u;
export const CARD_TITLE_MAX_WIDTH = 32;

/** 标题不合规矩时说明怎么改（交给模型重写）；合规为 null。 */
export function cardTitleProblem(title: string): string | null {
  const text = title.trim();
  const width = [...text].reduce((sum, char) => sum + (WIDE.test(char) ? 2 : 1), 0);
  if (width > CARD_TITLE_MAX_WIDTH) return `标题「${text}」太长，重写成 12 个字以内的动宾短语，细节放进交代和完成标准`;
  if (/[()（）【】[\]{}:：。]|\.$/u.test(text)) return `标题「${text}」不要带括号、冒号、句号，重写成一个短的动宾短语`;
  return null;
}
