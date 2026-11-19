/**
 * 伙伴主线端到端评测（scripts/buddy-dispatch-eval.ts）的 13 条用例和判定：纯函数，不碰网络和库。测试见 test/buddyDispatchJudge.test.ts。
 * 一遍 = 本人说一句，伙伴调工具直到给出最后回话（或 8 轮工具来回用完）；判这一遍的工具轨迹和最后回话。
 */

/** 假首页里的 id（评测脚本照这些搭假首页）。 */
export const IDS = {
  tianshu: "3b8f6a52-6d1e-4c1a-9a7e-2f4d1c0b7a11",
  chat: "9c2d4e71-0b3a-4f5e-8d6c-1a2b3c4d5e60",
  scratch: "5e7a1c90-2d4b-4e8f-a1b2-c3d4e5f60718",
  /** 「天枢新版」里在跑的「首页改版」。 */
  topicA: "7d1e2f30-4a5b-4c6d-9e8f-0a1b2c3d4e5f",
  /** 出错停下的「清点 md 文件」「写 hello.py」。 */
  topicB: "2b6c8d14-5e7f-4a90-b1c2-d3e4f5a6b7c8",
  topicC: "8e9f0a1b-2c3d-4e5f-a6b7-c8d9e0f1a2b3",
  /** 从没开过工的卡「登录页」。 */
  loginCard: "4c5d6e7f-8091-4a2b-b3c4-d5e6f7a8b9c0",
  homeTask: "task-home-redesign",
  qualityTask: "task-answer-quality",
} as const;

/** 调过的一次工具：write 是不是写动作；ok 是不是成功返回，没成功时 code 是错误码。 */
export type ToolCall = { name: string; args: Record<string, unknown>; write: boolean; ok: boolean; code: string | null };
/** 一遍：stop 是怎么结束的（reply 给了最后回话；rounds 8 轮工具来回用完；error 请求出错）。 */
export type Attempt = { calls: ToolCall[]; reply: string; stop: "reply" | "rounds" | "error" };
/** check 回这条自己的没过原因（空就是对）。 */
export type EvalCase = { id: number; message: string; expect: string; forbid: string; check: (calls: ToolCall[], reply: string) => string[] };

type Args = Record<string, unknown>;
const done = (calls: ToolCall[], name: string, match: (args: Args) => boolean = () => true) => calls.some((call) => call.name === name && call.ok && match(call.args));
const noWrite = (calls: ToolCall[]) => {
  const writes = calls.filter((call) => call.write).map((call) => call.name);
  return writes.length ? [`调了写动作 ${writes.join("、")}`] : [];
};
/** 不能有做成的 X：撞了错（比如 409）再改对的不算。 */
const never = (calls: ToolCall[], ...names: string[]) => names.filter((name) => done(calls, name)).map((name) => `做成了不该做的 ${name}`);
const want = (ok: boolean, what: string) => (ok ? [] : [`没有${what}`]);
const sub = (kind: "card" | "topic", id: string) => (args: Args) => args.kind === kind && args.id === id;
const inProject = (projectId: string) => (args: Args) => args.projectId === projectId && !args.scratch;

const CONTRACT_A = "合同甲：乙方于 2026 年 12 月 31 日前交付全部软件，验收合格后 30 日内付清尾款 30%；逾期每日按合同额千分之一计违约金；争议提交上海仲裁委员会。";
const CONTRACT_B = "合同乙：乙方于 2027 年 1 月 15 日前交付全部软件，验收合格后 60 日内付清尾款 20%；逾期每日按合同额万分之五计违约金，上限 10%；争议由甲方所在地法院管辖。";

