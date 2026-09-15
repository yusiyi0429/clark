import type { Harness } from "@/lib/agent/harness";
import { parseJson } from "@/lib/agent/json";
import { checkVerdict } from "@/lib/agent/talk/verifier";
import { overclaim } from "@/lib/agent/rules";
import { areIndependent, resolveModel, type Slot } from "@/lib/models/slots";
import { ABSENCE_AS_REASON } from "./validate";
import { A3_CRITIC_SYSTEM } from "./prompt";
import type { CriticCheck, CriticVerdict, EvidenceLite, TargetHit } from "./stages";

/** 批判读的那份预研结论 —— `PreResearchDoc` 的几个字段，不带溯源和材料。 */
export type CriticSubject = {
  question: string;
  verdict: string;
  take: string;
  status: "valid" | "invalid" | "reframing_needed" | null;
  statusReason: string;
  soWhat: string;
  premises: readonly { text: string; quote: string }[];
};

/**
 * 机械可判的那几件事。**机检在前不只是省钱**：它让「这几类问题一定被拦住」
 * 成为一条机械保证，而不是对模型的期望 —— 这是 `talk/verifier.ts` 已经在跑的姿态。
 *
 * 2026-09-05 起批判的对象是**预研结论本身**，不再是影响提案（那一步已撤，见 `impact.ts`
 * 的 `deriveImpact`）。机检三条：
 * - `premiseDenied`：判 invalid 而理由是「本体/上下文没有记录」（`ABSENCE_AS_REASON`）。
 * - `contradiction`：判 invalid 而 soWhat 在说值得升级（S02-A 同款，这里再拦一道给裁决用）。
 * - `overclaim`：verdict / take 里无依据的绝对化（p1，只留痕）。
 * `targetMismatch` 机检判不了（要读语义），交给模型。
 */
export function machineChecks(o: {
  doc: CriticSubject;
  hits: readonly TargetHit[];
  evidence: readonly EvidenceLite[];
}): { checks: CriticCheck[]; why: string[] } {
  const checks: CriticCheck[] = [];
  const why: string[] = [];
  const reason = o.doc.statusReason.trim();
  if (o.doc.status === "invalid" && ABSENCE_AS_REASON.test(reason)) {
    checks.push("premiseDenied");
    why.push(`判 invalid 的理由是材料状态（「${reason.slice(0, 40)}」），不是议题的问题 —— 一号位给定的事实被当成了无依据`);
  }
  if (o.doc.status === "invalid" && /值得(升级|深研|继续|投入)/.test(o.doc.soWhat) && !/不值得/.test(o.doc.soWhat)) {
    checks.push("contradiction");
    why.push("判了 invalid，结尾却在说值得升级");
  }
  const over = [...overclaim(o.doc.verdict, "verdict"), ...overclaim(o.doc.take, "take")];
  if (over.length > 0) {
    checks.push("overclaim");
    why.push(...over.map((v) => v.message));
  }
  void o.evidence;
  return { checks, why };
}

const CHECKS: readonly CriticCheck[] = ["evidenceThin", "overclaim", "targetMismatch", "premiseDenied", "contradiction"];
const readChecks = (raw: unknown): CriticCheck[] =>
  Array.isArray((raw as { checks?: unknown })?.checks)
    ? ((raw as { checks: unknown[] }).checks.filter((x): x is CriticCheck => typeof x === "string" && (CHECKS as string[]).includes(x)))
    : [];

/**
 * 轻量批判。
 *
 * 机检报了**要返修的那一类**（premiseDenied / contradiction）就直接打回，一次模型都不叫，
 * `modelSlot` 记 `null` —— 台账上不许把机检定的事记成模型判的。机检过了才叫模型，而且叫的是
 * **异系那一格**：主链是 `pro`（DeepSeek）时优先 `synth`（gpt-5.6，首包 1.8 秒）而不是 `alt`
 * （Claude，网宿上首包 80 秒）—— 预研要在 90 秒内交出来，这一步等不起。
 *
 * 模型调用失败或返回读不出：`unavailable: true`，`pass: false`。**这不是打回，是没判**，
 * 裁决层把它落成 `criticUnavailable`，屏幕上照实显示，不能当通过。
 */
export async function criticize(
  h: Harness,
  o: {
    doc: CriticSubject;
    hits: readonly TargetHit[];
    evidence: readonly EvidenceLite[];
  },
): Promise<CriticVerdict> {
  const machine = machineChecks(o);
  const blocking = machine.checks.filter((c) => c === "premiseDenied" || c === "contradiction");
  if (blocking.length > 0) {
    return { pass: false, checks: machine.checks, why: machine.why, modelSlot: null };
  }
  if (machine.checks.includes("overclaim")) {
    h.note("结论说得太满（p1，只留痕不返修）", { why: machine.why });
  }
  const criticSlot: Slot = h.slot === "pro" ? "synth" : "pro";
  const mainConfig = resolveModel(h.slot);
  const criticConfig = resolveModel(criticSlot);
  if (mainConfig && criticConfig && !areIndependent(mainConfig, criticConfig)) {
    h.note("异系批判变同系", {
      mainSlot: h.slot, mainFamily: mainConfig.family,
      criticSlot, criticFamily: criticConfig.family,
      note: "两边解出的是同一个 family —— 这一次批判其实不异系",
    });
  }
  const d = o.doc;
  const userMsg = `## 这一轮预研要回答的
${d.question}

## 一号位给定的前提（他自己写在议题里的，不是查出来的）
${d.premises.length ? d.premises.map((p) => `- ${p.text}（原话：「${p.quote}」）`).join("\n") : "（没有抽出前提）"}

## 预研的结论
status：${d.status ?? "（没给）"}
statusReason：${d.statusReason || "（空）"}
verdict：${d.verdict || "（空）"}
take：
${d.take}
soWhat：${d.soWhat}

## 挂上的既有判断
${o.hits.length ? o.hits.map((x) => `- ${x.target.id}｜${x.match}｜${x.target.text}（${x.why}）`).join("\n") : "（没挂上）"}`;
  let r: { text: string };
  try {
    r = await h.callMessages(
      "模型调用 · a3.critic",
      [
        { role: "system", content: A3_CRITIC_SYSTEM },
        { role: "user", content: userMsg },
      ],
      { slot: criticSlot, maxTokens: 2000 },
      { promptKey: "a3.critic", criticSlot, mainSlot: h.slot },
      "a3.critic",
    );
  } catch (e) {
    return {
      pass: false, checks: machine.checks, unavailable: true, modelSlot: criticSlot,
      why: [...machine.why, `批判那一次没跑成：${e instanceof Error ? e.message : String(e)}`],
    };
  }
  let parsed: unknown;
  try {
    parsed = parseJson<unknown>(r.text);
  } catch {
    return { pass: false, checks: machine.checks, unavailable: true, why: [...machine.why, "批判返回的不是合法 JSON"], modelSlot: criticSlot };
  }
  const checked = checkVerdict(parsed, criticSlot);
  if (!checked.ok) {
    return { pass: false, checks: machine.checks, unavailable: true, why: [...machine.why, ...checked.review.why], modelSlot: criticSlot };
  }
  const modelChecks = readChecks(parsed);
  // 机检那几条（这里只可能是 p1 的「说得太满」）要跟着结论一起交出去，
  // 不然它就只活在 trace 里，屏幕上看不到。
  return {
    pass: checked.value.pass,
    checks: [...new Set([...machine.checks, ...modelChecks])],
    why: [...machine.why, ...checked.value.why],
    modelSlot: criticSlot,
  };
}
