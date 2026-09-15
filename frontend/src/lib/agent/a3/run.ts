/**
 * 跑一次 A3 Pre-research：装配上下文 → 调模型 → 确定性校验 → 不过就带着违规重试。
 *
 * 重试的关键在于**把违规原样递回去**，而不是笼统地说「请改进」。模型改不动一个
 * 它看不见的错误。实测这一条决定了重试是收敛还是空转。
 *
 * 重试上限 2 次。再多说明 prompt 或质量门有问题，不是模型今天状态差 —— 让它
 * 一直重试只会烧钱并把失败藏起来。第 3 次仍不过就落一份带 p0 标记的结果，
 * 让运营台能看到，而不是静默丢弃。
 */
import { parseJson, str, toStatements } from "@/lib/agent/json";
import { Harness } from "@/lib/agent/harness";
import { cognitiveFor } from "@/lib/agent/prompts";
import type {
  AgentRunRecord,
  ManifestItem,
  PreResearchDoc,
  PreResearchStatus,
} from "@/lib/data/types";

import { ruleBlindspot } from "./blindspot";
import { assembleCard, checkCard } from "./card";
import { criticize, machineChecks, type CriticSubject } from "./critic";
import { cardPriority, suggestDisposition } from "./dispose";
import { deriveImpact } from "./impact";
import { A3_SYSTEM, buildA3Repair, buildA3User, type A3Input } from "./prompt";
import { makeProvenance } from "./provenance";
import { rule, ruleAfterRepair, ruleUnrepaired, type Ruling } from "./ruling";
import type { PreResearchStages } from "./stages";
import { matchTargets, narrowTargets } from "./targets";
import { blocking, fmt, summarize, validatePreResearch, type Violation } from "./validate";

const MAX_REPAIR = 2;

export type A3Result = {
  doc: PreResearchDoc;
  violations: Violation[];
  attempts: number;
  /** 走到最后仍有 p0。产物照样落盘，但要能被看见。 */
  degraded: boolean;
  /** 这次运行的可复现记录。由调用方落库（`agentRunPut`）。 */
  run: AgentRunRecord;
  /** v2 七段的产物。走 v1 时是 `undefined`。 */
  stages?: PreResearchStages;
};

type Raw = {
  status?: unknown;
  statusReason?: unknown;
  verdict?: unknown;
  premises?: unknown;
  question?: unknown;
  take?: unknown;
  finding?: unknown;
  openQuestion?: unknown;
  soWhat?: unknown;
};

/**
 * 屏幕上那两步的原话。**这里就是它们唯一的出处** —— 视图层不许自己编一套。
 *
 * 两步，不是四步：`shape` 和质量门是同步的、以毫秒计，把它们也报成一步只会让那行
 * 小字闪一下就过去，读到的人以为它在跳。只报真的要等的那两段。
 */
const STEPS = {
  context: "装配上下文",
  match: "对靶点",
  write: "写这一轮预研",
  critic: "过一道批判",
} as const;
/**
 * v1 是两段（装上下文 + 写）。v2 四段 —— 2026-09-05 从七段压下来：
 * 外部核验（`verifyExternally`）、算影响（`proposeImpact`）、装提请卡三步撤了。
 *
 * 撤的理由不是省钱：这三步的产物在屏幕上一处都不显示（`signal-view.tsx` 只读 take /
 * finding / openQuestion / soWhat / status），批判的打回也从未改变过结论。预研存在的目的是
 * 让一号位尽快判断这题值不值得花精力，深入在对话里做；它要的是 90 秒内一句一针见血的话，
 * 不是一份带七段流水线的卡。影响提案改为从结论推导（`deriveImpact`），提请卡照旧纯函数装配
 * （`assembleCard`），不再各花一次调用。进度条的分母跟着入参走。
 */
const STEP_TOTAL_V1 = 2;
const STEP_TOTAL_V2 = 4;

