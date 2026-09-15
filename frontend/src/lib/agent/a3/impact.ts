import type { Harness } from "@/lib/agent/harness";
import { parseJson } from "@/lib/agent/json";
import { independentGroupCount } from "./evidence-lite";
import { A3_IMPACT_SYSTEM, buildA3ImpactUser } from "./prompt";
import type { EvidenceLite, ImpactProposal, ImpactType, ProposalType, TargetHit } from "./stages";

/**
 * 说得出「推翻」要几组独立源。
 *
 * 两组 —— **沿用 Part1 §2.2「强判断 ≥2 独立源」这条已经在跑的线**
 * （`talk/verifier.ts` 的机检第二道就是这个数），不在预研这一层自己加严：
 * 同一件事在产品里有两个门槛，比门槛低更糟。
 */
export const MIN_INDEPENDENT_SOURCES = 2;

const IMPACTS: readonly ImpactType[] = ["confirms", "weakens", "overturns", "outOfScope"];
const PROPOSALS: readonly ProposalType[] = ["adjustJudgment", "reopenDecision", "newIssue", "noAction"];

/** 读不懂或撑不起时退到这一档：如实说不动作。 */
function noAction(statement: string): ImpactProposal {
  return { impactType: "outOfScope", proposalType: "noAction", targetRef: null, statement, basis: [] };
}

/**
 * P4 影响提案。**只提提案，不改任何状态** —— 这个函数不写库，返回值交给上层装进卡片。
 *
 * 两道机检：依据里引的证据编号必须在这一轮台账里真在（`[P]` 打头的先验依据不查，
 * 因为它本来就不指向证据）；说到「推翻」必须有两组以上独立源，不够就机械降成「削弱」
 * 并留痕 —— 降档不许悄悄发生，他要看得见「系统把模型的话降了一档」。
 */
export async function proposeImpact(
  h: Harness,
  o: {
    question: string;
    material: string;
    hits: readonly TargetHit[];
    evidence: readonly EvidenceLite[];
    searchless: boolean;
  },
): Promise<{ impact: ImpactProposal; downgraded: boolean }> {
  const r = await h.callMessages(
    "模型调用 · a3.impact",
    [
      { role: "system", content: A3_IMPACT_SYSTEM },
      { role: "user", content: buildA3ImpactUser(o) },
    ],
    { slot: "pro", maxTokens: 2000 },
    { promptKey: "a3.impact", evidenceCount: o.evidence.length, searchless: o.searchless },
    "a3.impact",
  );

  let parsed: unknown;
  try {
    parsed = parseJson<unknown>(r.text);
  } catch {
    h.note("影响提案返回读不懂", { note: "不是合法 JSON" });
    return { impact: noAction("这一轮的影响提案读不懂，按不动作处理"), downgraded: false };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { impact: noAction("这一轮的影响提案读不懂，按不动作处理"), downgraded: false };
  }
  const obj = parsed as Record<string, unknown>;

  const statement = typeof obj.statement === "string" ? obj.statement : "";
  const ids = new Set(o.evidence.map((e) => e.id));
  const rawBasis = Array.isArray(obj.basis) ? obj.basis.filter((x): x is string => typeof x === "string") : [];
  const basis = rawBasis.filter((b) => b.startsWith("[P]") || ids.has(b));
  if (basis.length < rawBasis.length) {
    h.note("影响提案引了台账里没有的编号", {
      dropped: rawBasis.filter((b) => !basis.includes(b)),
      note: "摘掉那几条依据 —— 编号是编的，说法就不算有依据",
    });
  }

  let impactType = IMPACTS.includes(obj.impactType as ImpactType) ? (obj.impactType as ImpactType) : null;
  let proposalType = PROPOSALS.includes(obj.proposalType as ProposalType) ? (obj.proposalType as ProposalType) : null;
  if (!impactType || !proposalType || basis.length === 0 || !statement) {
    return { impact: noAction(statement || "这一轮拿不出有依据的影响提案，按不动作处理"), downgraded: false };
  }

  let downgraded = false;
  if (impactType === "overturns" && independentGroupCount(o.evidence) < MIN_INDEPENDENT_SOURCES) {
    h.note("影响提案降档", {
      from: "overturns",
      to: "weakens",
      groups: independentGroupCount(o.evidence),
      note: `说到推翻要 ${MIN_INDEPENDENT_SOURCES} 组独立源，这一轮不够`,
    });
    impactType = "weakens";
    proposalType = "adjustJudgment";
    downgraded = true;
  }

  const targetRef =
    typeof obj.targetId === "string" ? (o.hits.find((x) => x.target.id === obj.targetId)?.target ?? null) : null;

  return { impact: { impactType, proposalType, targetRef, statement, basis }, downgraded };
}

/**
 * **不叫模型的影响提案（2026-09-05，预研 v3）。**
 *
 * v2 的 `proposeImpact` 是一次模型调用，判「这条信号对既有判断是证实 / 削弱 / 推翻 / 无关」。
 * 它的产物（`ImpactProposal`）在屏幕上没有一处显示，只被 `suggestDisposition` 和提请卡读；
 * 而 ISS-224 那次它把首访议题判成 outOfScope，被批判指出「靶点标反了」。预研压到三次调用之后，
 * 这一格改成从预研结论和靶点命中**推导**：
 *
 * - 有命中且方向是 challenges → `weakens`（提 `adjustJudgment`）；supports / extends → `confirms`；
 * - 没命中 → `outOfScope` + `noAction`，说法就是 verdict 本身。
 *
 * 它不再声称「推翻」——推翻要两组独立源，预研这一层没有外部取证。
 */
export function deriveImpact(o: {
  status: "valid" | "invalid" | "reframing_needed" | null;
  verdict: string;
  hits: readonly TargetHit[];
}): ImpactProposal {
  const statement = o.verdict || "（预研没有给出判断）";
  const top = o.hits.find((h) => h.match === "challenges") ?? o.hits.find((h) => h.match !== "none");
  if (!top || o.status === "invalid") return noAction(statement);
  const weakens = top.match === "challenges";
  return {
    impactType: weakens ? "weakens" : "confirms",
    proposalType: weakens ? "adjustJudgment" : "noAction",
    targetRef: top.target,
    statement,
    basis: [`[P] ${top.why}`],
  };
}
