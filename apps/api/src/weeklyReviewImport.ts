import { randomUUID } from "node:crypto";
import type { TWeeklyReviewBody, TWeeklyReviewField } from "@warmap/contracts";
import type { Query } from "./meetingStore.js";
import { addDays, WEEKLY_REVIEW_FIELDS } from "./weeklyReviews.js";

/**
 * 10 月历史周复盘一次性导入（D-01 的例外 1）：飞书知识库里每人每周一份（个别一份按周追加）的周复盘文档，
 * 按周拆开、按模板五段归位，写成「已提交（导入）」的周复盘。读取在 scripts/import-feishu-weekly-reviews.ts（lark-cli，用户身份只读）。
 * 这里只放纯解析和写库，方便测试。
 */

export type ImportDoc = { title: string; url: string; markdown: string; editedAt: string | null };
export type ImportedWeek = { weekStart: string; body: TWeeklyReviewBody; lines: number };

const YEAR = 2026;
/** 小节标题里的关键词 → 模板五段；先匹配的优先。 */
const SECTION_KEYWORDS: [TWeeklyReviewField, RegExp][] = [
  ["implications", /判断变化|implication|启示|认知变化|经营判断|关键判断/i],
  ["overall", /总体判断|总体|整体判断|本周状态|状态/],
  ["progress", /进展|成果|evidence|完成|产出|交付/i],
  ["issues", /问题|why|风险|卡点|阻塞/i],
  ["actions", /当前处理|下周|下一步|计划|处理|行动/],
];
const DATE_RANGE = /(?:(\d{4})\s*[.\-/年])?\s*(\d{1,2})\s*[.\-/月]\s*(\d{1,2})\s*日?\s*[—–\-~至到]+\s*(?:(\d{4})\s*[.\-/年])?\s*(?:(\d{1,2})\s*[.\-/月]\s*)?(\d{1,2})\s*日?/;
const SINGLE_DATE = /(\d{4})[.\-/年](\d{1,2})[.\-/月](\d{1,2})/;

const iso = (year: number, month: number, day: number) => new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
/** 某天所在周的周一。 */
export const mondayOf = (day: string) => addDays(day, -((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7));

/** 一段文字里的周：日期区间按结束那天归周（国庆这类跨周的区间归到结束那一周），只有单个日期就按那天。 */
export function weekOfText(text: string): string | null {
  const range = DATE_RANGE.exec(text);
  if (range) {
    const startMonth = Number(range[2]);
    const endMonth = range[5] ? Number(range[5]) : startMonth;
    const endDay = Number(range[6]);
    const year = Number(range[4] ?? range[1] ?? YEAR);
    if (endMonth >= 1 && endMonth <= 12 && endDay >= 1 && endDay <= 31) return mondayOf(iso(year, endMonth, endDay));
  }
  const single = SINGLE_DATE.exec(text);
  return single ? mondayOf(iso(Number(single[1]), Number(single[2]), Number(single[3]))) : null;
}

/** 飞书导出的 markdown 规整成一行一段：去掉 <title>、表格转成「标题 + 内容」、去掉引用标签和图片。 */
export function normalizeMarkdown(markdown: string): string {
  return markdown
    .replace(/<title>[\s\S]*?<\/title>/i, "")
    .replace(/<\/?(?:b|strong|em|i|u)>/gi, "")
    .replace(/<cite[^>]*>([\s\S]*?)<\/cite>/gi, "$1")
    .replace(/<tr[^>]*>\s*<t[dh][^>]*>([\s\S]*?)<\/t[dh]>\s*<t[dh][^>]*>([\s\S]*?)<\/t[dh]>\s*<\/tr>/gi,
      (_all, head: string, cell: string) => head.trim() === "项目" && cell.trim() === "结论" ? "\n" : `\n## ${head.trim()}\n${cell.trim()}\n`)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(?:table|thead|tbody|tr|td|th|p|span|div|colgroup|col)[^>]*>/gi, "\n")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\r/g, "");
}

