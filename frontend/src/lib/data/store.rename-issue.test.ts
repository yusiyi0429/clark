// 这两行必须在**任何会摸到 store.ts 的 import 之前**生效，而写在文件顶上不够：
// ESM 的 import 会被提到模块最前面求值，所以静态 import 一律排在这两行赋值之前，
// 真模块在 beforeAll 里 await import（照 `store.judgements.test.ts` 开头那一段）。
//
// TKOS_PERSIST=0：别读也别写 .data 里那份真快照。
process.env.TKOS_PERSIST = "0";
// TKOS_MODEL_MOCK=1：单测里一次模型都不许真调用（addIssue 会起标题、会起一轮预研）。
process.env.TKOS_MODEL_MOCK = "1";

/**
 * 改题。
 *
 * 这里钉住的是这件事唯一会静默坏掉的地方：**议题标题和卡面那一行是同一个字符串**
 * （落卡那几处都写着「卡面最响的一行就是这条议题本身，不另编一句」）。只改一边的话
 * 屏幕上不报错、两页各显示一句，而看的人分不出哪一句是现在这一句。
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { api as Api, __getCardForTest as GetCard } from "./store";

let api: typeof Api;
let __getCardForTest: typeof GetCard;

beforeAll(async () => {
  const store = await import("./store");
  api = store.api;
  __getCardForTest = store.__getCardForTest;
});

describe("改题", () => {
  it("议题标题和卡面那一行一起改 —— 只改一边就是两页各说一句", async () => {
    const issue = await api.addIssue("原来这句话");
    // 前置：这两处本来就是同一个字符串。这条断言塌了的话，下面那条测的就不是同一件事。
    expect(__getCardForTest(issue.id)?.headline).toBe(issue.title);

    const renamed = await api.renameIssue(issue.id, "改过之后这句话");

    expect(renamed.title).toBe("改过之后这句话");
    expect((await api.getIssue(issue.id)).title).toBe("改过之后这句话");
    expect(__getCardForTest(issue.id)?.headline).toBe("改过之后这句话");
  });

  it("账上留着原题 —— 改题是唯一一种「原来那句话再也找不回来」的改动", async () => {
    const issue = await api.addIssue("这句话待会儿会被改掉");
    const before = issue.title;

    await api.renameIssue(issue.id, "新的这句话");

    const retitled = (await api.getTimeline(issue.id)).filter((e) => e.headline === "改题");
    expect(retitled).toHaveLength(1);
    expect(retitled[0].detail).toContain(before);
    expect(retitled[0].actor).toBeTruthy();
  });

  it("改两次就有两条账，不是后一条把前一条盖掉", async () => {
    const issue = await api.addIssue("第一版");
    await api.renameIssue(issue.id, "第二版");
    await api.renameIssue(issue.id, "第三版");

    const retitled = (await api.getTimeline(issue.id)).filter((e) => e.headline === "改题");
    expect(retitled).toHaveLength(2);
    expect(retitled.map((e) => e.detail).join("\n")).toContain("第二版");
  });

  it("空标题不许改", async () => {
    const issue = await api.addIssue("这一句不该被清空");
    const before = issue.title;
    await expect(api.renameIssue(issue.id, "   ")).rejects.toThrow();
    expect((await api.getIssue(issue.id)).title).toBe(before);
  });

  it("一个字都没改就不记账", async () => {
    const issue = await api.addIssue("一模一样的这句");
    await api.renameIssue(issue.id, issue.title);
    expect((await api.getTimeline(issue.id)).filter((e) => e.headline === "改题")).toHaveLength(0);
  });

  it("没有这件议题就照实说，不静默无事发生", async () => {
    await expect(api.renameIssue("ISS-不存在", "随便什么")).rejects.toThrow();
  });
});