export async function runPreResearch(
  input: A3Input,
  /** 往任务表报进度。见 `HarnessInit.progress` —— 不给就不报。 */
  opts?: { progress?: { kind: string; id: string } }
): Promise<A3Result> {
  /*
   * 上下文源是 M7 的 S02 配方，**锚点是这条议题挂着的在版判断**。
   *
   * 原来是按 `issue.title` 检索 `ISS-*` 自动选锚点，实跑下来一次都命中不了：图谱
   * 里没有前端这十条议题的 Issue 对象（前端的编号是种子生成脚本自己编的），于是每
   * 份预研都走纯外部。而这些判断号（`01-J3` 这一类）在图里是真实存在的，前端每条
   * 议题也已经挂着它们，所以直接用这条已知的对应关系。代价是这一档的「锚点」含义
   * 从议题变成判断 —— 装出来的正文里如实写明这一点。
   *
   * 判断号为空（有议题确实不动摇任何在版判断）就照旧走检索。`q` 里**不含任何指令
   * 样板**：P3 的 q 上限是 100 字符（服务端约束），前 100 字全是「以下内容来自…
   * 请执行…」的话，拿去检索的等于模板文字。
   *
   * `GraphKnowledgeUnavailable` 不接：图服务挂了要是被当成「图谱里没有这条
   * 议题」，每一次预研都会悄悄降级成纯外部，还照样产出一份格式漂亮的报告。
   */
  const h = new Harness({
    agent: "A3",
    slot: "pro",
    ...(opts?.progress
      ? { progress: { ...opts.progress, total: input.targets ? STEP_TOTAL_V2 : STEP_TOTAL_V1 } }
      : {}),
  });
  const judgmentCodes = input.judgments.map((j) => j.id);
  h.step(STEPS.context);
  await h.openContext("S02", input.title, { judgmentCodes });
  // 直接取 getter：它自己判了 externalOnly，两支都回落到 NO_COMPANY_CONTEXT。外面再
  // 判一次的坏处不是多一行，是它暗示 getter 不可信 —— 于是这个三元会被抄到第四、第五处。
  const companyContext = h.contextBlock;

  const assembled: ManifestItem[] = [];
  if (h.narrative) {
    /*
     * 叙述那一支自己一行。它既不能写成「GraphKnowledge S02 · 锚点是…」（没有锚点，
     * 那一行会是空的），也不能写成「本次无公司上下文」（手上有一整段真材料）。
     * 字数写出来是因为这一支只有这一个量：没有对象数、没有锚点，读的人要能看出
     * 这一轮到底装了多少东西进去。
     */
    assembled.push({
      label: `本体叙述 · ${h.bundle?.renderedMarkdown.length ?? 0} 字 · 无锚点、无可引编号`,
      kind: "int",
    });
  } else if (h.externalOnly) {
    // 原因照抄下来。「图谱里没有这条议题」和「它挂着的判断图谱里也没有」是两回事，
    // 而这一行是一号位在屏幕上唯一看得到的解释。
    //
    // 两句分开写，因为手上的材料不一样：装上了 P0 的那次，公司整体状况是真的；没装
    // 上的那次什么都没有。合成一句「无公司上下文」，前一种就被说轻了 —— 一号位会
    // 以为这份预研连本期要达成什么都不知道，而它其实知道。
    assembled.push({
      label: h.companyStateOnly
        ? `只有公司经营状态，没有这条议题的既有认识（${h.noAnchorReason || "图谱里没有对应锚点"}）`
        : `本次无公司上下文（${h.noAnchorReason || "图谱里没有对应锚点"}）`,
      kind: "agent",
    });
  } else {
    const b = h.bundle!;
    assembled.push({
      label: judgmentCodes.length
        ? `GraphKnowledge S02 · 锚点是在版判断 ${b.anchorCode} · ${b.memberIds.length} 个对象`
        : `GraphKnowledge S02 · ${b.anchorCode} · ${b.memberIds.length} 个对象`,
      kind: "int",
    });
  }
  for (const j of input.judgments) assembled.push({ label: `${j.id} · 在版判断`, href: `/judgments/${j.id}`, kind: "judgment" });

  /*
   * 第 ③ 段认知指令。A3 的 user 段是手写的一整份，不走 `assemble()`，但取值要和
   * A1a 同一条路径 —— 所以直接用 `cognitiveFor`，运行时给了就用运行时的。
   * `cognitiveSource` 跟着模型调用记进 trace：事后要能查出「这一轮到底带没带方法标准」，
   * 否则一份没带标准跑出来的预研和带了的在结果页上长得一模一样。
   */
  const cog = await cognitiveFor("a3.pre-research", h.cognitive["a3.pre-research"]);

  const messages = [
    { role: "system", content: A3_SYSTEM },
    { role: "user", content: buildA3User({ ...input, companyContext, cognitive: cog.text }) },
  ];
  const callDetail = { promptKey: "a3.pre-research", cognitiveSource: cog.source };

  /*
   * v2 的前三段。
   *
   * **这一轮它们的产物不进写作提示词** —— `buildA3User` 手上仍然只有原来那几段材料，
   * `matched` / `verified` 一个字都没拼进去。放在写作之前只有一个作用：
   * 让 P1–P3 的留痕排在写作前面，回放的时候时序对得上。
   *
   * 别把这段注释读成「写作建立在核验之上」。要真做到那一步，得把靶点命中与证据台账
   * 拼进写作那一次模型调用的输入 —— 那是一次真实的行为改动，会动产出质量，
   * 而这份计划没为它设计过评估。**这条记在末节欠账里，不许在这里顺手加。**
   *
   * 不给 targets 时这一整块跳过，产物与 v1 逐字节相同。
   */
  const prov = makeProvenance(input.issueId);
  let stages: PreResearchStages | undefined;
  const signalText = [input.title, input.material ?? ""].filter(Boolean).join("\n\n");

  let matched: Awaited<ReturnType<typeof matchTargets>> = { entities: [], hits: [], magnitude: "unknown" };
  // 预研 v3 不做外部核验：证据表恒空、`searchless` 恒真，这一轮的话全部是推理，屏幕上照实写。
  const verified = { evidence: [] as never[], searchless: true, groups: 0 };
  let blind = ruleBlindspot({ entities: [], hits: [], evidence: [], watched: [], magnitude: "unknown" });
  let v2Failed: string | null = null;
  const why = (e: unknown) => (e instanceof Error ? e.message : String(e));

  if (input.targets) {
    try {
      h.step(STEPS.match);
      matched = await matchTargets(h, {
        signalText,
        entities: [],
        targets: narrowTargets(
          [{ name: input.title, kind: "topic" }],
          input.targets.map((t) => ({ ...t })),
        ),
      });
      blind = ruleBlindspot({
        entities: matched.entities,
        hits: matched.hits,
        evidence: [],
        watched: input.watched ?? [],
        magnitude: matched.magnitude,
      });
    } catch (e) {
      matched = { entities: [], hits: [], magnitude: "unknown" };
      blind = ruleBlindspot({ entities: [], hits: [], evidence: [], watched: [], magnitude: "unknown" });
      v2Failed = `靶点匹配这一段没跑成：${why(e)}`;
      h.note("靶点匹配这一段没跑成", { why: v2Failed });
    }
  }

  h.step(STEPS.write);
  let raw = (
    await h.callMessages(
      "模型调用 · a3.pre-research",
      messages,
      { maxTokens: 4000 },
      callDetail,
      "a3.pre-research"
    )
  ).text;
  let doc = shape(raw, input, assembled);
  let violations = validatePreResearch(doc);
  let attempts = 1;

  /*
   * 第一轮的违规在这里就留下来，因为下面那个 while 会把 `violations` 覆盖掉。
   *
   * 只落最后一轮的话，台账上就只剩「重修都没救回来」那几条 —— 而绝大多数违规是
   * 第一轮犯、第二轮改对的，那部分全没了，「哪条规则老是被违反」也就答不出来。
   */
  const firstRoundViolations = violations.map(fmt);

  while (blocking(violations).length && attempts <= MAX_REPAIR) {
    messages.push({ role: "assistant", content: raw });
    messages.push({ role: "user", content: buildA3Repair(summarize(blocking(violations))) });
    // 序号不动，只在原话后面接一句轮次 —— 重修是这一步内部再跑一遍，不是第 3 步。
    h.substep(`重修第 ${attempts} 轮`);
    raw = (
      await h.callMessages(
        `模型调用 · a3.pre-research 重修第 ${attempts} 轮`,
        messages,
        { maxTokens: 4000 },
        { ...callDetail, repairOf: summarize(blocking(violations)) },
        "a3.pre-research"
      )
    ).text;
    doc = shape(raw, input, assembled);
    violations = validatePreResearch(doc);
    attempts += 1;
  }

  const cardViolations: Violation[] = [];
  const subject = (d: PreResearchDoc): CriticSubject => ({
    question: d.question,
    verdict: d.verdict ?? "",
    take: d.take,
    status: d.status,
    statusReason: d.statusReason,
    soWhat: d.soWhat,
    premises: d.premises ?? [],
  });

  /*
   * ---- 批判 → 裁决 → （至多一次）修正 ----
   *
   * 批判看的是预研结论本身（`CriticSubject`），不是影响提案。裁决是纯函数（`ruling.ts`），
   * 只有它定最终 status / statusReason / quality；批判打回「把给定前提当无依据」或「自相矛盾」
   * 时发一次有明确目标的修正，修完只跑机检、不再叫第二次批判。这一段**在 v1 / v2 两支都跑**：
   * 前提被否定这件事跟有没有靶点库无关。
   */
  h.step(STEPS.critic);
  let ruling: Ruling;
  {
    // `criticize` 自己接住模型层的失败；这里再接一层是防它之外的东西（桩、类型）——
    // 批判挂了不许拖死整轮，也不许被当成通过（`unavailable`）。
    const critic = await criticize(h, { doc: subject(doc), hits: matched.hits, evidence: [] }).catch(
      (e): PreResearchStages["critic"] => ({ pass: false, checks: [], why: [`批判那一次没跑成：${why(e)}`], modelSlot: null, unavailable: true })
    );
    ruling = rule({ status: doc.status, statusReason: doc.statusReason, critic, hits: matched.hits });
    if (ruling.repairAsk) {
      if (attempts <= MAX_REPAIR + 1) {
        messages.push({ role: "assistant", content: raw });
        messages.push({ role: "user", content: ruling.repairAsk });
        h.substep("按批判意见修正一次");
        try {
          raw = (
            await h.callMessages(
              "模型调用 · a3.pre-research 按批判修正",
              messages,
              { maxTokens: 4000 },
              { ...callDetail, repairOf: ruling.quality.notes.join("；") },
              "a3.pre-research"
            )
          ).text;
          const fixed = shape(raw, input, assembled);
          const fixedViolations = validatePreResearch(fixed);
          attempts += 1;
          const machine = machineChecks({ doc: subject(fixed), hits: ruling.hits, evidence: [] });
          const after = ruleAfterRepair({ status: fixed.status, statusReason: fixed.statusReason, before: ruling, machine });
          if (after.quality.state === "corrected") {
            doc = fixed;
            violations = fixedViolations;
          }
          ruling = after;
        } catch (e) {
          ruling = ruleUnrepaired(ruling, why(e));
        }
      } else {
        ruling = ruleUnrepaired(ruling, "质量门已经返修过两轮，这一轮不再发第三次");
      }
    }
    doc.status = ruling.status;
    doc.statusReason = ruling.statusReason;
    doc.quality = ruling.quality;
    matched = { ...matched, hits: ruling.hits };
    h.note("裁决", { state: ruling.quality.state, status: ruling.status, notes: ruling.quality.notes, hits: ruling.hits.length });
    if (ruling.quality.state === "needsCorrection" || ruling.quality.state === "criticUnavailable") {
      violations = [...violations, { rule: "S02-D", severity: "p1", message: `预研${ruling.quality.state === "criticUnavailable" ? "没过批判（批判没跑成）" : "没能通过批判"}：${ruling.quality.notes.join("；")}` }];
    }
  }

  if (input.targets && !v2Failed) {
    try {
      const impact = deriveImpact({ status: doc.status, verdict: doc.verdict ?? "", hits: matched.hits });
      const nowIso = new Date().toISOString();
      const disposition = suggestDisposition({
        impact, blindspot: blind, evidence: verified.evidence, nowIso, provenance: prov,
        hits: matched.hits,
      });
      const critic = { pass: ruling.quality.state === "ok" || ruling.quality.state === "corrected", checks: [], why: ruling.quality.notes, modelSlot: null } as PreResearchStages["critic"];
      const card = assembleCard({
        kind: input.prevStages ? "increment" : "full",
        impact, disposition, blindspot: blind, evidence: verified.evidence, critic,
      });
      cardViolations.push(...checkCard(card));
      stages = {
        entities: matched.entities,
        hits: matched.hits,
        blindspot: blind,
        evidence: verified.evidence,
        searchless: verified.searchless,
        impact,
        disposition,
        critic,
        card,
        priority: cardPriority({ hits: matched.hits, blindspot: blind, evidence: verified.evidence }),
      };
      doc.stages = stages;
    } catch (e) {
      cardViolations.length = 0;
      stages = undefined;
      doc.stages = undefined;
      v2Failed = `处置建议与提请卡这一段没跑成：${why(e)}`;
      h.note("处置建议与提请卡这一段没跑成", { why: v2Failed });
    }
  }
  violations = [...violations, ...cardViolations];
  if (v2Failed) {
    /*
     * p1：只记账，不挡门。理由见上面那段 —— 返修重跑的是写作，而这几段挂的是模型调用，
     * 重写一遍不会让它好起来；拿 p0 挡门等于把一份参谋判断完好的预研整个退回去。
     *
     * **今天这条只到运营台，还没上屏。** 待定区那张卡上没有「这一轮少做了什么」这一栏
     * （末节欠账第 12 条：这一层的产物大半还没上屏）。补那一栏之前，读卡的人看到的是
     * 一份「看起来正常、只是没有提请卡」的预研 —— 这一点必须有人知道。
     */
    violations = [...violations, { rule: "A3-18", severity: "p1", message: v2Failed }];
  }

  const degraded = blocking(violations).length > 0;
  return {
    doc,
    violations,
    attempts,
    degraded,
    ...(stages ? { stages } : {}),
    run: h.finish({
      status: "ok",
      input: input.title,
      output: doc as unknown as Record<string, unknown>,
      violations: violations.map(fmt),
      // 一轮就过时不落这个字段：全过的运行留一个空数组，和「没记」在统计时分不开。
      ...(attempts > 1 ? { firstRoundViolations } : {}),
      degraded,
    }),
  };
}

