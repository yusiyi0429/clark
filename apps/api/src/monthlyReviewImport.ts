import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Type, type Static } from "@sinclair/typebox";
import { MonthlyPlanPeriod, MonthlyReviewSelfReview, type TMonthlyPlanBattlefield, type TMonthlyPlanCapability, type TMonthlyReviewItemStatus,
  type TMonthlyReviewSelfReview } from "@warmap/contracts";
import type { DirectoryPerson as MemoryPerson } from "./peopleDirectory.js";
import type { Query } from "./meetingStore.js";
import { createMonthlyReviewInTransaction } from "./monthlyReviews.js";
import { startUnitReviewsIfComplete, type PersonalReviewRow } from "./personalReviews.js";

const Text = Type.String({ minLength: 1 });

/** 飞书导出的月度复盘（seed/imports/reviews-YYYY-MM.json）：个人复盘四栏用复盘契约校验。 */
export const ReviewImportFile = Type.Object({
  period: MonthlyPlanPeriod,
  exportedAt: Text,
  source: Text,
  mappingRule: Text,
  personalReviews: Type.Array(Type.Object(
    { personId: Text, sourceRef: Text, sourceTitle: Text, selfReview: MonthlyReviewSelfReview },
    { additionalProperties: false },
  )),
  /** 没有月度复盘的人：周复盘与任务卡原文，交给 Co-Agent 起草。 */
  draftFromMaterials: Type.Array(Type.Object({
    personId: Text,
    materials: Type.Array(Type.Object({ title: Text, sourceRef: Text, markdown: Text }, { additionalProperties: false }), { minItems: 1 }),
  }, { additionalProperties: false })),
  /** 能力域复盘直接取这个人的个人复盘四栏。 */
  capabilityReviews: Type.Array(Type.Object({ capabilityCode: Text, fromPersonId: Text }, { additionalProperties: false })),
}, { additionalProperties: false });
export type TReviewImportFile = Static<typeof ReviewImportFile>;

export type ReviewImportRow = { 对象: string; 名称: string; 结果: string };

const ITEM_STATE: Record<TMonthlyReviewItemStatus, string> = {
  waiting: "等个人复盘交齐后起草", drafting: "Co-Agent 起草中", draft_failed: "起草失败，可重试",
  draft: "负责人修改中", returned: "负责人修改中", submitted: "已提交，跳过", confirmed: "已确认，跳过",
};
const NO_RUN = JSON.stringify({ runId: null, error: null });

/**
 * 把飞书导出的月度复盘写进天枢；调用方持有事务，有 problems 时整批回滚。
 * 只写状态、不调模型：按材料起草的个人复盘停在 drafting，交齐后复盘项进入 drafting，由运行中的 API 服务接手起草。
 * 可重复运行：已导入的，以及本人或 CEO 已经处理过的都跳过。
 */
