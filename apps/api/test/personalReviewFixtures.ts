import type { TMonthlyReviewSelfReview } from "@warmap/contracts";
import type { PersonalReviewDraftInput } from "../src/personalReviews.js";

/** 输入里的全部记录（与 personalReviewGeneration.allowedCitations 同一范围）。 */
export const recordsOf = (input: PersonalReviewDraftInput) => [...input.missions, ...input.weeklyReviews.flatMap((week) => week.entries),
  ...input.collectorRecords, ...input.attachments, ...input.messages, ...input.importedMaterials];

/** 假 Co-Agent 的合格草稿：每行挂输入里第一条记录的出处，缺了哪类记录就写一行「缺少记录」；sources 与服务端生成的一致。 */
export function citedReview(input: PersonalReviewDraftInput, prefix = "按证据完成承诺"): TMonthlyReviewSelfReview {
  const first = recordsOf(input)[0];
  const link = first ? `[${first.label}](${first.cite})` : "";
  const sources = first ? [first.cite.replace(/^cite:/, "")] : [];
  const line = (text: string) => first ? `${text}${link}。` : "缺少记录：这个月没有任何记录。";
  const missing = input.missingRecords.length && first ? `\n缺少记录：这个月没有${input.missingRecords.join("、")}。` : "";
  return {
    overall: { text: `${line(prefix)}${missing}`, sources },
    judgments: { text: line("交付节奏落后"), sources },
    nextFocus: { text: line("下周期补齐验收"), sources },
    escalations: { text: "无", sources: [] },
  };
}
