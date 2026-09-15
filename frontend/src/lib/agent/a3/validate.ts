/**
 * A3 Pre-research 的确定性质量门。**不调模型。**
 *
 * 规则来自 tkos_quality_rubric_v0.1.yaml 的 A3 组里 kind=deterministic 的那些，
 * 加上前端渲染带来的两条硬约束。每条都标了 rubric 编号，改规则时两边一起改。
 *
 * 为什么这一层必须存在：CQ101 §04 的要求里有一半是可数的（Key Takeaway 几句、
 * Evidence 几块、有没有回到去留判断）。**这些绝不能靠 prompt 祈祷** —— 写进
 * prompt 然后指望模型每次都数对，是这类项目最常见的失败。可数的就去数。
 *
 * 违反 p0 的直接打回重生成；p1 只记，不挡。
 */
import type { PreResearchDoc, Statement } from "@/lib/data/types";
import {
  CATEGORY_HEAD,
  chars,
  commonViolations,
  isRhetorical,
  overclaim,
  paragraphs,
  sentences,
  type Violation,
} from "@/lib/agent/rules";

export type { Violation } from "@/lib/agent/rules";

const traceOk = (t: Statement) => Array.isArray(t.traces) && t.traces.length > 0;

/**
 * 「本体/上下文里没有」这一类理由的形状。判 invalid 时撞上它是 S02-C p0。
 * 不要把它写得太宽：「公开信息里查不到该公司有此产线」是外部事实层的理由，允许。
 */
export const ABSENCE_AS_REASON =
  /(上下文|本体|公司(决策)?上下文|已有材料|现有材料|本轮)[^。；]{0,12}(没有|无|缺乏|未)[^。；]{0,8}(记录|证据|依据|信息|表明|提及|查到|核实|接触痕迹)/;