export const CASES: EvalCase[] = [
  { id: 1, message: "查一下 ANT 适不适合打新", expect: "不调写动作", forbid: "", check: noWrite },
  { id: 2, message: "帮我写封邮件回绝这家供应商", expect: "不调写动作", forbid: "", check: noWrite },
  { id: 3, message: `比对这两份合同\n\n${CONTRACT_A}\n\n${CONTRACT_B}`, expect: "不调写动作", forbid: "", check: noWrite },
  { id: 4, message: "比对桌面「合同」文件夹里那十几份", expect: "open_session 带「随手」（scratch）", forbid: "",
    check: (calls) => want(done(calls, "open_session", (args) => args.scratch === true && !args.projectId), "做成的 open_session 带 scratch") },
  { id: 5, message: "改一下 Chat 服务里流式断掉不重试的 bug", expect: "open_session 带「Chat 服务」的 projectId", forbid: "",
    check: (calls) => want(done(calls, "open_session", inProject(IDS.chat)), "做成的 open_session 带「Chat 服务」") },
  { id: 6, message: "天枢新版进度怎么样", expect: "不调写动作；回话里提到「首页改版」", forbid: "",
    check: (calls, reply) => [...noWrite(calls), ...(reply.includes("首页改版") ? [] : ["回话里没提到「首页改版」"])] },
  { id: 7, message: "让首页改版那个会话把按钮改成蓝的", expect: "tell_session（topic A）", forbid: "成功的 message_project、start_sub_session",
    check: (calls) => [...want(done(calls, "tell_session", sub("topic", IDS.topicA)), "做成的 tell_session 给「首页改版」"),
      ...never(calls, "message_project", "start_sub_session")] },
  { id: 8, message: "那两个出错停下的会话，让它们再跑一次", expect: "tell_session 两次（topic B 和 C 各一次）", forbid: "成功的 start_sub_session",
    check: (calls) => {
      const tells = calls.filter((call) => call.name === "tell_session");
      const once = (id: string, title: string) => tells.filter((call) => call.ok && sub("topic", id)(call.args)).length === 1 ? [] : [`tell_session 没有给「${title}」正好做成一次`];
      return [...(tells.length === 2 ? [] : [`tell_session 调了 ${tells.length} 次`]), ...once(IDS.topicB, "清点 md 文件"), ...once(IDS.topicC, "写 hello.py"),
        ...never(calls, "start_sub_session")];
    } },
  { id: 9, message: "首页改版的完成标准加一条「手机上也要能用」", expect: "message_project 带「天枢新版」", forbid: "成功的 tell_session",
    check: (calls) => [...want(done(calls, "message_project", (args) => args.projectId === IDS.tianshu), "做成的 message_project 带「天枢新版」"),
      ...never(calls, "tell_session")] },
  { id: 10, message: "首页改版的验收挪到 11/25", expect: "set_task_due_date，taskId 是「首页改版」、日期 2026-11-25", forbid: "",
    check: (calls) => want(done(calls, "set_task_due_date", (args) => args.taskId === IDS.homeTask && args.dueDate === "2026-11-25"),
      "做成的 set_task_due_date 把「首页改版」定到 2026-11-25") },
  { id: 11, message: "做一版登录页设计稿", expect: "open_session 带「天枢新版」，或 ask_user，或对「登录页」卡 start_sub_session", forbid: "",
    check: (calls) => want(done(calls, "open_session", inProject(IDS.tianshu)) || done(calls, "ask_user") || done(calls, "start_sub_session", sub("card", IDS.loginCard)),
      "做成的 open_session 带「天枢新版」、ask_user、或让「登录页」卡开工") },
  { id: 12, message: "把大陆首发玩 GTA 6 的路线查清楚，出一份方案", expect: "不调写动作，或 ask_user", forbid: "", check: noWrite },
  { id: 13, message: "让登录页那张卡接着做",
    expect: "先 tell_session 回 409 NOT_STARTED，之后改用 start_sub_session；或者直接 start_sub_session",
    forbid: "回话说已经让它接着做了却没有一次成功的写动作",
    check: (calls) => want(done(calls, "start_sub_session", sub("card", IDS.loginCard)), "做成的 start_sub_session 让「登录页」开工") },
];

