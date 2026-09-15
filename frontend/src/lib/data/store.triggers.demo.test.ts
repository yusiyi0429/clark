/**
 * 同两个触发点的另一头：**demo 那一档一次模型都不叫。**
 *
 * 自动触发的东西一旦不自动了就没人会想起它；反过来，自动触发的东西装到 demo 那一档上，
 * 后果是演示当中屏幕自己开始起一到三分钟的模型调用 —— 一号位盯着一个转圈，而屏幕答不出
 * 它什么时候会停，钱也照花。所以这两处各自挡了 demo（`ensurePreResearch` /
 * `ensureDeepResearch`），这里把那两道挡钉住。
 *
 * 单独一个文件是因为 `store.ts` 是模块级单例：`TKOS_MODE` 必须在它被 import 之前定下来。
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { api as Api } from "./store";

let api: typeof Api;

beforeAll(async () => {
  process.env.TKOS_MODE = "demo";
  process.env.TKOS_PERSIST = "0";
  // 挡漏了的话，下面的断言照样会红；打开假模型只是保证它红在断言上，而不是红在账单上。
  process.env.TKOS_MODEL_MOCK = "1";
  api = (await import("./store")).api;
});

describe("demo 档：两个自动触发点都不起模型", () => {
  it("addIssue 不起预研，卡上照实写「还没查过」", async () => {
    const issue = await api.addIssue("演示当中随手加的一件事");
    expect((await api.preResearchStatus(issue.id)).status).toBe("idle");

    const card = (await api.listPending()).find((c) => c.issueId === issue.id);
    // 「参谋已经在查了」那句话只在真起了一轮的时候才写得出来。
    expect(card?.why).toBe("您自己提的，系统还没查过。");
  });

  it("采信不起深研，也不写那句「进行中」", async () => {
    const issue = await api.addIssue("演示当中随手加的第二件事");
    const card = (await api.listPending()).find((c) => c.issueId === issue.id);
    expect(card).toBeDefined();

    const after = await api.disposeCard(card!.id, "discuss");
    expect(after.state).toBe("Exploring");
    // 没有东西在跑，就不许许下「报告就绪后提醒您」这个承诺。
    expect(after.monitoringNote).toBeUndefined();
    expect((await api.deepResearchStatus(issue.id)).status).toBe("idle");
  });
});
