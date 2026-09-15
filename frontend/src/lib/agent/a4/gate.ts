/**
 * 出口闸与引用绑定。**确定性的，不调模型。**
 *
 * 报告写完先过这里，过不去就带着违规原话重写一轮（`run.ts` 里那一轮）。这是最后一道
 * 能救回来的地方 —— 压成四节之后再发现引用绑不上，改四节也救不了报告。
 *
 * ## 引用由代码绑，模型只写编号
 *
 * 模型写 `[E3]`，代码把 E3 换成来源与地址。**不许模型手写 URL**：手写的 URL 有两种
 * 结局，一种是编的（点开 404），一种是记忆里的旧地址（点开是另一篇）。两种都比没有
 * 链接糟 —— 没有链接的时候人会去查，有一个假链接的时候人不会。
 *
 * `[reference:N]` 这类占位符同理，一律当没绑定处理。
 */

import type { ManifestItem, ResearchDoc, Statement, Trace } from "@/lib/data/types";
import type { Violation } from "@/lib/agent/rules";
import { recompute, type Calculation } from "@/lib/research/calc";
import type { Evidence, Ledger } from "@/lib/research/ledger";

import type { ScopeQuestionTrace } from "./dims";
import type { Verdict } from "./props";

/** 正文里的证据编号。`[E3]`、`[E3, E7]`、`[E3][E7]` 都要认出来。 */
const CITE = /\[E(\d+)(?:\s*[,，]\s*E?(\d+))*\]/g;
/** 单个编号，用于从一段 `[E3, E7]` 里逐个取。 */
const CITE_ID = /E?(\d+)/g;
/** 裸地址。模型手写的 URL 一律不许出现（HP-2）。 */
const BARE_URL = /https?:\/\/[^\s）)】」]+/;
/** 占位符式引用。真实发生过：正文里留着 `[reference:4]` 就发出去了。 */
const PLACEHOLDER = /\[(reference|ref|citation)\s*[:：]?\s*\d+\]/i;
/** 「未能核实」那一节的标题词。终态命题必须在这里出现。 */
const UNVERIFIED_HEAD = /(未能核实|没能核实|未核实|查不到|未能取证)/;

/** 报告里引到的证据编号（去重、按出现顺序）。 */
export function citedIds(report: string): string[] {
  const out: string[] = [];
  for (const m of report.matchAll(CITE)) {
    for (const one of m[0].matchAll(CITE_ID)) {
      const id = `E${one[1]}`;
      if (!out.includes(id)) out.push(id);
    }
  }
  return out;
}

/**
 * 报告那一层的出口闸。**返回的 p0 会触发一轮重写。**
 *
 * `hasEvidence` 为 false（本轮没联网或一条都没入账）时，只查裸地址与占位符 ——
 * 其余几条在没有台账的情况下无从判定，硬判会让每次未联网的运行都挂着一堆假违规。
 *
 * @param allowedOutsideLedger 台账之外也算认得的编号。区块那一支递的是那份报告自己
 *   证据表里**模型既有知识**那几条（`origin === "model"`）—— 那是区块契约明写允许的一类：
 *   模型可以用自己的记忆，条件是把它单列出来、标成没核实过（`registry.ts` 的 HP-2）。
 *   不递的话 A4-G02 会把这几个编号判成「台账里没有的编号」，而区块那一支的正文面是从块
 *   折出来的、这条 p0 也带不动一轮重写 —— 于是每一份合规的报告都永久挂着一条假违规。
 *   散文那一支不递：那边没有这个机制，正文里出现台账外的编号就是编的。
 */