const headingText = (line: string) => {
  const heading = /^#{1,6}\s+(.*)$/.exec(line.trim());
  if (heading) return heading[1].replace(/\*\*/g, "").trim();
  const bold = /^\*\*([^*]+)\*\*\s*$/.exec(line.trim()) ?? /^\*\*([^*]{1,40})\*\*/.exec(line.trim());
  return bold ? bold[1].trim() : null;
};
const fieldOf = (heading: string): TWeeklyReviewField | null => SECTION_KEYWORDS.find(([, pattern]) => pattern.test(heading))?.[0] ?? null;
const cleanLine = (line: string) => line.replace(/\*\*/g, "").replace(/^#{1,6}\s+/, "").replace(/^>\s?/, "").trim();
const skipLine = (line: string) => !line || /^[-*_]{3,}$/.test(line) || /^\|?\s*[-:| ]+\|?$/.test(line);

/** 一份文档拆成若干周：标题（或加粗段）里带日期区间的是周的分界；整份没有分界时按正文、再按文档标题定周。 */
export function splitWeeks(doc: ImportDoc): { weekStart: string; text: string }[] {
  const lines = normalizeMarkdown(doc.markdown).split("\n");
  const markers = lines.map((line, index) => ({ index, heading: headingText(line) }))
    .filter((item) => item.heading && DATE_RANGE.test(item.heading) && !fieldOf(item.heading.replace(DATE_RANGE, "")));
  if (markers.length > 1) {
    return markers.map((marker, position) => ({
      weekStart: weekOfText(marker.heading!)!,
      text: lines.slice(marker.index + 1, markers[position + 1]?.index ?? lines.length).join("\n"),
    }));
  }
  const text = lines.join("\n");
  const weekStart = weekOfText(text) ?? weekOfText(doc.title);
  return weekStart ? [{ weekStart, text }] : [];
}

/** 一周的文字按小节归到五段；每行末尾挂飞书原文作出处；空段写「无」。 */
export function sectionsOf(text: string, sourceUrl: string): { body: TWeeklyReviewBody; lines: number } {
  const buckets = Object.fromEntries(WEEKLY_REVIEW_FIELDS.map((field) => [field, [] as string[]])) as Record<TWeeklyReviewField, string[]>;
  let current: TWeeklyReviewField = "overall";
  for (const raw of text.split("\n")) {
    const heading = headingText(raw);
    const field = heading ? fieldOf(heading) : null;
    if (heading && (field || /^#{1,6}\s/.test(raw.trim()))) {
      if (field) current = field;
      // 「**总体判断｜黄｜一句话**」这种把内容写在标题里的，竖线后面的留作正文；「01 ｜ 关键进展」这种编号标题不算。
      const [label, ...restParts] = heading.split(/[｜|:：]/);
      const rest = restParts.join("｜").trim();
      if (rest && fieldOf(label) && !DATE_RANGE.test(rest)) buckets[current].push(rest);
      const after = cleanLine(raw.trim().replace(/^\*\*[^*]+\*\*/, ""));
      if (!/^#/.test(raw.trim()) && after) buckets[current].push(after);
      continue;
    }
    const line = cleanLine(raw);
    if (skipLine(line) || /^(周期|复盘周期|统计周)[:：]/.test(line)) continue;
    buckets[current].push(line);
  }
  const cite = `[飞书原文](${sourceUrl})`;
  let lines = 0;
  const body = Object.fromEntries(WEEKLY_REVIEW_FIELDS.map((field) => {
    const items = buckets[field];
    lines += items.length;
    return [field, { text: items.length ? items.map((line) => `${line}${cite}`).join("\n") : "无", sources: items.length ? [sourceUrl] : [] }];
  })) as TWeeklyReviewBody;
  return { body, lines };
}

/** 10 月的周：周一在 9/28 到 10/26 之间（含跨月的头尾两周）。 */
export const OCTOBER_WEEKS = ["2026-09-28", "2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26"];

export function parseWeeklyReviewDoc(doc: ImportDoc): ImportedWeek[] {
  const weeks = new Map<string, ImportedWeek>();
  for (const chunk of splitWeeks(doc)) {
    if (!OCTOBER_WEEKS.includes(chunk.weekStart)) continue;
    const { body, lines } = sectionsOf(chunk.text, doc.url);
    if (!lines) continue;
    const existing = weeks.get(chunk.weekStart);
    if (!existing || lines > existing.lines) weeks.set(chunk.weekStart, { weekStart: chunk.weekStart, body, lines });
  }
  return [...weeks.values()];
}

/** 写库：已有的周（天枢里生成过或已导入）不动。返回新写入的条数。调用方在事务里调。 */
export async function writeImportedWeeks(q: Query, rows: { personId: string; doc: ImportDoc; week: ImportedWeek }[], now: Date): Promise<number> {
  let written = 0;
  for (const { personId, doc, week } of rows) {
    const inserted = await q(`INSERT INTO weekly_reviews (id, person_id, week_start, status, origin, body, draft_source, import_source, submitted_at, revisions, created_at, updated_at)
      VALUES ($1, $2, $3, 'submitted', 'import', $4::jsonb, 'import', $5::jsonb, $6, $7::jsonb, $8, $8) ON CONFLICT (person_id, week_start) DO NOTHING`,
    [randomUUID(), personId, week.weekStart, JSON.stringify(week.body), JSON.stringify({ title: doc.title, url: doc.url }), doc.editedAt ?? now,
      JSON.stringify([{ at: now.toISOString(), kind: "import", by: null, source: "import", fields: [] }]), now]);
    written += inserted.rowCount ?? 0;
  }
  return written;
}
