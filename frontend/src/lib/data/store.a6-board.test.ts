/*
 * 一轮对谈之后，A6 那条萃取路真的把一条判断写到了判断板上。
 *
 * 这条路在生产上与对谈结算那条（`landTalkCandidate`）写的是**同一张判断板**，而离线以前
 * 连跑都跑不到：假模型没有 `a6.turn` 这个罐头键，`extractTurn` 拿到的是兜底对象，
 * `formed` 恒为空 —— 于是「对谈里长出一条判断 → 上板」这条写入路径一次都没被走到过，
 * 两条路撞不撞得上也就无从测起。
 *
 * 所以这一条钉的是**罐头键 + 那条写板路**：把 `mock.ts` 里 `a6.turn` 那个键删掉，
 * 或者把 `settleTurn` 里 `boardPush` 那一段摘掉，这一条都会红。
 *
 * 环境变量必须在任何摸到 `store.ts` 的 import 之前设好（成例见 `store.judgements.test.ts`
 * 头部）。跑 demo 那一档：读板时那一轮 A5 在 demo 下不起（`ensureJudgements` 挡了），
 * 于是板上多出来的那一条只可能是这一轮萃取落上去的。
 */
process.env.TKOS_MODE = "demo";
process.env.TKOS_PERSIST = "0";
process.env.TKOS_MODEL_MOCK = "1";

import { beforeAll, describe, expect, it } from "vitest";
import type { api as Api } from "./store";

let api: typeof Api;

beforeAll(async () => {
  api = (await import("./store")).api;
});

/** 萃取挂在 `recordAdvisorReply` 后面、故意不 await（屏幕不等它）。所以这里轮询。 */
const until = async (ok: () => Promise<boolean>, tries = 100): Promise<boolean> => {
  for (let i = 0; i < tries; i += 1) {
    if (await ok()) return true;
    await new Promise((done) => setTimeout(done, 5));
  }
  return false;
};

/** `mock.ts` 里 `a6.turn` 那个罐头落到板上的那一句。逐字，因为下面要按它构造一次撞车。 */
const A6_STATEMENT = "这一轮先按台账上那一句往下走，等下一季度的实测数据到了再动它";
/** 前 30 个非空白字符与 `A6_STATEMENT` 完全相同、只多一截结尾的候选。 */
const COLLIDING = `${A6_STATEMENT}，但口径要按出货面积算，不按片数`;

