/**
 * 粘一件已经定了的战略议题进来（`addStrategicIssue`）。**深研调试期间的临时入口。**
 *
 * 钉的是这一下和产品那条正路的**分工**，不是跑出来的东西好不好（后者要真调模型）：
 *
 *   · 它直接落成在办议题并起深研 —— 「值不值得占我时间」这个决定他已经做完了。
 *   · 它**不进提请台**：一件调试用的议题不该在那份清单上留一行等他处置。
 *
 * 这两条各自都是「反过来也跑得通、但产品上就错了」的那种：落成潜在议题也不会报错，
 * 只是他每粘一件就要多按一次三键；深研不起也不会报错，只是屏幕上那句「进行中」是假的。
 *
 * 深研这一轮会就地失败：单测出不了网（`store.triggers.test.ts` 头部讲了为什么），
 * 所以这里只断言「起没起」。
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { api as Api } from "./store";

let api: typeof Api;

beforeAll(async () => {
  // 别读也别写 .data 里那份真快照；也不许把钱花出去（同 `store.triggers.test.ts`）。
  process.env.TKOS_PERSIST = "0";
  process.env.TKOS_MODEL_MOCK = "1";
  api = (await import("./store")).api;
});

describe("粘进来的那一件直接开跑深研", () => {
  it("立成在办议题（研究中），深研当场就起，卡上那句「进行中」是真的", async () => {
    const { issueId, research } = await api.addStrategicIssue(
      "要不要把交付这件事从项目制改成产品制"
    );

    const issue = await api.getIssue(issueId);
    // Candidate 是坏的那一档：那意味着他还要去提请台上再按一次三键。
    expect(issue.state).toBe("Exploring");
    expect(issue.origin).toBe("manual");
    // 域留空是诚实的空 —— 这件事碰的是哪块生意还没人接出来。
    expect(issue.domainId).toBeUndefined();

    // idle 才是坏的那一档：那意味着这一轮要等他点进议题研究页才开始。
    expect(research.status).not.toBe("idle");
    expect((await api.deepResearchStatus(issueId)).status).not.toBe("idle");
    expect(issue.monitoringNote).toBe("深度研究进行中");
    // 这一版把「报告就绪后提醒您」删了：全仓没有任何通知机制，那是一句许诺不了的话。
    // 反面钉住它 —— 只断言新字符串的话，哪天有人把那半句加回来，这条照样绿。
    expect(issue.monitoringNote).not.toContain("提醒");
  });

  it("不落提请台 —— 那份清单上每一行都该是等他处置的", async () => {
    const { issueId } = await api.addStrategicIssue("客户续约的口径要不要统一到一个人手上");

    const pending = await api.listPending();
    expect(pending.find((c) => c.issueId === issueId)).toBeUndefined();

    // 时间线上要说清它是怎么进来的，否则半年后没人分得清哪几件是试出来的。
    const timeline = await api.getTimeline(issueId);
    expect(timeline.some((e) => e.headline.includes("粘进来"))).toBe(true);
  });

  it("贴一整篇进来时标题是起出来的一行，不是那一整篇", async () => {
    const body = `我们要不要把研究这件事按域拆给各自的承接人。${"这一段是他贴进来的原文。".repeat(20)}`;
    const { issueId } = await api.addStrategicIssue(body);

    const issue = await api.getIssue(issueId);
    expect(issue.title).not.toBe(body);
    // 一行标题的量级。原文（几百字）当深研的「范围与背景」递下去，不占这一行。
    expect(issue.title.length).toBeLessThanOrEqual(60);
  });

  it("空的立不起来", async () => {
    await expect(api.addStrategicIssue("   ")).rejects.toThrow();
  });
});
