/**
 * A1a 的写回。**唯一决定「这次运行要改数据层里的什么」的文件。**
 *
 * 两个入口，按**这次运行的输入是什么**分，不按路由分：
 *
 *   - `applyA1aResult(run, cardId)` —— 输入是提请台上的一张卡。只实现 `ignore`
 *     那一条（spec §11），另外两条留接口并**显式抛错**：静默 no-op 的话，Run 记录里
 *     躺着一份漂亮的产出，而议题列表一动不动 —— 屏幕上看不出「这条议题其实没进
 *     池子」，等到有人发现时已经过了很久。
 *   - `applyA1aInbox(run, sig)` —— 输入是待挑页上一条还没有卡的信号。三条路都接通了，
 *     `new_issue` / `update_issue` 真的在池子里开出一条 Candidate 议题。
 */
import {
  issueExists,
  issueFromSignal,
  issueOfSignal,
  markCardAgentVerdict,
  noteMaybeSameIssue,
  patchSignalIssueFraming,
} from "@/lib/data/store";
import type { AgentRunRecord, CardAgentVerdict, InboxSignal } from "@/lib/data/types";

/** 接口留了、写回还没接。等 Sean 提供测试后的 prompt（spec §11）。 */
export class NotWiredYet extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotWiredYet";
  }
}

const s = (o: Record<string, unknown> | null, k: string): string => {
  const v = o?.[k];
  return typeof v === "string" ? v.trim() : "";
};

export function applyA1aResult(run: AgentRunRecord, cardId: string): { applied: string } {
  if (run.status === "failed") {
    return { applied: "本次运行失败，未写回任何内容。" };
  }
  if (run.route === "ignore") {
    /*
     * 判为噪音**不等于**把这条信号收走。
     *
     * 被 CEO 递上来的信号哪怕调研后判定为没价值，也要留在信号列表里、只是
     * 标注出来 —— 删除或归档是他自己的动作。自动收走的话，他会以为系统漏了
     * 这条，而系统其实是判过的；而且他再也没法反过来质疑这次判断。
     */
    const verdict: CardAgentVerdict = {
      route: "ignore",
      verdict: s(run.output, "verdict"),
      reason: s(run.output, "reason"),
      reasonToRevisit: s(run.output, "what_would_change_it"),
      runId: run.id,
      at: run.finishedAt,
    };
    const ok = markCardAgentVerdict(cardId, verdict);
    return {
      applied: ok
        ? `已在信号 ${cardId} 上标注「调研后判为噪音」，卡仍留在列表里。`
        : `找不到信号 ${cardId}，未写回。`,
    };
  }
  throw new NotWiredYet(
    `A1a 的 ${run.route} 写回尚未接通（Run ${run.id} 已落库，产出可见可评分）。` +
      "等测试后的 prompt 定稿再接 —— 见 docs/superpowers/specs/2026-08-18-harness-sync-design.md §11。"
  );
}

/**
 * 待挑页那条链路的写回：一条信号跑完 A1a，该在池子里留下什么。
 *
 * 和 `applyA1aResult` 分开而不是加个分支：那一条按 `cardId` 走，`ignore` 那支要去
 * `markCardAgentVerdict` 标注一张卡，而**待挑的信号根本没有卡** —— 它就是一段外部
 * 原文。合成一个函数就得让 cardId 变成可空，于是「标注了一张不存在的卡」这种错会
 * 静默通过。
 */
export function applyA1aInbox(
  run: AgentRunRecord,
  sig: InboxSignal
): { applied: string; issueId?: string; maybeSameIssue?: { issueId: string; delta: string[] } } {
  /*
   * 同一条信号不许立两次案。
   *
   * 待挑页跑完之后再点一次「开成议题」，`runTask` 那道闸只挡「正在跑」，不挡
   * 「跑过了」—— 不拦的话议题池里会出现两条一模一样的潜在议题，而池子可信的前提是
   * 每条都答得出自己怎么进来的。反过来，`judged.issueId` 指向一条已经不存在的议题
   * （他删了）就当没有，照常新建：留着那个编号只会让屏幕上多一条点不开的链接。
   *
   * **时间线的 runId 与这里返回的 runId 可能指向不同运行**：时间线上记的是**第一次**
   * 开成议题的那次运行（议题的来路），而这次返回的 `judged` 里会被写成第二次运行的
   * runId —— 两处指向不同运行是已知的，不是 bug。
   */
  const already = issueOfSignal(sig);
  if (already && issueExists(already)) {
    /*
     * 议题已经在了，这一轮就只剩一件事：**把四块框架补上去**。
     *
     * 两种走到这里的情形，处置一样：一号位在待挑页确认升级（`api.upgradeSignal` 当场
     * 建的，那时模型还没跑）、或者他跑完之后又点了一次。前者是常态 —— 确认那一下不等
     * 模型（理由写在 `upgradeSignal` 上），所以这一轮跑完时卡上那两格还空着。
     *
     * **标题一个字不动。** 那是他确认过的那句话；模型的版本不许覆盖它。
     */
    const patched = run.status === "ok" ? patchSignalIssueFraming(already, run.output ?? {}) : false;
    return {
      applied: patched
        ? `议题 ${already} 已经在了，这一轮把参谋的正文补了上去。`
        : `这条信号已经开成议题 ${already} 了，没有重开。`,
      issueId: already,
    };
  }

  if (run.status === "failed") {
    return { applied: "本次运行失败，未建任何议题。" };
  }
  if (run.route === "ignore") {
    /*
     * 判为噪音这一支**什么都不建**，也**不去 `markCardAgentVerdict`**：这条信号还没有
     * 卡，标注无处可落。结论已经由 route 记在这条信号的 `judged` 上（待挑页照它写那
     * 一行字），这里再建一条 Candidate 议题等于把「不值得」写成「值得」。
     */
    return { applied: "A1a 判这条不值得开成议题；卡与议题都不建。" };
  }

  /*
   * `new_issue` 和 `update_issue` 建法完全一样：`update_issue` 的意思是「有一条既有
   * 议题在说同一件事，但说法被这条信号改变了」，产出是**一条取代它的新议题**
   * （见 `run.ts` 顶上那张表）。取代成不成立是一号位采信那一下的事，所以这里
   * **不改那条旧议题的任何字段** —— 今天还没有任何入口做这件事。
   */
  const issue = issueFromSignal(sig, run.output ?? {}, run.id);
  if (!issue) {
    return { applied: "A1a 的产出里没有议题正文，未建议题。" };
  }
  /*
   * **算出来、标上去，不合卡。**
   *
   * 这一步之后旧议题上一个字段都没动，新议题照旧建了 —— 变的只是新那张卡上多一格
   * 「可能和 ISS-xxx 说的是同一件事」。`update_issue` 与 `new_issue` 两条路都做这一下：
   * 「是不是同一件事」是文本上的问题，跟模型把它路由成哪一条无关。
   */
  const sameAs = noteMaybeSameIssue(issue.id, [sig.title, sig.text].filter(Boolean).join("\n\n"));
  return {
    applied: `已开成议题 ${issue.id}：${issue.title}`,
    issueId: issue.id,
    ...(sameAs ? { maybeSameIssue: sameAs } : {}),
  };
}