/*
 * 三个值之外的一律记 null，不猜。
 *
 * 猜成 `valid` 是这里最容易顺手做的事，也是最贵的：模型漏了这个字段，屏幕上就
 * 出现一份「参谋判它成立」的预研，而其实没人判过。null 会被质量门打回，打回两轮
 * 还没有就带着 p0 落在运营台上 —— 看得见，才修得掉。
 */
const STATUSES: PreResearchStatus[] = ["valid", "invalid", "reframing_needed"];

function toStatus(v: unknown): PreResearchStatus | null {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  return (STATUSES as string[]).includes(s) ? (s as PreResearchStatus) : null;
}

/**
 * 一号位给定的前提：只收 `quote` 逐字出自他输入（标题 + 递上来的原文）的那几条。
 * 引不到原话的丢掉 —— 那不是他给的，是模型补的。空白差异不算（原文里有换行、模型抄成空格）。
 */
export function toPremises(v: unknown, source: string): { text: string; quote: string }[] {
  if (!Array.isArray(v)) return [];
  const norm = (x: string) => x.replace(/\s+/g, "");
  const hay = norm(source);
  const out: { text: string; quote: string }[] = [];
  for (const item of v) {
    if (!item || typeof item !== "object") continue;
    const text = str((item as { text?: unknown }).text);
    const quote = str((item as { quote?: unknown }).quote);
    if (!text || !quote) continue;
    if (!hay.includes(norm(quote))) continue;
    out.push({ text, quote });
  }
  return out;
}

function shape(raw: string, input: A3Input, assembled: ManifestItem[]): PreResearchDoc {
  const j = parseJson<Raw>(raw);
  return {
    issueId: input.issueId,
    status: toStatus(j.status),
    statusReason: str(j.statusReason),
    verdict: str(j.verdict),
    premises: toPremises(j.premises, [input.title, input.material ?? ""].join("\n")),
    question: str(j.question),
    take: str(j.take),
    finding: toStatements(j.finding),
    openQuestion: toStatements(j.openQuestion),
    soWhat: str(j.soWhat),
    byAgentLabel: "您的 Agent",
    // 拷一份，和 A4 的 `shape()` 同一规矩：产出不该跟着调用方那个数组一起变。这条路上
    // 今天所有 push 都发生在调用之前，但两处规则不一致的话，下一个人只会照抄错的那边。
    assembledFrom: [...assembled],
    // 这个时间戳会被 store 覆盖（store.ts ensurePreResearch 回调里），
    // store 才是时间戳的权威（它有日期锁和单调闸）。
    at: new Date().toISOString(),
  };
}