export function gateReport(
  report: string,
  ledger: Ledger,
  verdicts: Verdict[],
  allowedOutsideLedger: string[] = []
): { violations: Violation[]; calculations: Calculation[] } {
  const v: Violation[] = [];
  const p0 = (rule: string, message: string) => v.push({ rule, severity: "p0", message });
  const p1 = (rule: string, message: string) => v.push({ rule, severity: "p1", message });
  const body = report ?? "";

  // ---- 一律要查的两条 ----------------------------------------------------
  const bare = BARE_URL.exec(body);
  if (bare) {
    p0("A4-G01", `正文里出现了手写的地址「${bare[0].slice(0, 60)}」。引用只写 [E编号]，地址由系统绑。`);
  }
  if (PLACEHOLDER.test(body)) {
    p0("A4-G01", "正文里留着 [reference:N] 这类占位符 —— 那不是引用，点不开也核不了。");
  }

  const entries = ledger.entries;
  const calculations = recompute(body, entries);
  for (const c of calculations) {
    // 算术站不住是能改的，所以是 p0：要么改数，要么说明这两个数不同口径本来不可比。
    // 占比加总那一类例外：它的假警报都是分母不同（R-10、ISS-232），和 `audit.ts` 一样降 p1。
    if (c.kind === "share_sum") p1("A4-G05", `复算不通过（${c.kind}）：${c.note}`);
    else p0("A4-G05", `复算不通过（${c.kind}）：${c.note}`);
  }

  if (!entries.length) return { violations: v, calculations };

  // ---- 引用要能解析 -------------------------------------------------------
  const cited = citedIds(body);
  const allowed = new Set(allowedOutsideLedger);
  const unknown = cited.filter((id) => !ledger.byId(id) && !allowed.has(id));
  if (unknown.length) {
    p0("A4-G02", `正文引了台账里没有的编号 ${unknown.join("、")}。只能引台账里真实存在的那些。`);
  }
  if (!cited.length) {
    p0("A4-G02", `台账里有 ${entries.length} 条证据，正文一条都没引 —— 事实性数字必须绑到 [E编号] 上。`);
  }

  // ---- 反证必须被应答（CH-4）---------------------------------------------
  const refutes = entries.filter((e) => e.supportRelation === "refutes");
  const silent = refutes.filter((e) => !cited.includes(e.id));
  if (silent.length) {
    p0(
      "A4-G03",
      `台账里有 ${silent.length} 条反向证据没有出现在正文里（${silent.map((e) => e.id).join("、")}）。` +
        "指向相反方向的证据必须在「什么会推翻这个判断」那一节里被回应，沉默不是选项。"
    );
  }

  // ---- 没核实的要说出来（HP-5）------------------------------------------
  const terminals = verdicts.filter((x) => x.terminal);
  if (terminals.length && !UNVERIFIED_HEAD.test(body)) {
    p0(
      "A4-G04",
      `有 ${terminals.length} 条命题本轮没能闭合（${terminals.map((x) => x.propositionId).join("、")}），` +
        "报告里没有「未能核实」这一节。查不到是合法结果，但必须写出来。"
    );
  }

  // ---- 引到的证据要真撑得起（只记不挡）-----------------------------------
  /*
   * 引句本身在入账时已经过了定位（`ledger.record`），所以这里不重做定位。这一条查的
   * 是另一件事：**引了一条只是「限定」或「反驳」的证据来当支持**。它需要读上下文才能
   * 判准，确定性代码只能给出提示，所以是 p1。
   */
  const qualifiers = cited
    .map((id) => ledger.byId(id))
    .filter((e): e is Evidence => !!e && e.supportRelation === "qualifies");
  if (qualifiers.length) {
    p1(
      "A4-G06",
      `正文引了 ${qualifiers.map((e) => e.id).join("、")}，这几条在台账里记的是「限定」而不是「支持」——` +
        "确认一下它们是被当成限定条件用的，不是被当成依据用的。"
    );
  }

  return { violations: v, calculations };
}

/* -------------------------------------------------------------------------- */
/* 任务范围那一层的出口检查                                                     */
/* -------------------------------------------------------------------------- */

/**
 * 「外面没有这个东西」这类断言。
 *
 * 这几个说法是**只有搜过才有资格说的话**。刻意写窄：宁可漏掉几种说法，也不要把「我们
 * 没查到」这种已经说对了的句子判成违规 —— 那会逼着重写一稿去改一句本来就对的话。
 */
const CLAIMS_NONEXISTENT =
  /(未见任何公开|没有任何公开|不存在公开|公开(渠道|材料|信息|资料)[^。；\n]{0,8}(均未|均没有|没有|不存在)|外界(没有|不存在)|市场上(没有|不存在))/;

