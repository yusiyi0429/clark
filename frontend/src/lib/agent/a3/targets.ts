import type { Harness } from "@/lib/agent/harness";
import { parseJson } from "@/lib/agent/json";
import { bigramOverlap } from "@/lib/agent/overlap";
import { A3_TARGETS_SYSTEM, buildA3TargetsUser } from "./prompt";
import type { EntityRef, Magnitude, MatchKind, TargetHit, TargetRef } from "./stages";

/**
 * 送进模型的靶点候选上限。规格建议用向量检索做召回，本仓库没有 embedding 客户端，
 * 也不动 `search.ts`，所以召回退成字符二元组重叠预筛 —— 它会漏掉换了说法的同义靶点，
 * 这是明账上的退让，不是当它不存在。12 条大约是模型一次能认真读完的量。
 */
export const NARROW_K = 12;

/** 两个名字重叠到这个程度就当同一个实体的不同写法。 */
export const ALIAS_MIN = 0.72;

const MATCHES: readonly MatchKind[] = ["supports", "challenges", "extends", "none"];
const MAGNITUDES: readonly Magnitude[] = ["material", "immaterial", "unknown"];

/**
 * 实体归一。**先出现的那个名字当规范名** —— 不挑「更正式」的那个，因为挑不出
 * 客观标准，而顺序是确定的。归并只在同 `kind` 内做：同名的公司和产品是两件事。
 * 被并掉的那条不删，留着并标 `aliasOf`：他要看得见系统把哪两个名字当成了一个。
 */
export function normalizeEntities(raw: readonly EntityRef[]): EntityRef[] {
  const out: EntityRef[] = [];
  for (const e of raw) {
    const name = e.name.trim();
    if (!name) continue;
    if (out.some((o) => o.name === name && o.kind === e.kind)) continue;
    const canon = out.find((o) => o.kind === e.kind && !o.aliasOf && bigramOverlap(o.name, name) >= ALIAS_MIN);
    out.push({ name, kind: e.kind, ...(canon ? { aliasOf: canon.name } : {}) });
  }
  return out;
}

/** 按与实体名的最大重叠度收窄靶点候选。重叠为 0 的不进候选。 */
export function narrowTargets(
  entities: readonly EntityRef[],
  all: readonly TargetRef[],
  k: number = NARROW_K,
): TargetRef[] {
  return all
    .map((t) => ({ t, score: Math.max(0, ...entities.map((e) => bigramOverlap(e.name, t.text))) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((x) => x.t);
}

/**
 * 实体归一与靶点匹配一次调用：归一实体、判匹配方向、估量级。
 *
 * 三件事看的是同一段材料，分三次调用是白花钱。形状读不懂就空手回来（不抛）——
 * 预研是自动跑的，一次形状异常不该让整张提请卡消失；下游的盲区裁定看到空命中
 * 会如实记成「这一轮对不上任何靶点」。
 */
export async function matchTargets(
  h: Harness,
  o: {
    signalText: string;
    entities: readonly string[];
    targets: readonly TargetRef[];
    hopsOf?: (t: TargetRef) => number | null;
  },
): Promise<{ entities: EntityRef[]; hits: TargetHit[]; magnitude: Magnitude }> {
  const r = await h.callMessages(
    "模型调用 · a3.targets",
    [
      { role: "system", content: A3_TARGETS_SYSTEM },
      { role: "user", content: buildA3TargetsUser(o) },
    ],
    { slot: "flash", maxTokens: 2000 },
    { promptKey: "a3.targets", targetCount: o.targets.length },
    "a3.targets",
  );

  let parsed: unknown;
  try {
    parsed = parseJson<unknown>(r.text);
  } catch {
    h.note("靶点匹配返回读不懂", { note: "不是合法 JSON，这一轮当作对不上任何靶点" });
    return { entities: [], hits: [], magnitude: "unknown" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    h.note("靶点匹配返回读不懂", { got: typeof parsed });
    return { entities: [], hits: [], magnitude: "unknown" };
  }
  const obj = parsed as Record<string, unknown>;

  const rawEntities = Array.isArray(obj.entities) ? obj.entities : [];
  const entities = normalizeEntities(
    rawEntities.flatMap((x) => {
      if (typeof x !== "object" || x === null) return [];
      const e = x as Record<string, unknown>;
      if (typeof e.name !== "string") return [];
      const kind = e.kind;
      const ok = kind === "company" || kind === "product" || kind === "person" || kind === "org" || kind === "topic";
      return [{ name: e.name, kind: ok ? kind : ("topic" as const) }];
    }),
  );

  const byId = new Map(o.targets.map((t) => [t.id, t]));
  const hops = o.hopsOf ?? (() => null);
  const hits: TargetHit[] = [];
  const rawHits = Array.isArray(obj.hits) ? obj.hits : [];
  for (const x of rawHits) {
    if (typeof x !== "object" || x === null) continue;
    const hit = x as Record<string, unknown>;
    const target = typeof hit.targetId === "string" ? byId.get(hit.targetId) : undefined;
    if (!target) {
      h.note("靶点匹配报了不存在的编号", { targetId: String(hit.targetId), note: "丢掉 —— 不许凭空造靶点" });
      continue;
    }
    const match = hit.match;
    if (typeof match !== "string" || !MATCHES.includes(match as MatchKind) || match === "none") continue;
    hits.push({
      target,
      match: match as MatchKind,
      why: typeof hit.why === "string" ? hit.why : "",
      hops: hops(target),
    });
  }

  const magnitude = MAGNITUDES.includes(obj.magnitude as Magnitude) ? (obj.magnitude as Magnitude) : "unknown";
  return { entities, hits, magnitude };
}
