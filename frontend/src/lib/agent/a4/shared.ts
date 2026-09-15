/**
 * 两支深研共用的那几段小逻辑：**装配清单的底、外部检索那一行、检索家命中的汇总、
 * 落库文档的默认署名、正文里合法但不在台账上的编号**。
 *
 * ## 为什么它们要有一个共同的家
 *
 * 这几段本来是两份：`run.ts`（四链路那一支）各写一份，`pipeline.ts` / `stage-write.ts`
 * （七步链那一支）从那边照抄一份。抄出来的两份里有**两句一模一样的屏幕文字** ——
 * 「只有公司经营状态，没有这条议题的既有认识（…）」和「本次无公司上下文（…）」。同一句话
 * 摆在两处的后果不是多几行代码：改了其中一处的措辞，另一处照旧说着老话，而**没有任何一处
 * 会报错**，屏幕上的表现是「同一件事在两条链路上说法不一样」，而这两条链路本来就是要拿同一
 * 个议题各跑一遍作对比的 —— 对比时看到的差异有一半来自抄漏，那这个对比就不成立了。
 *
 * 所以放在这里，两支都从这里取。这个文件**只收「两支都要、而且必须逐字相同」的东西**：
 * 它不是杂物间，往里加东西之前先问「另一支也读它吗、说的是不是同一句话」。
 *
 * 反过来的那半句同样要守住：**符合这个判据的东西不许留在外面。** 后来两支各自又长出了两处
 * 抄两份的屏幕文字（装配清单上「外部检索 · …」那一行、落库文档的默认署名），走的正是上面那条
 * 老路 —— 改一处另一处照旧说老话，而没有任何一处会报错。它们现在都在下面。
 */

import type { Harness } from "@/lib/agent/harness";
import type { ManifestItem } from "@/lib/data/types";
import type { SearchAccount } from "@/lib/research/search";

import type { ReportBlocks } from "./blocks/schema";
import type { Round } from "./evidence";
import type { A4Input } from "./prompt";

/**
 * 这一轮装配清单的底：公司上下文（或者它为什么没有）、在版判断、预研结论。
 *
 * 两支各自的那份清单都是「这个底 + 自己取回来的那些页」，所以底必须逐字相同 —— 同一个
 * 议题两边各跑一遍作对比时，清单上的差异只该来自各自取回来的东西。
 *
 * 没装上公司上下文时**分两句说**：装上了【公司经营状态】的那次，公司整体状况是真材料，
 * 只是这条议题在图里没有位置；没装上的那次才是真的什么都没有。原因照抄 `noAnchorReason`，
 * 不自己写「图谱里没有这条议题」—— 那是三种成因里的一种，写死就等于把另外两种也报成它。
 */
export function baseManifest(h: Harness, input: A4Input): ManifestItem[] {
  const base: ManifestItem[] = [];
  if (h.narrative) {
    // 同 `a3/run.ts` 那一行的理由：两档都放不下它，它得自己一行。
    base.push({
      label: `本体叙述 · ${h.bundle?.renderedMarkdown.length ?? 0} 字 · 无锚点、无可引编号`,
      kind: "int",
    });
  } else if (h.externalOnly) {
    base.push({
      label: h.companyStateOnly
        ? `只有公司经营状态，没有这条议题的既有认识（${h.noAnchorReason || "图谱里没有对应锚点"}）`
        : `本次无公司上下文（${h.noAnchorReason || "图谱里没有对应锚点"}）`,
      kind: "agent",
    });
  } else {
    const b = h.bundle!;
    base.push({
      label: `GraphKnowledge S03 · ${b.anchorCode} · ${b.memberIds.length} 个对象`,
      kind: "int",
    });
  }
  for (const j of input.judgments) {
    base.push({ label: `${j.id} · 在版判断`, href: `/judgments/${j.id}`, kind: "judgment" });
  }
  if (input.preTake) base.push({ label: "本议题的预研结论", kind: "agent" });
  return base;
}

/**
 * 装配清单上「这一轮外面取了什么」那一行。
 *
 * 只在真有检索家在跑的那一轮加，所以由调用方判要不要加，这里只管那一句话怎么写。
 * 两支必须逐字相同的理由和 `baseManifest` 一样：同一个议题两边各跑一遍作对比时，清单上的
 * 差异只该来自各自取回来的东西，不该来自两处文案抄漏。
 */
export const retrievalItem = (
  providerLabel: string,
  rounds: number,
  recorded: number
): ManifestItem => ({
  label: `外部检索 · ${providerLabel}（${rounds} 轮，入账 ${recorded} 条证据）`,
  kind: "agent",
});

/**
 * 没人告诉这一轮署谁的名时署这个。
 *
 * 留成常量是因为**同一轮的两处要说同一句话**：落库那份文档署名在 `shape()` 里填，而这一轮
 * 还在跑时先摆上屏幕的那几份原件也带署名（`DraftReport.byAgentLabel`）—— 两处各写一个字符串
 * 的话，报告落库那一瞬屏幕上的署名会换一次，而没有任何一处说过它会换。两支各存一份是同一个
 * 毛病的放大版：那时候换的是「走哪条链跑出来的报告署名不一样」。
 */
