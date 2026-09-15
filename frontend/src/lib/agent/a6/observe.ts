/**
 * A6 判断对话的事后质量观测。**不拦截、不重写、只记账。**
 *
 * ## 为什么这里不能像 A3/A4 那样打回重生成
 *
 * 因为它是流式的。一号位在第三秒就看见字了 —— 等一轮说完再判定「这一轮不合格，
 * 重来」，屏幕上会出现一段话被抹掉重写。那比说错一句更伤：他会开始怀疑屏幕上
 * 任何一句话的稳定性。
 *
 * 所以对话这一栏的质量保证只能落在两个地方：**prompt 事前**（instructions.ts）
 * 和**日志事后**（这里）。中间那一层拦不住。
 *
 * ## 那记这个账有什么用
 *
 * 有用，而且是唯一有用的东西：它把「参谋最近说话是不是在退化」变成一个可以看的
 * 数字。没有它，A6 的质量只能靠人凭印象说「感觉最近答得没以前好」——
 * 那种反馈没法定位到是 prompt 改坏了、上下文变薄了，还是模型换了版本。
 *
 * 违规不弹给一号位。它进服务端日志，将来进运营台。
 */
import {
  chars,
  commonViolations,
  isRhetorical,
  paragraphs,
  sentences,
  type Violation,
} from "@/lib/agent/rules";

/** 附和的特征开头。CQ101 §09：先肯定一遍再转折，等于没挑战。 */
const SYCOPHANTIC = /^(好问题|说得对|完全同意|您说得很对|确实如此|这个问题非常|太好了)/;

/** 空词与套话。和 rules.ts 的 BUZZ 分开：这些是对话特有的。 */
const FILLER = ["让我们", "综上所述", "总的来说", "希望以上", "供您参考", "如有需要"];

export function observeReply(text: string): Violation[] {
  const v: Violation[] = [];
  const push = (rule: string, severity: "p0" | "p1", message: string) =>
    v.push({ rule, severity, message });

  const body = text.trim();
  if (!body) return [{ rule: "A6-00", severity: "p0", message: "这一轮什么都没说。" }];

  const paras = paragraphs(body);
  const rhetorical = paras.filter(isRhetorical);

  // A6-01 反问只能一段、一句。连着问三句那是审问，不是参谋。
  if (rhetorical.length > 1) {
    push("A6-01", "p0", `反问 ${rhetorical.length} 段，只能有一段。`);
  }
  if (rhetorical.some((p) => sentences(p).length > 1)) {
    push("A6-01", "p0", "反问一次只问一句。");
  }

  /*
   * A6-02 段数。最多五段是 instructions 里的硬约束。
   *
   * 开头单独一行的称呼（「明华总。」）不算 —— 它是礼节不是内容，把它算进去
   * 会让每一轮都莫名其妙地多一段，然后这条规则就变成了背景噪音。
   */
  const vocative = paras.length > 1 && chars(paras[0]) <= 8 && /[。：:]$/.test(paras[0]);
  const contentParas = vocative ? paras.slice(1) : paras;
  if (contentParas.length > 5) push("A6-02", "p1", `${contentParas.length} 段正文，超过五段。`);

  // A6-03 附和式开头。
  if (SYCOPHANTIC.test(body)) {
    push("A6-03", "p0", `以附和开头（「${body.slice(0, 8)}…」）—— 先肯定一遍再转折等于没挑战。`);
  }
  for (const f of FILLER) {
    if (body.includes(f)) push("A6-04", "p1", `出现套话「${f}」。`);
  }

  /*
   * A6-05 这一轮有没有给出自己的判断。
   *
   * 只把事实再摆一遍不算回答 —— 一号位手上不缺事实，缺的是有人敢说这些事实
   * 意味着什么。
   *
   * **这条规则本身是弱的，要知道它弱在哪。** 第一次真跑就误报了一次：参谋写的是
   * 「我读下来的判断是…」，而当时的词表里只有「我的判断」。这类规则在两个方向上
   * 都会错 —— 换个说法就漏掉（漏报），而一段纯事实罗列只要出现一个「所以」就能
   * 蒙混过关（误放）。
   *
   * 词表已经扩到覆盖常见说法，但真正该做的是把它挪到 rubric 的 judged 档，
   * 用一次 flash 抽检来判，而不是数关键词。留在这里是因为：一条会误报的 p1
   * 会让整份日志被当成噪音忽略掉，而那等于把观测这件事本身废掉。
   */
  const HAS_STANCE =
    /(判断是|我的判断|我认为|我看|我的看法|读下来|更支持|不成立|站不住|建议|风险在于|问题出在|最该|缺的是|卡在|意味着|所以|因此|应该|值得|不是.{1,20}而是)/.test(
      body
    );
  if (!HAS_STANCE) {
    push("A6-05", "p1", "这一轮可能没有给出自己的判断（弱信号，词表匹配）——去看一眼原文。");
  }

  // A6-06 长度。这一栏的产品含义是「随口问一句」，不是「提交一个任务」。
  const n = chars(body);
  if (n > 700) push("A6-06", "p1", `${n} 字，这一栏是对话不是报告。`);

  v.push(...commonViolations(body, "对谈"));
  return v;
}

/**
 * 把一轮的观测结果打进日志。
 *
 * 只在有违规时打 —— 每轮都打一行「本轮 0 违规」会把日志淹掉，
 * 而淹掉的日志等于没有日志。
 */
export function logObservation(issueId: string | null, text: string): Violation[] {
  const v = observeReply(text);
  if (!v.length) return v;
  const p0 = v.filter((x) => x.severity === "p0");
  const tag = `[tkos:a6]${issueId ? ` ${issueId}` : ""}`;
  /*
   * 形态数字跟着一起打。
   *
   * 只打规则号（「本轮 2 条 p1：A6-02,A6-05」）在终端里是没法诊断的 —— 看不出
   * 它是长了、散了、还是根本没表态。段数和字数这两个数就够定位：段多字多 +
   * 没表态，基本就是它在复述上下文而不是给判断，而那正是往 system prompt 里
   * 塞了新上下文之后最容易出现的退化。
   */
  const shape = `${paragraphs(text.trim()).length} 段 / ${chars(text)} 字`;
  if (p0.length) {
    console.warn(`${tag} ${shape} · ${p0.length} 条 p0：` + p0.map((x) => `${x.rule} ${x.message}`).join("；"));
  } else {
    console.log(`${tag} ${shape} · ${v.length} 条 p1：` + v.map((x) => `${x.rule} ${x.message}`).join("；"));
  }
  return v;
}
