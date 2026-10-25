import type { Query } from "./meetingStore.js";
import { slugId } from "./slug.js";
import type { WorldClient, WorldHead, WorldObject } from "./worldClient.js";
import { worldDisplayText } from "./worldReader.js";

/**
 * 从本体只读载入某个月的 Mission（设计：.scratch/tianshu-v1/设计_本体只读载入Mission_2026-10-25.md）。
 * 本体是主源：同一个本体对象（scope + 对象 id）在表里只对应一行，重跑按本体最新版本覆盖；只读本体，不写本体。
 * 负责人按实例配置 people（personId → principal）反查，能力域按 capabilities（本体域 id → 能力域编号）对，都按 id 不按名字；
 * 对不上、没负责人的不载入，写进报告。本体里已经没有的行不删，也写进报告，由人决定。
 */
export type WorldMissionReader = Pick<WorldClient, "listObjects" | "getObject" | "config">;

type Component = { id?: string; type?: string; text?: unknown };
type Block = { id: string; components?: Component[]; value?: { components?: Component[] } | null };
type MissionObject = WorldObject & {
  business: WorldObject["business"] & { blocks?: Block[] };
  identity?: { responsible?: { principals?: { principal_id?: string }[] } };
};
type Lifecycle = { status?: string; display_name?: string };

export type LoadedMission = { code: string; title: string; ownerId: string; status: string; version: number; gaps: string[]; action: "insert" | "update" | "same" };
export type SkippedMission = { objectId: string; title: string; reason: string };
export type WorldMissionLoadReport = { scopeId: string; period: string; readAt: string; loaded: LoadedMission[]; skipped: SkippedMission[]; missing: { code: string; title: string }[] };

const componentsOf = (object: MissionObject, blockId: string): Component[] => {
  const block = object.business.blocks?.find((item) => item.id === blockId);
  return block?.value?.components?.length ? block.value.components : block?.components ?? [];
};
const textsOf = (components: Component[], type: string): string[] =>
  components.flatMap((item) => item.type === type && typeof item.text === "string" && item.text.trim() ? [worldDisplayText(item.text.trim())] : []);
const lifecycleOf = (value: unknown): Lifecycle => (value && typeof value === "object" ? value : {}) as Lifecycle;

/** 本体对象带天枢外部引用 mission:<code> 就用它的编号，没有就用对象 id 前 8 位。 */
function codeOf(head: WorldHead): string {
  const ref = (head.external_refs ?? []).find((item) => item.system === "tianshu" && item.id.startsWith("mission:"));
  return ref ? ref.id.slice("mission:".length) : `w-${head.object_id.slice(0, 8)}`;
}

/** 一条本体 Mission 换成表里的字段和缺项。 */
function fieldsOf(object: MissionObject) {
  const definition = componentsOf(object, "definition");
  const plan = componentsOf(object, "mission_plan");
  const fields = {
    outcome: textsOf(definition, "outcome")[0] ?? "",
    why: textsOf(definition, "contribution").join("\n"),
    successEvidence: textsOf(definition, "acceptance_criterion"),
    timeBoundary: textsOf(definition, "time_boundary").join("\n"),
    boundaries: textsOf(definition, "scope_boundary").join("\n"),
    keyPath: textsOf(plan, "core_path").join("\n"),
    tradeoffs: textsOf(plan, "key_trade_off").join("\n"),
    dependencies: textsOf(plan, "constraint_dependency").join("\n"),
    milestones: textsOf(plan, "milestone"),
  };
  const gaps = [
    !fields.outcome && "成果",
    !fields.successEvidence.length && "成功标准",
    !fields.timeBoundary && "时间边界",
    !plan.length && "Mission 计划",
    !componentsOf(object, "execution_plan").length && "Task 全景",
  ].filter((gap): gap is string => Boolean(gap));
  return { fields, gaps };
}