export async function importMonthlyReviews(q: Query, file: TReviewImportFile, people: MemoryPerson[], cycleStart: Date, now: Date):
  Promise<{ report: ReviewImportRow[]; problems: string[] }> {
  const names = new Map(people.map((person) => [person.personId, person.displayName]));
  const name = (personId: string) => names.get(personId) ?? personId;
  const { period } = file;
  const report: ReviewImportRow[] = [];
  const problems: string[] = [];
  if (!(await q("SELECT 1 FROM missions WHERE period = $1 LIMIT 1", [period])).rowCount) {
    return { report, problems: [`${period} 还没有 Mission：先运行 missions:import`] };
  }
  const listed = [...file.personalReviews, ...file.draftFromMaterials].map((entry) => entry.personId);
  if (new Set(listed).size !== listed.length) problems.push("个人复盘与按材料起草的名单里有人重复");
  for (const personId of new Set(listed)) {
    if (!names.has(personId)) problems.push(`${personId}：不在人员名单（COMPANY_PEOPLE_SEED）`);
    else if (!(await q("SELECT 1 FROM missions WHERE period = $1 AND owner_id = $2 LIMIT 1", [period, personId])).rowCount) {
      problems.push(`${name(personId)}：没有 ${period} 的 Mission，先运行 missions:import`);
    }
  }
  const capabilityByCode = new Map((await q("SELECT id, code FROM capability_config")).rows.map((row) => [row.code as string, row.id as string]));
  const capabilityTexts = new Map<string, TMonthlyReviewSelfReview>();
  for (const entry of file.capabilityReviews) {
    const id = capabilityByCode.get(entry.capabilityCode);
    const source = file.personalReviews.find((review) => review.personId === entry.fromPersonId);
    if (!id) problems.push(`能力域 ${entry.capabilityCode}：不在注册表`);
    else if (!source) problems.push(`能力域 ${entry.capabilityCode}：${name(entry.fromPersonId)} 不在个人复盘名单里`);
    else capabilityTexts.set(id, source.selfReview);
  }
  if (problems.length) return { report, problems };

  const creation = await createMonthlyReviewInTransaction(q, period, now, people);
  const review = (await q("SELECT id, status, origin FROM monthly_reviews WHERE id = $1 FOR UPDATE", [creation.reviewId])).rows[0] as
    { id: string; status: string; origin: "import" | null };
  const firstImport = review.origin !== "import";
  if (firstImport && review.status !== "collecting") return { report, problems: [`${period} 复盘已经过了收集阶段（${review.status}），不能导入`] };
  await q("UPDATE monthly_reviews SET origin = 'import', cycle_started_at = $2, updated_at = $3 WHERE id = $1 AND (origin IS NULL OR cycle_started_at IS DISTINCT FROM $2)",
    [review.id, cycleStart, now]);
  report.push({ 对象: "月度复盘", 名称: `${Number(period.slice(5))} 月`, 结果: creation.created ? "新建，标为导入" : firstImport ? "沿用已开启的复盘，标为导入" : "已导入过" });

  // 已提交、已跳过和本人动过的个人复盘不覆盖；Co-Agent 自动起草、本人没碰过的草稿可以覆盖。
  const personal = async (personId: string) => (await q("SELECT * FROM personal_reviews WHERE monthly_review_id = $1 AND person_id = $2 FOR UPDATE",
    [review.id, personId])).rows[0] as PersonalReviewRow | undefined;
  const handled = (row: PersonalReviewRow) => row.status === "submitted" ? (row.draft_source === "import" ? "已导入，跳过" : "本人已提交，跳过")
    : row.status === "skipped" ? "CEO 已不等，跳过" : row.action_fingerprints.length ? "本人已改过，跳过" : null;
  for (const entry of file.personalReviews) {
    const row = await personal(entry.personId);
    if (!row) { problems.push(`${name(entry.personId)}：没有个人复盘`); continue; }
    const skipped = handled(row);
    if (!skipped) await q(`UPDATE personal_reviews SET status = 'submitted', self_review = $2::jsonb, draft_source = 'import', draft_error = NULL,
      submitted_at = $3, version = version + 1, updated_at = $3 WHERE id = $1`, [row.id, JSON.stringify(entry.selfReview), now]);
    report.push({ 对象: "个人复盘", 名称: name(entry.personId), 结果: skipped ?? "导入为已提交" });
  }
  // 系统触发「按材料起草」：只写 drafting，不记成本人的动作；API 服务接手起草，结果停在 draft 等本人提交。
  for (const entry of file.draftFromMaterials) {
    const row = await personal(entry.personId);
    if (!row) { problems.push(`${name(entry.personId)}：没有个人复盘`); continue; }
    const skipped = handled(row) ?? (isDeepStrictEqual(row.imported_materials, entry.materials) ? "材料已导入，跳过" : null);
    if (!skipped) await q(`UPDATE personal_reviews SET imported_materials = $2::jsonb, status = 'drafting', draft_error = NULL,
      version = version + 1, updated_at = $3 WHERE id = $1`, [row.id, JSON.stringify(entry.materials), now]);
    report.push({ 对象: "个人复盘", 名称: name(entry.personId), 结果: skipped ?? `交给 Co-Agent 按 ${entry.materials.length} 份材料起草` });
  }

  const collecting = review.status === "collecting";
  const plan = (await q("SELECT battlefields, capabilities FROM monthly_plans WHERE period = $1 AND status = 'confirmed'", [period])).rows[0] as
    { battlefields: TMonthlyPlanBattlefield[]; capabilities: TMonthlyPlanCapability[] } | undefined;
  const ceo = people.find((person) => person.roles.includes("ceo"))?.personId;
  // 战场项，以及有当月 Mission 或直接取个人复盘的能力域项
  const subjects = (await q(`SELECT 'battlefield' AS type, id, code, name, owner_id, sort_order FROM battlefield_config
    UNION ALL SELECT 'capability', c.id, c.code, c.name, c.owner_id, c.sort_order FROM capability_config c
      WHERE c.id = ANY($2::text[]) OR EXISTS (SELECT 1 FROM missions m WHERE m.period = $1 AND m.capability_id = c.id)
    ORDER BY type, sort_order, code, id`, [period, [...capabilityTexts.keys()]])).rows as
    { type: "battlefield" | "capability"; id: string; code: string; name: string; owner_id: string }[];
  const existing = new Map((await q("SELECT id, subject_type, subject_id, status FROM monthly_review_items WHERE review_id = $1 FOR UPDATE", [review.id])).rows
    .map((row) => [`${row.subject_type}:${row.subject_id}`, row as { id: string; status: TMonthlyReviewItemStatus }]));
  for (const subject of subjects) {
    const item = existing.get(`${subject.type}:${subject.id}`);
    const text = subject.type === "capability" ? capabilityTexts.get(subject.id) : undefined;
    const reportItem = (result: string) => report.push({ 对象: subject.type === "battlefield" ? "战场复盘" : "能力域复盘", 名称: `${subject.code} ${subject.name}`, 结果: result });
    // 已提交、已确认的不动；重复导入时也不再重置已经在走流程的项。
    if (!collecting || item && (["submitted", "confirmed"].includes(item.status) || !text && !firstImport)) {
      reportItem(item ? ITEM_STATE[item.status] : "复盘已过收集阶段，跳过");
      continue;
    }
    // 直接取个人复盘四栏的能力域：确认来源记为导入，没有确认人。其余项清掉旧草稿，等个人复盘交齐后重新起草。
    const status = text ? "confirmed" : "waiting";
    if (item && (text || item.status !== "waiting")) {
      await q(`UPDATE monthly_review_items SET status = $2, self_review = $3::jsonb, confirmed_at = $4, confirmation_source = $5, draft_run = $6::jsonb,
          suggestions = '[]'::jsonb, return_reason = NULL, assessment = '{"status":"none","runId":null,"result":null,"error":null}'::jsonb,
          version = version + 1, updated_at = $7
        WHERE id = $1`,
      [item.id, status, text ? JSON.stringify(text) : null, text ? now : null, text ? "import" : null, NO_RUN, now]);
    } else if (!item) {
      const owner = subject.owner_id || ceo;
      if (!owner) throw new Error("company-people.v1 没有 CEO，无法为待指派的复盘项指定负责人");
      const target = subject.type === "battlefield" ? plan?.battlefields.find((entry) => entry.battlefieldId === subject.id)?.outcome
        : plan?.capabilities.find((entry) => entry.capabilityId === subject.id)?.outcome;
      await q(`INSERT INTO monthly_review_items (id, review_id, version, subject_type, subject_id, owner_id, owner_unassigned, target, status,
          draft_run, self_review, confirmed_at, confirmation_source, assessment, created_at, updated_at)
        VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11, $12, '{"status":"none","runId":null,"result":null,"error":null}'::jsonb, $13, $13)`,
      [randomUUID(), review.id, subject.type, subject.id, owner, !subject.owner_id, target ?? null, status, NO_RUN,
        text ? JSON.stringify(text) : null, text ? now : null, text ? "import" : null, now]);
    }
    reportItem(text ? "导入并确认" : ITEM_STATE.waiting);
  }
  // 个人复盘已经交齐时（例如剩下的人都被跳过），复盘项在这里进入 drafting，同样由 API 服务接手。
  if (collecting && (await startUnitReviewsIfComplete(q, review.id, now)).some((effect) => effect.type === "draft")) {
    report.push({ 对象: "复盘项", 名称: "—", 结果: "个人复盘已交齐，交给 Co-Agent 起草" });
  }
  return { report, problems };
}