export function validatePreResearch(doc: PreResearchDoc): Violation[] {
  const v: Violation[] = [];
  const push = (rule: string, severity: "p0" | "p1", message: string) => v.push({ rule, severity, message });

  // ---- status（方法域 S02 的 Phase A）----------------------------------
  //
  // 这一组是**一致性检查**，不是措辞检查：status 是屏幕和统计要用的字段，soWhat 是
  // 一号位读到的那一句。两者打架的时候，屏幕上会出现「参谋判它不值得」压着一句
  // 「值得升级」—— 而这种自相矛盾模型自己看不出来，因为两句单独看都通顺。
  const status = doc.status;
  const reason = (doc.statusReason ?? "").trim();
  if (status === null) {
    push("S02-A", "p0", "没给这一轮的定性结论（status 只能是 valid / invalid / reframing_needed）。");
  }
  if (status !== null && status !== "valid" && !reason) {
    push("S02-A", "p0", `判了 ${status} 却没说理由；这一句要说清哪一处不对。`);
  }
  if (status === "valid" && reason) {
    push("S02-A", "p1", "status 是 valid 就不需要 statusReason，这一句屏幕上不会显示。");
  }
  /*
   * S02-C（2026-09-05）：**「本体没记录」不是议题不成立的理由。** ISS-224 把一号位自己写的
   * 「我们的第一个客户是维信诺」判成 invalid，理由是「当前上下文没有任何证据表明该公司已与维信诺
   * 接触」。这类理由说的是材料状态，不是议题的问题；作为 p0 打回，让它重写成议题本身的理由，
   * 或者改判 valid / reframing_needed。
   */
  if (status === "invalid" && ABSENCE_AS_REASON.test(reason)) {
    push(
      "S02-C",
      "p0",
      "判 invalid 的理由是「上下文/本体没有记录、本轮没查到」—— 那是材料状态，不是议题不成立的理由。" +
        "一号位在议题里给定的事实是前提，不能用本体缺失否定；要么给出议题本身的问题，要么改判。"
    );
  }

  // ---- verdict（一针见血那一句，2026-09-05）------------------------------
  const verdict = (doc.verdict ?? "").trim();
  if (!verdict) push("A3-20", "p0", "没有 verdict —— 屏幕上最大的那一句是空的。");
  else if (chars(verdict) > 60) push("A3-20", "p1", `verdict ${chars(verdict)} 字，超过 40 字就不是一句话了。`);
  else if (/(进一步研究|有待观察|持续关注|视情况)/.test(verdict)) {
    push("A3-20", "p0", "verdict 没有立场（「进一步研究」「有待观察」）—— 它必须先判值不值得。");
  }

  // ---- take ----------------------------------------------------------
  const paras = paragraphs(doc.take ?? "");
  const body = paras.filter((p) => !isRhetorical(p));
  const rhetorical = paras.filter(isRhetorical);
  const n = body.reduce((a, p) => a + sentences(p).length, 0);

  // A3-01 3–4 句。反问不计入 —— 它是独立的一段，不是 Key Takeaway 的一部分。
  if (n < 3 || n > 4) {
    push("A3-01", "p0", `Key Takeaway 应为 3–4 句（不含反问），实际 ${n} 句。`);
  }
  if (rhetorical.length > 1) {
    // instructions.ts：反问一次只问一句，连着问三句那是审问不是参谋。
    push("A6-01", "p0", `反问只能有一段，实际 ${rhetorical.length} 段。`);
  }
  if (rhetorical.some((p) => sentences(p).length > 1)) {
    push("A6-01", "p0", "反问一次只问一句。");
  }
  if (!doc.take?.trim()) push("A3-03", "p0", "Key Takeaway 是空的。");

  // 前端 AgentText 按空行分段、逐段渲染纯文本 —— markdown 会原样显示成星号井号。
  if (/\*\*|^#{1,6}\s|^[-*]\s/m.test(doc.take ?? "")) {
    push("FE-md", "p0", "take 里有 markdown 记号；屏幕不渲染 markdown，会原样显示。");
  }

  // ---- finding（Evidence block）---------------------------------------
  const f = doc.finding ?? [];
  // A3-04 取 2–4：正文写「2–3 个」而标准表与 §09 checklist 都写「2–4 个」，
  // 两处对一处。见 rubric open_questions.Q1。
  if (f.length < 2 || f.length > 4) {
    push("A3-04", "p0", `Evidence block 应为 2–4 个，实际 ${f.length} 个。`);
  }
  f.forEach((s, i) => {
    if (!traceOk(s)) push("A3-13", "p0", `第 ${i + 1} 个 Evidence 没有溯源。`);
    if (CATEGORY_HEAD.test(s.text.split(/[，。：:]/)[0] ?? "")) {
      push("A3-05", "p1", `第 ${i + 1} 个 Evidence 以分类词开头，应该直接写 synthesis。`);
    }

    /*
     * S02-B：方法域 S02 §5.1 要求每条 Evidence 带一句判断式短标题。
     *
     * **少一句短标题是 p0，不是 p1。** 它不是排版偏好：屏幕上这几条是一号位扫得最快的
     * 地方，短标题是他决定要不要读下面那句的唯一依据。缺了之后这一栏退化成三段等长的
     * 灰字，而这件事在结果页上看起来一切正常 —— 正是必须由这一层来数的那种。
     *
     * 「是不是判断而不是类目名」数不出来，所以这里只数三件能数的：有没有、是不是
     * 分类词、有没有长到不像标题。剩下那件写在 prompt 里（见 `A3_SYSTEM` 的
     * 「finding 怎么写」）。
     */
    const label = (s.label ?? "").trim();
    if (!label) {
      push("S02-B", "p0", `第 ${i + 1} 个 Evidence 没有判断式短标题（label 字段）。`);
      return;
    }
    if (CATEGORY_HEAD.test(label.replace(/[。，、；;]+$/, ""))) {
      push("S02-B", "p1", `第 ${i + 1} 个 Evidence 的短标题「${label}」是类目名，不是判断。`);
    }
    if (chars(label) > 20) {
      // 它在屏幕上是加粗后接着正文往下读的一句，长了就不是标题而是第一句话。
      push("S02-B", "p1", `第 ${i + 1} 个 Evidence 的短标题 ${chars(label)} 字，超过 20 字就不像标题了。`);
    }
  });

  // ---- openQuestion ---------------------------------------------------
  const q = doc.openQuestion ?? [];
  if (q.length === 0) {
    // CQ101 §04：Key Takeaway 必须连上「关键不确定性」，一条都没有说明没在做预研。
    push("A3-02", "p0", "没有列出这一轮答不上来的问题。");
  }
  q.forEach((s, i) => {
    if (!traceOk(s)) push("A3-13", "p1", `第 ${i + 1} 个未答问题没有标注来源。`);
  });

  // ---- soWhat ---------------------------------------------------------
  const so = doc.soWhat ?? "";
  if (!so.trim()) push("A3-11", "p0", "结尾没有回到「值不值得继续」。");
  else if (!/(升级|值得|不值得|不足|继续|搁置|观察)/.test(so)) {
    push("A3-11", "p0", "结尾没有落在去留判断上，只是内容总结。");
  }
  if (sentences(so).length > 2) push("A3-11", "p1", "结尾超过两句；它应该是一句判断。");

  // status 与 soWhat 的一致性。两句单独看都通顺，所以只能靠这里对。
  if (status === "invalid") {
    /*
     * 前面那个否定字要看 —— 「不值得升级」里含着「值得升级」，不看的话一份判得
     * 完全正确的 invalid 反而被打回，而正确的写法只有这一种。
     */
    if (/(?<![不没未难])(值得升级|值得继续|应当升级|建议升级)/.test(so)) {
      push("S02-A", "p0", "判了 invalid，结尾却在说值得升级 —— 两句自相矛盾。");
    } else if (!/(不值得|不足|搁置|暂不|先不)/.test(so)) {
      push("S02-A", "p0", "判了 invalid，结尾要落在「不值得继续」上。");
    }
  }
  if (status === "reframing_needed" && !/(说法|框架|问错|重新框|重新定义|改题)/.test(so)) {
    // 屏幕上会显示「这条议题的说法要先改」。结尾那一句不提这件事，一号位读到的
    // 是一句去留判断，而屏幕在说另一件事。
    push("S02-A", "p1", "判了 reframing_needed，结尾要落在「这条议题的说法先要改」上。");
  }

  // A3-08 不强迫 recommendation —— 完整的行动方案是 Deep Research 的活。
  if (/^\s*(建议|行动建议|下一步建议|对策)[:：]/m.test(so)) {
    push("A3-08", "p1", "结尾写成了行动建议；预研只回答「值不值得继续想」。");
  }

  // ---- 全局 -----------------------------------------------------------
  // statusReason 也算进来：它是要显示在屏幕上的一句，空词、markdown、member: 死链
  // 那几条对它一样成立，字数也一样占预算。
  //
  // **每条 Evidence 的 label 也算进来。** 它和 text 一样是屏幕上的正文，所以两件事都
  // 成立：一是里面写了 `**` 照样要被 FE-md 挡下来（加粗是屏幕做的），二是它占 900 字
  // 预算 —— 不算的话，三条短标题等于给了一份四五十字的免费额度。
  //
  // **待答问题那几条同理，两边必须一样展开。** `json.ts` 的 `toStatements` 对两者一视
  // 同仁地保留 `label`，`StatementLine` 对两者一视同仁地渲染它，预研页用的是同一个
  // `StatementList`。只展开一边的话，待答问题的短标题就成了 FE-md 挡不住、也不占预算
  // 的一块飞地 —— 而那正是这段注释上面那两句要防的事。
  const all = [
    doc.take,
    ...f.flatMap((x) => [x.label ?? "", x.text]),
    ...q.flatMap((x) => [x.label ?? "", x.text]),
    so,
    doc.question,
    reason,
  ].join("\n");
  // G-* 组（回避式措辞、空词、markdown、member: 死链）全部走共用原语 ——
  // 这几条对 A3/A4/A10 是同一套要求，各写一份就一定有一份会漏掉后来加的规则。
  v.push(...commonViolations(all, "预研"));
  /*
   * 无依据的绝对化（G-05，p1）。
   *
   * `prompt.ts` 里那条硬规矩写着「结论强度要匹配依据……不要无依据地绝对化」，而这件事
   * 是**可数的**：句子里有「必然/一定会/毫无疑问」这几个词、句内又没有数字或编号撑着。
   * A4 用了两处、A5 用了一处，A3 原来只把它留在提示词里祈祷 —— 而这个文件开头那段话
   * 说的正是这件事：可数的就去数。
   *
   * p1 不挡门：它记一条给运营台看，不触发重修。绝对化有时是对的（句里带着数就放过），
   * 拿它挡门会把一批合格的预研退回去重跑。
   */
  v.push(...overclaim(all, "预研"));
  // A3-12 1–2 分钟读完。
  const total = chars(all);
  if (total > 900) push("A3-12", "p1", `全文 ${total} 字，超过 900 字的轻量档。`);

  if (!doc.question?.trim()) push("A2-06", "p0", "没写这轮预研要回答的那一句。");
  else if (!/[？?]$/.test(doc.question.trim())) {
    push("A2-06", "p1", "「要回答的那一句」不是疑问句。");
  }

  return v;
}

export { blocking, fmt, summarize } from "@/lib/agent/rules";
