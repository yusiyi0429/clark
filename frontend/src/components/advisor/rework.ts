/**
 * 「打回重研」那颗键的闸。
 *
 * 一颗键为什么需要一个闸：**它按下去会丢掉现有报告、起一轮十几分钟的深研、花一笔真钱**
 * （`store.ts` 的 `requestRework` → `reopenDeepResearch`）。而这一步在整个产品里的定位是
 * 「只有他按下才起」—— 深研失败之后故意不自动重试，模型也没有替他重开的口子
 * （`ensureDeepResearch` 那两道闩）。所以起一轮的**唯一**触发点就是这颗键，那它自己
 * 就得说得清「哪一下算数」。
 *
 * 三档，两件事各占一半：
 *
 * · **第一下只开卡，不起轮**（`idle` + `open`）。误点一次不该等于花一笔钱。
 * · **确认那一下才起**（`confirming` + `confirm`）。
 * · **在跑的时候一下都不算数**（`running`）。这一档挡的是双击 —— 一次点击变两轮深研，
 *   在屏幕上和一轮长得一模一样，只有月底的账单看得出来。
 *
 * 抽成一个纯函数而不是在组件里写 `if`：这个仓库的单测跑在 node 上，没有 DOM，组件里的
 * 分支一条都测不到。而「第一下不起轮」这件事一旦被谁顺手改成直接起，屏幕上看不出任何
 * 异常 —— 那正是最该有一条会红的断言的地方。
 */

/** 这颗键此刻在哪一档。 */
export type ReworkStage = "idle" | "confirming" | "running";

/** 他按了哪一下。`open` 是那颗键本身，另两下在确认卡上。 */
export type ReworkPress = "open" | "confirm" | "cancel";

/**
 * 这一下要不要真起一轮。
 *
 * 只有一种组合算数：卡已经开着，按的是确认。别的一律否 —— 包括「没开卡就收到一次
 * confirm」，那种情形在屏幕上不该发生，真发生了说明确认卡的渲染条件被谁改松了，
 * 而那时候宁可这一下不起轮。
 */
export const armsRework = (stage: ReworkStage, press: ReworkPress): boolean =>
  stage === "confirming" && press === "confirm";

/** 按完之后停在哪一档。起轮那一下进 `running`，由调用方在落定后自己收回 `idle`。 */
export function nextStage(stage: ReworkStage, press: ReworkPress): ReworkStage {
  if (stage === "running") return "running";
  if (press === "cancel") return "idle";
  if (press === "open") return "confirming";
  return armsRework(stage, press) ? "running" : stage;
}