/**
 * 任务范围那一层的出口检查。**读的是 `sweep` 交回来的那份关键问题 trace。**
 *
 * 和 `gateReport` 分成两个函数，因为它们的输入不同（那一个读台账和命题判定，这一个读
 * 任务范围），而合成一个的话没有 trace 的调用点要传一个空数组来表示「不查」—— 而「不查」
 * 和「查了没问题」在返回值上长得一模一样。
 *
 * ## 为什么只有一条是 p0
 *
 * p0 会触发一轮重写（`run.ts`），而重写救得回来的只有**措辞**：一条问题没搜过就是没搜过，
 * 再写一稿也不会让它变成搜过。所以「没搜」本身记 p1（它进报告文首那份机检清单，读的人
 * 看得见这一轮欠了什么），**只有「把没搜写成外界不存在」是 p0** —— 那一条重写真能改对，
 * 而且它正是 ISS-239 那一轮最贵的一处错。
 */
export function gateScope(report: string, trace: readonly ScopeQuestionTrace[]): Violation[] {
  const v: Violation[] = [];
  const body = report ?? "";

  const unsearched = trace.filter((t) => t.status === "未搜");
  const keyUnsearched = unsearched.filter((t) => t.changesChoice);

  if (unsearched.length && CLAIMS_NONEXISTENT.test(body)) {
    const hit = CLAIMS_NONEXISTENT.exec(body)?.[0] ?? "";
    v.push({
      rule: "A4-G07",
      severity: "p0",
      message:
        `正文里写了「${hit}」这类「外面没有」的话，而这一轮有 ${unsearched.length} 条关键问题的状态是**未搜**` +
        `（${unsearched.map((t) => t.id).join("、")}）—— 没搜过不等于外界不存在。` +
        "改成「本轮没有检索到」或「这一轮没查」，或者把它挪到「未能核实」那一节去。",
    });
  }

  for (const t of keyUnsearched) {
    v.push({
      rule: "A4-G08",
      severity: "p1",
      message:
        `${t.id}「${t.question}」会改变选哪条路线（关联路线 ${t.routeIds.join("、") || "未挂"}），` +
        `而这一轮没搜过：${t.why}`,
    });
  }

  for (const t of trace.filter((x) => x.status === "不适用")) {
    v.push({
      rule: "A4-G09",
      severity: "p1",
      message:
        `${t.id}「${t.question}」的答案在我方内部材料或客户那里，外网查不到 —— ` +
        "报告里要写成「需要内部材料或客户确认」，不要写成一条外部结论，也不要再派检索去补。",
    });
  }

  return v;
}

/* -------------------------------------------------------------------------- */
/* 引用绑定                                                                    */
/* -------------------------------------------------------------------------- */

/** 一条台账条目的溯源标签。档次写进去 —— 「A 级」和「D 级」的分量不一样。 */
function label(e: Evidence): string {
  const who = (e.siteName || e.sourceDomain).slice(0, 40);
  return `${who} · ${e.sourceTier} 级`;
}

function traceOf(e: Evidence): Trace {
  return { kind: "ext", source: label(e), href: e.url };
}

/**
 * 把四节里的 `[E#]` 换成溯源。**编号从正文里摘掉，链接挂到 traces 上。**
 *
 * 屏幕上留着 `[E3]` 对读的人没有意义 —— 他要的是能点开的那一下。所以标记只在报告
 * 原文里留着（那份是可署名分发的原件，编号在那里是引用体系的一部分）。
 */
export function bindCitations(doc: ResearchDoc, ledger: Ledger): number {
  let bound = 0;
  const fix = (s: Statement): Statement => {
    const ids = citedIds(s.text);
    if (!ids.length) return s;
    const traces = [...(s.traces ?? [])];
    for (const id of ids) {
      const e = ledger.byId(id);
      if (!e) continue;
      if (traces.some((t) => t.href === e.url)) continue;
      traces.push(traceOf(e));
      bound += 1;
    }
    return { ...s, text: s.text.replace(CITE, "").replace(/\s{2,}/g, " ").trim(), traces };
  };
  doc.judgment = doc.judgment.map(fix);
  doc.keyEvidence = doc.keyEvidence.map(fix);
  doc.counters = doc.counters.map(fix);
  doc.unknowns = doc.unknowns.map(fix);
  return bound;
}

/**
 * 台账条目变成溯源清单里的可点条目。
 *
 * 带 `href` 的条目屏幕上是能点开的 —— 一句「带了 4 项 Context」如果点不开，读者只能
 * 选择相信或不相信，那就不是证明。
 */
export function evidenceManifest(ledger: Ledger): ManifestItem[] {
  return ledger.entries.map((e) => ({
    label: `${e.id} · ${label(e)} · ${e.claim.slice(0, 40)}`,
    href: e.url,
    kind: "ext" as const,
  }));
}