describe("对谈一轮之后的萃取", () => {
  it("参谋这一轮长出的那条判断落到板的上半层，署名是这一轮的参谋", async () => {
    const issue = await api.addIssue("离线跑得到 A6 那条写板路吗");

    await api.openAdvisorTurn(issue.id, "这一句到底凭什么成立？");
    const before = await api.getBoard(issue.id);
    await api.recordAdvisorReply(issue.id, "先按台账上那一句往下走，等实测数据到了再动它。");

    const landed = await until(async () => {
      const board = await api.getBoard(issue.id);
      return board.draft.length > before.draft.length;
    });
    expect(landed).toBe(true);

    const board = await api.getBoard(issue.id);
    const one = board.draft.find((x) => !before.draft.some((b) => b.id === x.id));
    expect(one).toBeDefined();
    // 从对谈来的那一条：署名是参谋这一轮，而且**还在上半层**（没人替他确认）
    expect(one!.origin).toBe("dialogue");
    expect(one!.confirmed).toBeUndefined();
    expect(one!.notes?.[0]?.kind).toBe("agent");
    // 「凭什么」不能空 —— 板上没有依据的一行就是一句口号（`extractTurn` 也是这么拦的）
    expect((one!.basis ?? "").length).toBeGreaterThan(0);
  });
  /*
   * **I3：同一张判断板上的两条写入路撞上之后会怎样。**
   *
   * A6 萃取那一条（本文件上面那一条钉的）和对谈结算那一条（`landTalkCandidate`）在生产上
   * 挂在同一次 `settleTurn` 里：结算那一下 `void settleTalkTurn(...)` 不 await、内部还要走
   * 一次复核模型调用，A6 萃取那一下随后 `await`。**谁先落库不确定**，而板按正文前 30 字
   * 去重、先到的整条赢。于是「开头 30 字相同、结尾不同」的一次正常并发就会撞上。
   *
   * 从前撞上是 `throw new ApiError(...)`：抛出去被 `doSettle` 的 catch 接住、rethrow，
   * 最后在运营台账上落成一条「第 N 轮结算失败」—— 把一次并发记成故障。
   *
   * 这一条钉的是**撞上之后到底发生了什么**：交一份说得清的回执、板上一个字不动、
   * 时间线上不多一条。两条路的署名 / 依据 / 是否落图仍然由谁先到决定（下面第一条断言
   * 直接把这件事摆出来：赢的是 A6 那条，署名是「您的 Agent」不是「议事对话」）——
   * **那件事这一轮没修**，它要的是一次显式合并，牵进来就是第二套改版语义。
   */
  it("对谈结算这条撞上 A6 先落的那一条：交回执，不抛，板上一个字不动", async () => {
    const issue = await api.addIssue("两条写板路撞上会怎样");

    await api.openAdvisorTurn(issue.id, "这一句到底凭什么成立？");
    const before = await api.getBoard(issue.id);
    await api.recordAdvisorReply(issue.id, "先按台账上那一句往下走，等实测数据到了再动它。");
    expect(await until(async () => (await api.getBoard(issue.id)).draft.length > before.draft.length)).toBe(true);

    const a6 = (await api.getBoard(issue.id)).draft.find((x) => x.statement === A6_STATEMENT);
    expect(a6).toBeDefined();          // 罐头键没了、或者写板那一段被摘掉，红在这里
    // 赢的是 A6 那一条：署名是这一轮的参谋，不是「议事对话」
    expect(a6!.notes?.[0]?.source).toContain("您的 Agent");

    /*
     * 现在让对谈那条路去落一句**开头 30 字与它完全相同、结尾不同**的候选。前提机械地
     * 验一遍，不写在注释里当承诺。
     */
    const boardKey = (t: string) => t.replace(/\s/g, "").slice(0, 30);
    expect(boardKey(COLLIDING)).toBe(boardKey(A6_STATEMENT));
    expect(COLLIDING).not.toBe(A6_STATEMENT);

    await api.proposeTalkPoint(issue.id, {
      thesis: "这一轮先按台账上那一句往下走",
      candidate: {
        statement: COLLIDING,
        basis: "[E1] 面积口径与片数口径的换算",
        boundary: "只说口径这一项",
        reopenIf: "行业统计改用片数口径",
      },
    });

    // **不抛。** 一次正常的并发不该在运营台账上记成一次结算失败。
    const r = await api.landTalkCandidate(issue.id);

    // 回执指的是板上真有的那一条（A6 落的那一句），不是这一次要落的那一句
    expect(r.boardId).toBe(a6!.id);
    expect(r.nodeId).toBeNull();
    expect(r.queuedArms).toEqual([]);
    /*
     * 这句话不许说「已落到判断板」，得说清这一次这一句没落上去。**今天它落在哪：**
     * 轮外结算收下它、记进这一轮的运营台账（`settle.ts` 里那条「候选落地回执」）——
     * 屏幕上还没有入口。写错的后果是回头翻账的人读到一句假话，不是屏幕上的病。
     */
    expect(r.why).toContain(`开头相同的判断（${r.ref}）`);
    expect(r.why).toContain("这一句这次没落上去");
    expect(r.why).not.toContain("已落到判断板");
    expect(r.why).not.toContain("等你确认");

    // 板上那一条一个字没动，这一次这一句一个字没进去
    const after = await api.getBoard(issue.id);
    const all = [...after.draft, ...after.confirmed];
    expect(all.find((x) => x.id === a6!.id)!.statement).toBe(A6_STATEMENT);
    expect(all.some((x) => x.statement === COLLIDING)).toBe(false);
    expect(all.filter((x) => boardKey(x.statement) === boardKey(A6_STATEMENT))).toHaveLength(1);

    // 时间线上不多一条「聊定一条待确认判断」—— 这一次板上图上一个字都没写成
    expect(
      (await api.getTimeline(issue.id)).some((x) => x.headline.includes("聊定一条待确认判断")),
    ).toBe(false);
  });
});