export async function loadWorldMissions(q: Query, world: WorldMissionReader, options: { period: string; dryRun?: boolean; now?: () => Date }): Promise<WorldMissionLoadReport> {
  const scopeId = world.config.scope_id;
  const readAt = (options.now ?? (() => new Date()))().toISOString();
  const report: WorldMissionLoadReport = { scopeId, period: options.period, readAt, loaded: [], skipped: [], missing: [] };
  const personOf = new Map(Object.entries(world.config.people).map(([personId, principal]) => [principal, personId]));
  const capabilityByCode = new Map(((await q("SELECT id, code FROM capability_config")).rows as { id: string; code: string }[]).map((row) => [row.code, row.id]));
  const heads = (await world.listObjects({ type: "Mission", period: options.period })).filter((head) => head.object_type === "Mission");

  for (const head of heads) {
    const title = worldDisplayText(head.title);
    const skip = (reason: string) => report.skipped.push({ objectId: head.object_id, title, reason });
    const object = await world.getObject(head.object_id) as MissionObject;
    const principal = object.identity?.responsible?.principals?.[0]?.principal_id ?? object.business.attributes.responsible ?? null;
    if (!principal) { skip("待指派"); continue; }
    const ownerId = personOf.get(principal);
    if (!ownerId) { skip("负责人对不上"); continue; }
    const capabilityCode = head.domain_id ? world.config.capabilities?.[head.domain_id] : undefined;
    const capabilityId = capabilityCode ? capabilityByCode.get(capabilityCode) : undefined;
    if (!head.domain_id || !capabilityId) { skip("能力域对不上"); continue; }

    const code = codeOf(head);
    const lifecycle = lifecycleOf(head.lifecycle);
    const status = lifecycle.status ?? "unknown";
    const label = lifecycle.display_name ?? status;
    const { fields, gaps } = fieldsOf(object);
    const existing = (await q(`SELECT id, code FROM missions
      WHERE (world_scope_id=$1 AND world_object_id=$2) OR (world_object_id IS NULL AND source_document_id=$2) LIMIT 1`, [scopeId, head.object_id])).rows[0] as { id: string; code: string } | undefined;
    const taken = (await q("SELECT id FROM missions WHERE code=$1", [existing?.code ?? code])).rows[0] as { id: string } | undefined;
    if (!existing && taken) { skip(`编号 ${code} 已被别的 Mission 占用`); continue; }

    const content = [title, ownerId, capabilityId, fields.outcome, fields.why, JSON.stringify(fields.successEvidence), JSON.stringify(fields.milestones),
      fields.dependencies, fields.boundaries, fields.keyPath, fields.timeBoundary, fields.tradeoffs, head.version];
    const source = [scopeId, head.object_id, head.domain_id, status, label, readAt, JSON.stringify(gaps)];
    let action: LoadedMission["action"] = "insert";
    if (existing) {
      action = "same";
      if (!options.dryRun) {
        // 内容变了版本才加一；身份、状态、读取时间、缺项每次都按这次读的写。
        const changed = await q(`UPDATE missions SET version=version+1, updated_at=now(), period=$15,
            title=$2, owner_id=$3, capability_id=$4, outcome=$5, why=$6, success_evidence=$7::jsonb, milestones=$8::jsonb,
            dependencies=$9, boundaries=$10, key_path=$11, time_boundary=$12, tradeoffs=$13, source_revision=$14, source_title=$2
          WHERE id=$1 AND (period, title, owner_id, capability_id, outcome, why, success_evidence, milestones, dependencies, boundaries, key_path, time_boundary, tradeoffs, source_revision)
            IS DISTINCT FROM ($15, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11, $12, $13, $14)`, [existing.id, ...content, options.period]);
        if (changed.rowCount) action = "update";
        await q(`UPDATE missions SET world_scope_id=$2, world_object_id=$3, world_domain_id=$4, world_status=$5, world_status_label=$6,
            world_read_at=$7, world_gaps=$8::jsonb, source_ref=$9, source_document_id=$3 WHERE id=$1`,
          [existing.id, ...source, `world:${scopeId}:${head.object_id}`]);
      }
    } else if (!options.dryRun) {
      await q(`INSERT INTO missions (id, version, code, period, title, owner_id, capability_id, outcome, why, success_evidence, milestones,
          dependencies, boundaries, key_path, time_boundary, tradeoffs, source_revision, source_title, source_ref, source_document_id,
          world_scope_id, world_object_id, world_domain_id, world_status, world_status_label, world_read_at, world_gaps)
        VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11, $12, $13, $14, $15, $16, $4, $17, $19,
          $18, $19, $20, $21, $22, $23, $24::jsonb)`,
        [slugId(`${code} ${title}`) || code, code, options.period, ...content, `world:${scopeId}:${head.object_id}`, ...source]);
    }
    report.loaded.push({ code: existing?.code ?? code, title, ownerId, status: label, version: head.version, gaps, action });
  }

  const seen = new Set(heads.map((head) => head.object_id));
  report.missing = ((await q("SELECT code, title, world_object_id FROM missions WHERE world_scope_id=$1 AND period=$2 ORDER BY code", [scopeId, options.period])).rows as { code: string; title: string; world_object_id: string }[])
    .filter((row) => !seen.has(row.world_object_id)).map(({ code, title }) => ({ code, title }));
  return report;
}
