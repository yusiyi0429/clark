/**
 * 确认那一下。**这是这个产品里唯一一次权力转移**：一句参谋的候选变成公司口径。
 *
 * 两条路走到同一个地方 —— 板上那颗按钮（`confirmBoardJudgement`）和对谈里那一句
 * 「第 2 条我认了，因为……」（`settleTurn` 里的 `confirms`）—— 底下是同一个
 * `applyConfirm`。这里钉的是那个共用出口记进库的东西：谁在什么时候、通过哪条路、
 * 凭什么把这一条认下来的。
 *
 * 三条不变量各自的坏法都不出声：
 *
 * - 没写凭什么也放过 → 半年后重新打开这条判断，账上只有「已确认」四个字。
 * - `channel` 记错 → 「这条是会上定的还是我自己聊着定的」再也答不出来。
 * - 认过的能再认一次 → 时间戳和理由被后一次盖掉，第一次那句话消失。
 *
 * 走 demo 那一档是因为板上要**先有几条候选**才谈得上确认，而 live 档的板由 A5 读报告
 * 现长出来（要真调模型）。demo 档 `boards["ISS-D4"]` 里五条全在上半层，正是这几条
 * 断言要的起点。单独一个文件：`TKOS_MODE` 必须在 `store.ts` 被 import 之前定下来。
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { api as Api } from "./store";

let api: typeof Api;

beforeAll(async () => {
  process.env.TKOS_MODE = "demo";
  process.env.TKOS_PERSIST = "0";
  process.env.TKOS_MODEL_MOCK = "1";
  api = (await import("./store")).api;
});

const ISSUE = "ISS-D4";
const SUPPORT = "两个客户的决策人都换了，这条赌注的前提已经不在了。";

describe("把一条判断认下来", () => {
  it("记下时刻、途径和他自己给的理由，那一条从上半层挪到下半层", async () => {
    const before = await api.getBoard(ISSUE);
    const target = before.draft.find((b) => b.id === "BJ-D4-1");
    expect(target).toBeDefined();
    expect(before.confirmed).toHaveLength(0);

    const after = await api.confirmBoardJudgement("BJ-D4-1", "dialogue", SUPPORT);

    expect(after.draft.some((b) => b.id === "BJ-D4-1")).toBe(false);
    const landed = after.confirmed.find((b) => b.id === "BJ-D4-1");
    expect(landed?.confirmed?.channel).toBe("dialogue");
    // 理由必须是**他的原话**，不是「已确认」这种系统话术。
    expect(landed?.confirmed?.support).toBe(SUPPORT);
    expect(Date.parse(landed?.confirmed?.at ?? "")).not.toBeNaN();

    // 账上也要留一条，而且带着那句理由 —— 板是当前状态，账是当时发生了什么。
    const events = await api.getTimeline(ISSUE);
    const logged = events.find((e) => e.headline === "判断已确认 · 对谈中");
    expect(logged?.kind).toBe("judgment");
    expect(logged?.detail).toContain(SUPPORT);
  });

  it("没写凭什么就报错 —— 这是他刚点的一下，必须给回话", async () => {
    await expect(api.confirmBoardJudgement("BJ-D4-2", "dialogue", "   ")).rejects.toThrow(
      /凭什么/,
    );
    // 报错之后那一条还在上半层，没被半途改掉。
    expect((await api.getBoard(ISSUE)).draft.some((b) => b.id === "BJ-D4-2")).toBe(true);
  });

  it("认过的不许再认一次 —— 第二次会把第一次那句理由盖掉", async () => {
    await api.confirmBoardJudgement("BJ-D4-3", "meeting", "会上三个人都同意这条口径。");
    await expect(
      api.confirmBoardJudgement("BJ-D4-3", "dialogue", "换个理由再认一次"),
    ).rejects.toThrow(/已经确认过/);

    const landed = (await api.getBoard(ISSUE)).confirmed.find((b) => b.id === "BJ-D4-3");
    expect(landed?.confirmed?.channel).toBe("meeting");
    expect(landed?.confirmed?.support).toBe("会上三个人都同意这条口径。");
  });

  /*
   * 板上那颗按钮记的是 `manual`（见 `ConfirmChannel`）—— 他手上按的这一下既不是在
   * 对谈里，也不是在会上。以前那颗按钮逼他先在这两档里选一个，猜出来的途径半年后
   * 比不记还糟：账上写着「会上确认」，而那场会根本没开过。
   */
  it("板上按下的那一下记「手动」，不冒充成对谈里或会上认的", async () => {
    await api.confirmBoardJudgement("BJ-D4-4", "manual", SUPPORT);

    const landed = (await api.getBoard(ISSUE)).confirmed.find((b) => b.id === "BJ-D4-4");
    expect(landed?.confirmed?.channel).toBe("manual");

    const events = await api.getTimeline(ISSUE);
    const logged = events.find((e) => e.headline === "判断已确认 · 手动");
    expect(logged?.detail).toContain(SUPPORT);
  });

  it("指到板上没有的编号：报错，不静静地什么都不做", async () => {
    await expect(api.confirmBoardJudgement("BJ-NOPE-9", "dialogue", SUPPORT)).rejects.toThrow(
      /找不到/,
    );
  });
});
