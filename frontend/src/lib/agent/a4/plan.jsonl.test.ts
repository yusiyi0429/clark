/**
 * **计划截在半路时，前面完整的那几条必须留下来。**
 *
 * ## 这一条是拿真账单换来的
 *
 * 2026-08-31 算账那一轮量出来：N2 检索计划两轮四次调用，输出全部撞上 8000 的上限，而
 * **上限封的是含思考在内的 completion**——
 *
 *     out=8001  其中思考 7194   → 留给 JSON 正文的只有 ~800
 *     out=8001  其中思考 5416   → ~2585
 *
 * 那一版交的是**一个整的 JSON 对象**、而且不允许续写。截一刀整个对象就解析不出来，
 * `compilePlan` 拿到零条命题，于是 `pipeline.ts` 里那一支直接把 **N3 分维度取证整段跳过**，
 * 记一条缺口继续出稿 —— 这一轮照旧 `status: "ok"`。屏幕上唯一的表现是「这份报告写得空」，
 * 而检索一次都没发过。一轮深研几块钱，取证那一段是它的核心，全程静默地没跑。
 *
 * 工作样例就在同一个文件里：**N1 草稿在同样的 8000 上限下活了下来**，因为它交的是 JSONL、
 * 而且允许续写一次（`json:false, jsonlContinue:1`）——截在半行上，前面那些行照旧成立。
 * 这个文件钉的就是把 N2 换成同一个形状之后的行为。
 *
 * 两头都要钉：
 *   · 截断的最后一行丢掉，**前面的全留**（这一条红过，就是上面那个 bug）。
 *   · 坏行要**报出来**，不能默默吞掉 —— 静默正是这个 bug 最贵的地方。
 */
import { describe, expect, it } from "vitest";

import { compilePlan, parsePlanLines } from "./plan";

/** 一条完整的命题行，按 `PLAN_SYSTEM` 里那个形状。 */
const line = (dim: string, stmt: string) =>
  JSON.stringify({
    dimension: dim,
    statement: stmt,
    requiredEvidence: "带统计期间的第三方数据",
    queries: [`${stmt} 最新数据`, `${stmt} 2026`],
    counterQueries: [`${stmt} 不成立`],
    sourceKinds: ["行业机构", "公司披露"],
    materialityWeight: 0.8,
    freshnessUrgency: 0.9,
  });

const LF = String.fromCharCode(10);

describe("N2 的计划按行读", () => {
  it("最后一行截在半路：前面那几条一条不少", () => {
    const whole = [
      line("D1", "中小尺寸面板的出货量在本季度环比下滑"),
      line("D2", "在建产线的投产节奏比年初的指引推迟了一个季度"),
      line("D3", "光刻类路线在中尺寸上的单位面积成本仍高于蒸镀"),
    ].join(LF);
    // 模型的额度被思考吃光，正文停在第三行中间 —— 真实运行里就是这个样子。
    const cut = whole.slice(0, whole.length - 60);

    const { propositions, bad } = parsePlanLines(cut);
    expect(propositions).toHaveLength(2);
    expect(bad).toHaveLength(1);
    // 报的是第几行、以及为什么读不出 —— 只说「有一行坏了」查不出是截断还是形状错。
    expect(bad[0].line).toBe(3);
    expect(bad[0].why.length).toBeGreaterThan(0);

    /*
     * 最要紧的那一句：**编译出来的命题不是零**。
     *
     * 零就意味着 N3 整段被跳过（`pipeline.ts` 的 `!props.length` 那一支），而这正是
     * 那一版的死法。
     */
    expect(compilePlan({ propositions }, 2).length).toBeGreaterThan(0);
  });

  it("一行都读不出时照实回空 —— 不编", () => {
    const { propositions, bad } = parsePlanLines("{这不是 json" + LF + "也不是");
    expect(propositions).toEqual([]);
    expect(bad).toHaveLength(2);
  });

  it("围栏和空行不算坏行", () => {
    // 模型经常自作主张套一层 ```json。它不是错误，不该记进缺口清单。
    const text = ["```json", line("D1", "需求端这一条要核"), "", "```"].join(LF);
    const { propositions, bad } = parsePlanLines(text);
    expect(propositions).toHaveLength(1);
    expect(bad).toEqual([]);
  });

  it("整个对象包着一个数组的老形状也照收", () => {
    /*
     * 换成 JSONL 之后模型偶尔还是会交回老那一版的形状（一个 `{"propositions":[...]}`）。
     * 那一份**完全能用**，丢掉它等于为了形状好看而扔掉一次已经付过钱的调用。
     */
    const old = JSON.stringify({
      propositions: [JSON.parse(line("D1", "需求端这一条要核")), JSON.parse(line("D2", "供给端那一条要核"))],
    });
    const { propositions, bad } = parsePlanLines(old);
    expect(propositions).toHaveLength(2);
    expect(bad).toEqual([]);
  });
});