export const DEFAULT_AGENT_LABEL = "您的 Agent";

/**
 * 各轮的「每家出了几条」加起来。
 *
 * 累计而不是只留最后一轮：补搜轮换了问法，某一家在补搜里的表现可能和第一轮反过来 ——
 * 而「加这一家值不值」问的是整台机器的检索配置，不是某一轮，也不是某一条链路（也不是
 * 某一维）。所以两支递进来的都是**这一轮全部轮次**。
 */
export function rollUp(rounds: readonly Round[]): Record<string, SearchAccount> {
  const out: Record<string, SearchAccount> = {};
  for (const r of rounds) {
    for (const [name, a] of Object.entries(r.hitsByProvider)) {
      const acc = (out[name] ??= { label: a.label, returned: 0, unique: 0 });
      acc.returned += a.returned;
      acc.unique += a.unique;
    }
  }
  return out;
}

/**
 * 一份区块报告里**不在台账上、但正文里合法**的那几个编号：模型既有知识那一类
 * （`origin === "model"`，见 `blocks/registry.ts` 的 HP-2）。
 *
 * 递给 `gateReport` 用。台账装的是这一轮真取回来、逐字定位过的东西，而这几条是模型自己的
 * 记忆 —— 契约允许它用，条件是单列出来标成没核实过。两者混不到一起，所以这里按来源挑，
 * 不按「证据表里有没有」挑。
 */
export const outsideLedgerIds = (report: ReportBlocks): string[] =>
  report.evidence.filter((e) => e.origin === "model").map((e) => e.id);

/**
 * **写手槽位开关（2026-09-04）。** `TKOS_A4_WRITER_SLOT=synth` 把大纲、分节、收口暖场、返修换到 gpt-5.6；
 * 不填就是原来的 `alt`（claude-opus-5）。草稿另有 `TKOS_A4_DRAFT_SLOT`（见下）。
 *
 * 加它的理由是两轮实测：alt 的思考在网宿上不受控 —— ISS-229 两轮里 S1/S3 各把 8000 额度整个花在
 * 思考上、一个字没写；而同一出口的 gpt-5.6 写收口 4.4k token 只用 59 秒。「Claude 特有晦涩」
 * 也一直没有对照。这个开关就是那个对照：同题换写手跑一遍，其余一个字不动。
 *
 * 收口本来就在 synth 上，不动。
 *
 * **2026-09-04 晚拆成两个开关。** ISS-230 那一轮（整段换 synth）证明草稿和写手是两件事：草稿决定命题、
 * 命题决定取证走哪条路 —— gpt-5.6 的草稿把命题押在合肥政府站和产线工艺上，入账 4 条；同题的 Claude
 * 草稿押在披露稿里查得到的折旧、亏损、份额上，入账 44 条。而分节那一步 gpt-5.6 四节全交、183 秒，
 * Claude 三轮丢了五节。所以草稿留 `alt`、写手可以单独换。对账跟**草稿**反着走：它判的是草稿对不对
 * 证据，写草稿的那一家不能判自己。
 */
export type WriterSlot = "alt" | "synth";
const slotEnv = (name: string): WriterSlot => ((process.env[name] ?? "").trim() === "synth" ? "synth" : "alt");
/** 先验草稿（N1）用哪一家。`TKOS_A4_DRAFT_SLOT`，不填 = alt。 */
export const draftSlot = (): WriterSlot => slotEnv("TKOS_A4_DRAFT_SLOT");
/** 大纲、分节、收口暖场、返修（N5）用哪一家。`TKOS_A4_WRITER_SLOT`，不填 = alt。 */
export const writerSlot = (): WriterSlot => slotEnv("TKOS_A4_WRITER_SLOT");
/**
 * 大纲（N5 第一步）用哪一家。`TKOS_A4_OUTLINE_SLOT`，不填 = synth。
 *
 * 2026-09-06 从写手槽位里拆出来：ISS-232 大纲在 claude-opus-5 上花了 3 分 17 秒 —— 交回来的只是几百
 * token 的结构 JSON，时间全在思考上。结构这一步不需要文笔，gpt-5.6 一分钟内交。分节与收口仍按
 * `writerSlot()`。
 */
export const outlineSlot = (): WriterSlot => ((process.env.TKOS_A4_OUTLINE_SLOT ?? "").trim() === "alt" ? "alt" : "synth");
/**
 * 检索计划（N2）用哪一家。`TKOS_A4_PLAN_SLOT`，不填 = synth。
 *
 * 2026-09-06 从 pro 换出来：ISS-235 计划一次 3 分 32 秒、补正再 2 分 59 秒，六分半全在 deepseek-pro 的思考上
 * （2026-08-31 起就是它最窄的一段：思考 5–16k token）。计划交的是一行一条的 JSONL，不需要深思考；
 * gpt-5.6 在大纲上一分半交，这一步同一类活。
 */
export const planSlot = (): "pro" | "synth" => ((process.env.TKOS_A4_PLAN_SLOT ?? "").trim() === "pro" ? "pro" : "synth");
/** 对账（N4）用哪一家：与草稿相反的那一家。 */
export const reconcileSlot = (): WriterSlot => (draftSlot() === "synth" ? "alt" : "synth");
