/**
 * A7 —— 交上来的材料先判一眼。**这份东西是不是这场会的记录。**
 *
 * ## 为什么要多一次调用
 *
 * 会后那条链路上，人做的最后一个动作是「把材料交上来」，而这一下最容易错：传成了上
 * 周那场会的转写、传成了一份产品方案、录音只录到开场三分钟。原来这三种全都直接进
 * A7 提炼 —— 那是一次 `pro` 档、吃下几万字转写的调用，跑完之后卡面上摊开的是一份
 * 「读起来完全通顺、说的却是别的事」的要点，而他没有任何办法看出来。
 *
 * 所以先花一次 `flash`（几秒、便宜两个量级）问一句：**这是不是一场会的记录，能不能
 * 对上这场会那几件议题。** 对不上就照实说，后面那一大笔不花。
 *
 * ## 为什么判据是这两条，不是「材料质量好不好」
 *
 * 「好不好」判不了 —— 一场只有寒暄的会也是这场会的真实记录，而 A7 对它的正确答案是
 * 「什么都没提炼出来」（见 `debrief.ts` 那条不交空壳的闸）。这一步要拦的只有**交错了
 * 东西**这一种，所以判据就两条，都是事实问题：它像不像一场会上的话，以及会上谈的事
 * 跟这场会排的那几件议题对不对得上。
 *
 * ## 判没用的时候，那句话要能直接上屏
 *
 * `reason` 原样落到这一场会上（`MeetingSlot.intakeRejection`），屏幕照登。所以提示词里
 * 逼的是一句**说得出对不上在哪儿**的话：「这份是上周产品评审的记录，跟这场会的三件
 * 议题一件都对不上」告诉他该去传哪一份；「材料无效」只告诉他再传一次。
 *
 * ## 拿不准的时候放行
 *
 * 两种错的代价不对称：放错一份，代价是一次白花的提炼加一张他一眼就能否掉的卡；拦错
 * 一份，代价是一场真开过的会被挡在门外，而他手上没有第二份材料。所以提示词里写死了
 * 「拿不准就判有用」，这里的兜底也一样 —— 模型没给出判定时按有用算。
 */
import { Harness } from "@/lib/agent/harness";
import { str } from "@/lib/agent/json";
import type { AgentRunRecord } from "@/lib/data/types";

/** 递给模型的一件议题。只给标题 —— 这一步问的是「对不对得上」，不是「谈到什么程度」。 */
export type IntakeIssueRef = { id: string; title: string };

export type IntakeInput = {
  /** 这场会什么时候开的，人话（`周四 9/4 · 下午`）。 */
  slotLabel: string;
  issues: IntakeIssueRef[];
  /** 交上来那份材料的全文。 */
  transcript: string;
};

export type IntakeResult = {
  usable: boolean;
  /** 为什么。判没用时这一句会原样上屏，所以它必须说得出对不上在哪儿。 */
  reason: string;
  /** 这次运行的可复现记录。由调用方落库（`agentRunSettle`）。 */
  run: AgentRunRecord;
};

/**
 * 判这一步读多长。
 *
 * 比提炼那一步的 6 万字短得多（`debrief.ts` 的 `TRANSCRIPT_MAX`），因为**这一步不需要
 * 读完**：交错了东西这件事在头几千字里就已经成立了 —— 一份产品方案的开头就不是人说的
 * 话，上周那场会的开头点的就是另外几件议题。读完全文只是把这次「便宜」的判断变贵。
 *
 * 代价说清楚：一份前半段跑题、后半段才进入正题的记录会被误判。所以提示词里那条「拿不准
 * 就判有用」在这里兜着 —— 头 6 千字看不出对不上，就是看不出，不是对不上。
 */
const TRANSCRIPT_MAX = 6_000;

export async function judgeIntake(
  input: IntakeInput,
  /** `kind`/`id` 要和调用方那句 `runTask` 一模一样，理由见 `HarnessInit.progress`。 */
  opts: { progress?: { kind: string; id: string; total: number } } = {},
): Promise<IntakeResult> {
  const h = new Harness({
    agent: "A7",
    /*
     * `flash`。这一步存在的全部理由就是**别花提炼那一档的钱**，用 `pro` 判一遍再用
     * `pro` 提炼一遍，等于把成本从一次变成两次，还多等几十秒。
     */
    slot: "flash",
    temperature: 0.1,
    ...(opts.progress ? { progress: opts.progress } : {}),
  });
  h.step("判这份材料有没有用");

  let transcript = input.transcript;
  if (transcript.length > TRANSCRIPT_MAX) {
    h.note("材料太长，只读前 6 千字判", { got: transcript.length });
    transcript = transcript.slice(0, TRANSCRIPT_MAX);
  }

  const parts = [
    `## 这场会\n\n${input.slotLabel}`,
    [
      "## 这场会上排了这几件议题",
      "",
      ...input.issues.map((i) => `- ${i.id}｜${i.title}`),
    ].join("\n"),
    `## 交上来的材料\n\n${transcript}`,
  ];

  const o = await h.callPrompt("a7.intake", { input: parts.join("\n\n") });
  /*
   * 只有字面的 `false` 才算判没用。
   *
   * 模型写 `"false"`、`"否"`、`0` 的时候一律按有用处理 —— 这是上面那条不对称的落点：
   * 认不出的那一档必须落在放行这一边，否则一次格式抖动就会把一场真开过的会挡在门外，
   * 而屏幕上写的是「这份材料没用」，看起来像模型真判过。
   */
  const usable = o.usable !== false;
  const reason = str(o.reason);

  return {
    usable,
    reason,
    run: h.finish({
      /*
       * 判没用是 `ignored` 不是 `ok`：同 `debrief.ts` 那条理由 —— 它是一个**正确的
       * 结果**，但它和「收下了」必须在台账上分得开，否则「传了材料什么都没发生」这件事
       * 永远查不出是哪一头。
       */
      status: usable ? "ok" : "ignored",
      input: `${input.slotLabel} · ${input.issues.length} 件议题 · 材料 ${input.transcript.length} 字`,
      output: { usable, reason },
    }),
  };
}