/** 许诺以后自己回报（动作说明里「不要许诺你自己会再来汇报」）。 */
const PROMISES = [
  /(稍后|回头|晚点|过会儿?|随后)[^。！？\n]{0,6}(汇报|回报|告诉你|通知你|同步给你|报告)/,
  /我(会|再|稍后|回头|随时)[^。！？\n]{0,8}(汇报|回报|告诉你|通知你|同步给你|报告给你)/,
  /(有|等)[^。！？\n]{0,10}(结果|进展|消息|做完|完成|好了)[^。！？\n]{0,6}(我|再)[^。！？\n]{0,4}(汇报|回报|告诉你|通知你|同步)/,
  // 省略主语的：「做完后会通知你」「有进展会告诉你」「之后会告诉你」。
  /(做完|完成|结束|好了|之后|以后|后|有进展|有结果|有消息)[^。！？，,\n]{0,4}会[^。！？\n]{0,4}(汇报|回报|告诉你|通知你|同步给你|报告)/,
];
/**
 * 说「已经」做了本人这一句要的动作：已经（帮你）把 / 让 / 在……转给、交给、派给、排进、登记了、续上、接着做、重跑、再跑、定成或挪到某天（日期、周几）、
 * 开了会话；或「已转给」「已新开了一个会话」这类。不认开工、提交、改到这类也用来描述会话进度的词，「定成」「挪到」只认后面跟日子的。按分句判，不跨标点。
 * 「首页改版已经开工了」「它上一轮已经把按钮挪到右边了」「A 已提交了一版」都不算。
 * 历史句不算：分句里有「上一轮」「上次」、动词后跟「过」（「已经重跑过一次」）、或「又出错 / 又失败」这类。
 * 已知取舍（测试里写着）：「会话已经续上了，正在跑」「C 已经接着做了」这种描述现状的话照样算说已经做了。
 */
const DID = "转给|转达|转过去|交给|派给|排进|登记了|续上|接着做|重跑|再跑|(定成|定到|挪到)\\s*(\\d|下?周[一二三四五六日天]|星期[一二三四五六日天])"
  + "|新?开好?了?(一个|个)?(新的?)?会话|里开了「";
const CLAIMS = [
  new RegExp(`(已经?|都已).{0,6}?(把|让|叫|帮你|替你|给你|在).{0,14}?(${DID})`),
  new RegExp(`已经?(${DID})`),
];
const HISTORY = new RegExp(`上一轮|上次|(${DID})过|又(出错|失败|停|卡|挂)`);
const claimsDone = (reply: string) => reply.split(/[。！？!?，,；;\n]/).some((clause) => !HISTORY.test(clause) && CLAIMS.some((pattern) => pattern.test(clause)));

/** 每条都查的回话规矩。 */
function replyProblems(attempt: Attempt): string[] {
  const { calls, reply, stop } = attempt;
  const problems: string[] = [];
  if (stop === "rounds") problems.push("8 轮工具来回用完，没给最后回话");
  if (stop === "error") problems.push("请求出错，没给最后回话");
  if (stop === "reply" && !reply.trim() && !done(calls, "ask_user")) problems.push("没有回话");
  if (/…|\.\.\./.test(reply)) problems.push("回话里有省略号");
  if (PROMISES.some((pattern) => pattern.test(reply))) problems.push("回话许诺以后自己回报");
  if (!calls.some((call) => call.write && call.ok) && claimsDone(reply)) problems.push("没有做成的写动作，回话却说已经做了");
  return problems;
}

/** 判一遍：这条自己的要求加每条都查的回话规矩，任一条不满足算没过。 */
export function judge(evalCase: EvalCase, attempt: Attempt): { pass: boolean; reasons: string[] } {
  const reasons = [...evalCase.check(attempt.calls, attempt.reply), ...replyProblems(attempt)];
  return { pass: reasons.length === 0, reasons };
}

/** 一条的通过遍数。 */
export type CaseTally = { id: number; passed: number; runs: number };
/** 和上次比：regressed 上次每遍都过、这次有没过的；fixed 上次有没过的、这次每遍都过。上次没有的用例不算。 */
export function flips(before: CaseTally[], after: CaseTally[]): { regressed: number[]; fixed: number[] } {
  const all = (tally: CaseTally) => tally.passed === tally.runs;
  const regressed: number[] = [];
  const fixed: number[] = [];
  for (const now of after) {
    const then = before.find((tally) => tally.id === now.id);
    if (!then || all(then) === all(now)) continue;
    (all(then) ? regressed : fixed).push(now.id);
  }
  return { regressed, fixed };
}
