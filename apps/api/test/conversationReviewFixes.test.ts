import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { ConversationCard, ConversationSseEvent, type TWeeklyReviewBody } from "@warmap/contracts";
import type { ConversationRuntime } from "../src/conversations.js";
import { CEO_SYSTEM_PROMPT, driSystemPrompt } from "../src/piConversationRuntime.js";
import type { WeeklyReviewDraftInput } from "../src/weeklyReviewGeneration.js";
import { weeklyRecords } from "../src/weeklyReviewGeneration.js";
import { createTestApp, TEST_MEMBER, type TestApp } from "./helpers.js";

/**
 * 10/18 走查发现的对话问题：「帮我问问」对上两件待办时要出点选卡（不让模型自己用文字反问）；对话里「帮我写这周复盘」接上周复盘生成。
 * （读周复盘正文见 companyMap.test.ts，检索问答档不加开场白见 segmentedOutput.test.ts。）
 */
const PEOPLE = fileURLToPath(new URL("./fixtures/company-people-candidate.json", import.meta.url));
const NOW = new Date("2026-10-16T07:30:00Z"); // 北京时间周五 15:30

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => { await cleanup?.(); cleanup = undefined; });

describe("帮我问问：对上两件待办", () => {
  it("提示词不再让模型自己对照 myOpenTodos 反问，而是直接调用 ask_about_todo，由系统定位、界面出点选卡", () => {
    for (const prompt of [CEO_SYSTEM_PROMPT, driSystemPrompt("测试乙")]) {
      expect(prompt).not.toContain("先在这里对照是哪一件");
      expect(prompt).toContain("不管这里对得上几件，都直接调用 ask_about_todo");
      expect(prompt).toContain("不要自己用文字反问是哪一件");
    }
  });
});

describe("对话里生成周复盘", () => {
  it("「帮我写这周复盘」：六步实时显示，完成后回答下面挂周复盘卡，点「打开修改」进周复盘页；已提交的不再重新生成", async () => {
    const link = (record: { label: string; cite: string }) => `[${record.label}](${record.cite})`;
    const cited = (input: WeeklyReviewDraftInput): TWeeklyReviewBody => {
      const first = weeklyRecords(input)[0];
      const line = (text: string) => (first ? `${text}${link(first)}。` : "缺少记录：这一周没有任何记录。");
      // 没有记录时按 D-33：整段只写缺少记录，但仍套模板（状态行、判断变化、当前处理三选一开头）。
      const lead = (head: string, text: string) => (first ? line(`${head}｜${text}`) : `${head}｜缺少记录：这一周没有任何记录。`);
      return { overall: { text: lead("状态：绿", "按计划推进"), sources: [] }, progress: { text: line("采集器上线"), sources: [] },
        issues: { text: line("验收口径没定"), sources: [] }, implications: { text: lead("仍待验证", "口径定了才知道"), sources: [] },
        actions: { text: lead("继续推进", "下周定口径"), sources: [] }, nextWeek: { text: line("定验收口径"), sources: [] } };
    };
    let result: Record<string, unknown> | undefined;
    const runtime: ConversationRuntime = { async run(input) {
      result = await input.entries!.generateReview({ kind: "weekly" });
      input.emit({ type: "message", delta: "草稿好了" });
      return { assistantMessage: "草稿好了", runtimeEntries: input.runtimeEntries };
    } };
    const t: TestApp = await createTestApp({ companyPeopleSeed: PEOPLE }, runtime, {
      monthlyNow: () => NOW, weeklyReviewAgent: { async generate(input) { return { candidate: cited(input) }; } },
    });
    cleanup = () => t.close();
    const member = await t.memberCookie();
    const send = () => t.app.inject({ method: "POST", url: "/api/conversations/global/messages", headers: { cookie: member, origin: t.publicOrigin }, payload: { message: "帮我写这周复盘" } });

    const response = await send();
    const events = response.body.trim().split("\n\n").flatMap((block) => block.split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6))));
    for (const event of events) expect(Value.Check(ConversationSseEvent, event)).toBe(true);
    const labels = [...new Set(events.filter((event) => event.type === "step" && String(event.id).startsWith("weekly-")).map((event) => event.label))];
    expect(labels).toEqual(["读 Mission 卡", "读 Mission 与 Task 进展", "读会议结论", "读采集记录", "读上周复盘", "起草"]);
    const finalSteps = new Map(events.filter((event) => event.type === "step").map((event) => [event.id, event.status]));
    expect(finalSteps.get("weekly-draft")).toBe("done");
    expect(result).toMatchObject({ generated: true, week: "10/12 这一周" });

    const review = (await t.sql("SELECT id, status FROM weekly_reviews WHERE person_id = $1 AND week_start = '2026-10-12'", [TEST_MEMBER.personId]))[0];
    expect(review.status).toBe("draft");
    const history = (await t.app.inject({ method: "GET", url: "/api/conversations/global/messages", headers: { cookie: member } })).json() as { messages: { cards?: unknown[] }[] };
    const card = history.messages.at(-1)!.cards![0];
    expect(Value.Check(ConversationCard, card)).toBe(true);
    expect(card).toEqual({ kind: "weekly_review", weeklyReviewId: review.id, href: `/me/weekly-reviews/${review.id}` });

    // 提交以后再说一次：不重新生成，如实说已提交，卡照样挂上。
    await t.sql("UPDATE weekly_reviews SET status = 'submitted', submitted_at = now() WHERE id = $1", [review.id]);
    await send();
    expect(result).toMatchObject({ generated: false, reason: expect.stringContaining("已经提交") });
  }, 120_000);
});
