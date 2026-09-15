import type { Harness } from "@/lib/agent/harness";
import { providers } from "@/lib/research/search";
import { gatherEvidence } from "@/lib/agent/a4/evidence";
import { compile } from "@/lib/agent/a4/props";
import { independentGroupCount, liteFromLedger } from "./evidence-lite";
import type { BlindspotRuling, EntityRef, EvidenceLite, Provenance, TargetHit } from "./stages";

/**
 * 两档预算。预研是自动跑的、一天可能跑几十次，所以它的默认档必须很省；
 * 只有「撞上了既有判断」或「判成盲区」这两种情形值得多花 ——
 * 那两种情形下这条信号已经在跟他的判断打架了。
 */
export const BUDGET_HIT = { searchK: 6, maxRounds: 2, maxProps: 3 } as const;
export const BUDGET_MISS = { searchK: 2, maxRounds: 1, maxProps: 1 } as const;

export function pickBudget(o: {
  hits: readonly TargetHit[];
  blindspot: BlindspotRuling;
}): typeof BUDGET_HIT | typeof BUDGET_MISS {
  return o.hits.length > 0 || o.blindspot.isBlindspot ? BUDGET_HIT : BUDGET_MISS;
}

/**
 * 机械地造检索命题。
 *
 * 深研那条链是让模型写命题的（`a4.propose`）；预研这一档不再付那一次调用 ——
 * 要核的东西已经在手上了：每条命中的靶点原文各是一条命题，加上这一轮预研要回答的
 * 那个问题。命题的形状交给 `compile` 收口，字段名与深研共用一套。
 *
 * **字段名必须是 `compile` 真认的那两个：`materialityWeight` 与 `freshnessUrgency`，
 * 而且值是分数不是布尔。** `compile` 读的是 `RawProp`（模型交上来的形状），阈值判定
 * 在它里面：`materialityWeight >= 0.7` 才算实质命题，`freshnessUrgency >= 0.7` 才算
 * 时效紧。`material` / `freshnessUrgent` 是它**产出**上的名字，写进入参会被静默丢弃 ——
 * 不报错、不红任何断言，只是这里的意图一个字都传不进去。`extraRoundsCap` 同理：
 * 那一格由 `compile` 自己按 `material` 算（实质给两轮、其余一轮），传了也不认。
 */
export function buildPropositions(o: {
  question: string;
  entities: readonly EntityRef[];
  hits: readonly TargetHit[];
}): { propositions: unknown[] } {
  const names = o.entities.filter((e) => !e.aliasOf).map((e) => e.name);
  const q = (text: string) => (names.length ? names.map((n) => `${n} ${text}`) : [text]);
  const propositions = [
    ...o.hits.map((x) => ({
      statement: x.target.text,
      requiredEvidence: "能核到出处的公开报道或官方披露",
      queries: q(x.target.text),
      counterQueries: q(`${x.target.text} 反例`),
      // 撞上既有判断的那几条本来就是重大且时效紧的 —— 1 稳过 compile 的 0.7 两道线。
      materialityWeight: 1,
      freshnessUrgency: 1,
    })),
    {
      statement: o.question,
      requiredEvidence: "能核到出处的公开报道或官方披露",
      queries: q(o.question),
      counterQueries: q(`${o.question} 反例`),
      materialityWeight: 1,
      freshnessUrgency: 1,
    },
  ];
  return { propositions };
}

/**
 * P3 外部核验。
 *
 * **这里没有一行新的检索/抓取/入账代码** —— 编排整个借深研那条链在用的
 * `gatherEvidence`：它自己做「URL 白名单只认本轮检索返回的」「截断在前哈希在后」
 * 「原句要能在快照里定位」「全量重折叠独立性」。预研与深研在证据这件事上
 * 因此**不可能出现两套标准**。
 *
 * `searchless` 在收尾时按入账条数算，**不看源表空不空**：`providers()` 三条路回的表
 * 都非空（`search.ts` 自己写着「`list.length` 永远 ≥1」），所以「一个源都没有」
 * 这条分支在生产上不存在，写一个就是死代码加一段假注释。缺 key 那一档在表里的是
 * `NoSearch`，它取不到东西，最终一样是零入账。上屏时他看到「这一份没有外部核验」，
 * 而这句话为真的条件正是零入账。
 */
export async function verifyExternally(
  h: Harness,
  o: {
    question: string;
    entities: readonly EntityRef[];
    hits: readonly TargetHit[];
    blindspot: BlindspotRuling;
    provenance: Provenance;
  },
): Promise<{ evidence: EvidenceLite[]; searchless: boolean; groups: number }> {
  const { list, skipped } = providers();
  const budget = pickBudget(o);
  const props = compile(buildPropositions(o), budget.maxProps);
  const got = await gatherEvidence(
    h,
    list,
    props,
    { searchK: budget.searchK, maxRounds: budget.maxRounds },
    { slot: "flash", label: "预研核验", substep: (suffix) => h.substep(`预研核验 · ${suffix}`) },
  );

  const evidence = liteFromLedger(got.ledger, o.provenance);
  const searchless = evidence.length === 0;
  if (searchless) {
    // 零入账有两种来路，台账上要分得出来：一条都没搜到，和抽了几条全被拒。
    // 只记「没有外部核验」的话，这两种在记录里长得一模一样，而它们说明的事完全不同
    // （前者是这题搜不到，后者是抽取在编）。
    h.note("这一轮没有一条外部证据入账", {
      被拒条数: got.ledger.rejections.length,
      跳过的检索源: skipped.join("、"),
    });
  }
  return { evidence, searchless, groups: independentGroupCount(evidence) };
}
