/**
 * 预研的**最终裁决** —— 一个纯函数，统一产出 status / statusReason / quality。
 *
 * ## 为什么要有这一层（2026-09-05）
 *
 * v2 里否决条件散在三处：模型写的 `status`、`suggestDisposition` 的 action、批判的 `pass`。
 * 三处各写各的，ISS-224 的结局就是：模型判 `invalid`（理由是本体没记录维信诺），批判打回
 * 「把流程空转当成世界为空、靶点标反了」，卡片照发、结论照旧。批判的产物只进了 `stages`，
 * 没有一处读它来改结论。
 *
 * 现在只有这一处定最终状态。规则按批判报的代号分：
 *
 * | 批判 | 裁决 |
 * |---|---|
 * | 通过 | `ok`，结论照模型的 |
 * | `premiseDenied` / `contradiction` | 要修正：交一句返修理由；修完再判一次机检，过了记 `corrected`，没过记 `needsCorrection` 且 status 置 null（不知道就不显示成「不成立」） |
 * | `targetMismatch` | 撤掉错挂的靶点（hits 清空），议题照旧；记 `corrected` |
 * | `overclaim` / `evidenceThin` | p1 语义：留痕，不改结论 |
 * | 批判没跑成（`unavailable`） | `criticUnavailable`，结论照模型的，屏幕上照实说「这一轮没过批判」 |
 *
 * 不做的事：不把 invalid 直接翻成 valid（那是替模型下结论）；不重跑批判（一次修正、一次机检，
 * 到此为止 —— 循环等待好结果不是定位问题）。
 */
import type { PreResearchQuality, PreResearchStatus } from "@/lib/data/types";
import type { CriticVerdict, TargetHit } from "./stages";

export type Ruling = {
  status: PreResearchStatus | null;
  statusReason: string;
  quality: PreResearchQuality;
  /** 裁决后仍算数的靶点命中（targetMismatch 时清空）。 */
  hits: TargetHit[];
  /** 非空 = 要发一次有明确目标的修正，这就是递给模型的那段话。 */
  repairAsk: string | null;
};

const NEEDS_REPAIR = new Set(["premiseDenied", "contradiction"]);

/** 第一次裁决：批判回来之后、修正之前。 */
export function rule(o: {
  status: PreResearchStatus | null;
  statusReason: string;
  critic: CriticVerdict;
  hits: readonly TargetHit[];
}): Ruling {
  const { critic } = o;
  const notes = [...critic.why];
  if (critic.unavailable) {
    return {
      status: o.status,
      statusReason: o.statusReason,
      quality: { state: "criticUnavailable", notes },
      hits: [...o.hits],
      repairAsk: null,
    };
  }
  const mismatch = critic.checks.includes("targetMismatch");
  const hits = mismatch ? [] : [...o.hits];
  const toRepair = critic.checks.filter((c) => NEEDS_REPAIR.has(c));
  if (toRepair.length) {
    return {
      status: o.status,
      statusReason: o.statusReason,
      quality: { state: "needsCorrection", notes },
      hits,
      repairAsk:
        `批判打回了这一版的结论，按下面几条重写，其余不要动：\n` +
        notes.map((x) => `· ${x}`).join("\n") +
        `\n\n重写的规矩：一号位在议题里给定的公司事实是前提，不用「上下文/本体没有记录」去否定它；` +
        `判 invalid 只能因为议题本身（内部矛盾、量级不够、被公开事实推翻、与当前 Outcome 无关）。` +
        `status、statusReason、verdict、soWhat 四处要指向同一个方向。只输出修正后的 JSON。`,
    };
  }
  if (critic.pass || (!toRepair.length && critic.checks.every((c) => c === "overclaim" || c === "evidenceThin" || c === "targetMismatch"))) {
    return {
      status: o.status,
      statusReason: o.statusReason,
      quality: { state: mismatch ? "corrected" : "ok", notes: mismatch ? [...notes, "批判指出挂错了既有判断，已撤掉那条关联，议题本身不受影响"] : notes },
      hits,
      repairAsk: null,
    };
  }
  // 模型打回了、但没报出任何代号：不知道错在哪，按需修正处理但不发返修（没有明确目标）。
  return {
    status: o.status,
    statusReason: o.statusReason,
    quality: { state: "needsCorrection", notes: notes.length ? notes : ["批判打回，但没有说明打回的是哪一句"] },
    hits,
    repairAsk: null,
  };
}

/** 修正那一次之后的裁决：只看机检结果，不再叫模型。 */
export function ruleAfterRepair(o: {
  status: PreResearchStatus | null;
  statusReason: string;
  before: Ruling;
  machine: { checks: readonly string[]; why: readonly string[] };
}): Ruling {
  const stillBad = o.machine.checks.filter((c) => NEEDS_REPAIR.has(c));
  if (stillBad.length) {
    return {
      ...o.before,
      // 修完仍是同一种错：不知道它到底成不成立，就不显示成「不成立」。
      status: null,
      statusReason: "",
      quality: {
        state: "needsCorrection",
        notes: [...o.before.quality.notes, `修正一次后仍未过：${o.machine.why.join("；")}`],
      },
      repairAsk: null,
    };
  }
  return {
    ...o.before,
    status: o.status,
    statusReason: o.statusReason,
    quality: { state: "corrected", notes: [...o.before.quality.notes, "已按批判意见重写"] },
    repairAsk: null,
  };
}

/** 修正的预算不够或没发出去时的裁决：照实记，不静默通过。 */
export function ruleUnrepaired(before: Ruling, why: string): Ruling {
  return {
    ...before,
    status: null,
    statusReason: "",
    quality: { state: "needsCorrection", notes: [...before.quality.notes, `没能修正：${why}`] },
    repairAsk: null,
  };
}
