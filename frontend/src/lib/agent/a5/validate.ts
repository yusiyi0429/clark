/**
 * A5 判断生成的确定性质量门。**不调模型。**
 *
 * 和 A3/A4 的质量门一样，这一层只回答一个问题：**这份东西的形状对不对。**
 * 「这条判断对不对」不在这里 —— 那正是一号位要做的事，而这个产品的整个设计就是
 * 不替他做（见 `ConfirmChannel`）。所以这里没有第二个模型来冲判断：深研那一份已经
 * 被独立第二源冲过了，判断这一层的裁判是人。
 *
 * 规则号从 A5-01 起，和 rubric 里 A3/A4 那两组并列；G-* 与 FE-* 走 `rules.ts` 共用的。
 */
import type { DraftJudgement } from "@/lib/data/types";
import { chars, commonViolations, overclaim, SELF_CONFIRMED, VAGUE_REOPEN, type Violation } from "@/lib/agent/rules";

export type { Violation } from "@/lib/agent/rules";
export { blocking, summarize } from "@/lib/agent/rules";

export function validateJudgements(items: DraftJudgement[]): Violation[] {
  const v: Violation[] = [];
  const push = (rule: string, severity: "p0" | "p1", message: string) =>
    v.push({ rule, severity, message });

  // ---- 条数 --------------------------------------------------------------
  // A5-01：一条都没有不是「这份报告没法下判断」——报告里连总口径都有，收不出一条
  // 判断说明这一步没做。上限 5 条挡的是「把报告每一句都抄成一条判断」。
  if (items.length < 2 || items.length > 5) {
    push("A5-01", "p0", `判断应为 2–5 条，实际 ${items.length} 条。`);
  }

  items.forEach((it, idx) => {
    const n = idx + 1;

    // ---- 五个字段都得有 --------------------------------------------------
    if (!it.label.trim()) push("A5-02", "p0", `第 ${n} 条没有短标签。`);
    else if (chars(it.label) > 14) {
      // p1：标签长了只是难扫，不是错。
      push("A5-02", "p1", `第 ${n} 条标签 ${chars(it.label)} 字，超过 14 字 —— 它是扫一眼用的。`);
    } else if (/^(判断|Judgment)\s*[一二三四五1-5]?$/.test(it.label.trim())) {
      push("A5-02", "p1", `第 ${n} 条标签「${it.label}」没有信息，说不出它管哪一块。`);
    }

    /*
     * A5-03 判断正文太短。
     *
     * 这条判断将来会被单独摘出去用（写进材料、发给 DRI、进本体），所以「应重视
     * AI 安全」这种长度的句子一离开这块屏幕就废了。40 字不是文风要求，是「能不能
     * 被单独引用」的下限。
     */
    const sc = chars(it.statement);
    if (sc < 40) push("A5-03", "p0", `第 ${n} 条判断只有 ${sc} 字，单独摘出去没法读懂。`);
    else if (sc > 260) push("A5-03", "p1", `第 ${n} 条判断 ${sc} 字，长到不像一句口径。`);

    // A5-04：没有依据的判断没法被确认 —— 他要表态，第一步看的就是凭什么。
    if (chars(it.basis) < 20) push("A5-04", "p0", `第 ${n} 条判断依据缺失或过短，没法核。`);
    if (/^(综合|基于)(研究|报告|以上|上述)/.test(it.basis.trim())) {
      push("A5-04", "p1", `第 ${n} 条判断依据是一句复述（「${it.basis.slice(0, 12)}…」），没点到具体事实。`);
    }

    // A5-05：没有边界的判断会被当成比它实际更强的东西用。
    if (chars(it.boundary) < 10) push("A5-05", "p0", `第 ${n} 条没有写当前边界。`);
    else if (!/(不|尚|暂|未|限于|仅|只)/.test(it.boundary)) {
      push("A5-05", "p1", `第 ${n} 条的边界没说清它「不主张什么」。`);
    }

    // A5-06：重开条件是这条判断将来被推翻的入口。写不出条件就是没有入口。
    if (chars(it.reopenIf) < 10) push("A5-06", "p0", `第 ${n} 条没有写重开条件。`);
    else if (VAGUE_REOPEN.test(it.reopenIf.trim())) {
      push("A5-06", "p0", `第 ${n} 条的重开条件「${it.reopenIf.slice(0, 14)}…」不是条件，写不出「什么东西出现」。`);
    }

    // ---- 溯源 ------------------------------------------------------------
    // A7-01 与 A3/A4 同号：判断是从报告里读出来的，指不回去就没法核。
    if (!it.traces.length) push("A7-01", "p0", `第 ${n} 条判断没有溯源。`);

    // ---- 越过那道确认 ----------------------------------------------------
    const whole = [it.statement, it.basis, it.boundary, it.reopenIf].join("\n");
    if (SELF_CONFIRMED.test(whole)) {
      push("A5-07", "p0", `第 ${n} 条自称已经被确认或已成公司口径 —— 这一步只产候选，确认只能由他按下。`);
    }

    // ---- 回指 ------------------------------------------------------------
    // 「上述方案」这类词让判断只在这块屏幕上成立，而它一定会被单独引用出去。
    if (/(上述|前述|该方案|这件事|如前所[说述]|上面提到)/.test(it.statement)) {
      push("A5-08", "p1", `第 ${n} 条判断里有回指（「上述」「该方案」这类），单独摘出去就读不懂了。`);
    }
  });

  // ---- 判断之间不许重复 --------------------------------------------------
  /*
   * A5-09。判据取正文前 20 字，和板上去重（前 30 字）不是同一个数：这里要挡的是
   * 「一件事写成两条」，比板上那道去重更早、更松一点。真让它上了板，去重会把后一条
   * 静默丢掉，表现成「这次只生成了两条」——原因看不见。
   */
  const key = (t: string) => t.replace(/\s/g, "").slice(0, 20);
  const seen = new Map<string, number>();
  items.forEach((it, idx) => {
    const k = key(it.statement);
    const first = seen.get(k);
    if (first !== undefined) {
      push("A5-09", "p1", `第 ${idx + 1} 条和第 ${first} 条开头一样，是同一件事写了两遍。`);
    } else seen.set(k, idx + 1);
  });
  const labels = new Map<string, number>();
  items.forEach((it, idx) => {
    const k = it.label.trim();
    if (!k) return;
    const first = labels.get(k);
    if (first !== undefined) push("A5-09", "p1", `第 ${idx + 1} 条和第 ${first} 条标签相同（「${k}」）。`);
    else labels.set(k, idx + 1);
  });

  // ---- 全局 --------------------------------------------------------------
  const all = items
    .map((it) => [it.label, it.statement, it.basis, it.boundary, it.reopenIf].join("\n"))
    .join("\n");
  v.push(...commonViolations(all, "判断"));
  v.push(...overclaim(all, "判断"));

  return v;
}
