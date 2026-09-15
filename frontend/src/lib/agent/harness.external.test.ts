/**
 * `Harness.contextBlock` 的**第二支**：开过上下文、但这次转了纯外部。
 *
 * 为什么单独一个文件：`harness.test.ts` 里锁住的是「从没开过上下文」那一支，而实测
 * 最常走的恰好是这一支（正式包的议题在图谱向量索引里检索不到，两次真模型整跑都是
 * 纯外部）。「上下文段永不返回空串」是这支分支的头号硬要求 —— 空串会让模型把那个位置
 * 当成缺口去填，编一套公司战略假设出来再正常引用，产出格式全对、引用看着也有，只是
 * 全是假的。要打桩 `openContext`，而 `harness.test.ts` 其余用例不该被这个 mock 影响。
 *
 * 打桩注意（同 `company-context.test.ts`）：先静态 import 被测的消费方，再动态 import
 * 被 mock 的模块 —— 顺序反了，`vi.importActual` 会把真模块塞进模块缓存。
 */
import { describe, expect, it, vi } from "vitest";

import { Harness, NO_COMPANY_CONTEXT } from "./harness";

vi.mock("@/lib/ontology/context", () => ({ openOntologyContext: vi.fn() }));

const { openOntologyContext } = await import("@/lib/ontology/context");
const mocked = vi.mocked(openOntologyContext);

type Opened = Awaited<ReturnType<typeof openOntologyContext>>;

const external = {
  mode: "external_only",
  bundle: null,
  anchor: null,
  noAnchorReason: "这一池分不出高低（前 4 名分数拉不开）",
  staticContext: "",
  snapshotId: null,
  trace: [{ at: "2026-08-19T00:00:00.000Z", label: "P3 候选池", kind: "graph", detail: {} }],
  warnings: [],
} as unknown as Opened;

/** 同一支的中间那一档：锚点没命中，但【公司经营状态】取到了。 */
const stateOnly = { ...external, staticContext: "本期 Outcome 还剩 12 天。毛利率 41%。" } as Opened;

describe("上下文段 · 开过但转纯外部", () => {
  it("contextBlock 是那段带硬约束的话，不是空串", async () => {
    mocked.mockReset();
    mocked.mockResolvedValue(external);

    const h = new Harness({ agent: "A1a" });
    expect(await h.openContext("S01", "入口移到交付侧之后我们还剩什么")).toBe(false);

    expect(h.externalOnly).toBe(true);
    expect(h.contextBlock.startsWith("（本次没有公司上下文）")).toBe(true);
    expect(h.contextBlock).toBe(NO_COMPANY_CONTEXT);
    expect(h.contextBlock.length).toBeGreaterThan(100);
    // 没有 member 可引 —— 这条路上「引用为空」才是对的。
    expect(h.memberIds.size).toBe(0);
  });

  /*
   * 中间那一档必须**自成一段话**，不能复用另外两档任何一句。
   *
   * 说成完整上下文，模型会写「公司现有判断是……」；继续用 NO_COMPANY_CONTEXT，就是
   * 手里有真实经营状态却告诉模型什么都没有。这一条锁的就是这两种偷懒。
   */
  it("取到【公司经营状态】时，contextBlock 换成中间那一档：带上正文，引用照旧必须为空", async () => {
    mocked.mockReset();
    mocked.mockResolvedValue(stateOnly);

    const h = new Harness({ agent: "A4" });
    expect(await h.openContext("S03", "入口移到交付侧之后我们还剩什么")).toBe(false);

    expect(h.externalOnly).toBe(true);
    expect(h.companyStateOnly).toContain("本期 Outcome");
    expect(h.contextBlock).not.toBe(NO_COMPANY_CONTEXT);
    // P0 正文原样在里面 —— 不在的话这次改动等于只换了一段说明文字。
    expect(h.contextBlock).toContain("本期 Outcome 还剩 12 天。");
    expect(h.contextBlock).toContain("cited_member_ids");
    expect(h.contextBlock).toContain("[]");
    // P0 那条路不产生任何 memberId，所以「引用必须为空」这条不因为装了它而放松。
    expect(h.memberIds.size).toBe(0);
  });

  it("台账上认得出这次是纯外部，以及为什么没锚上", async () => {
    mocked.mockReset();
    mocked.mockResolvedValue(external);

    const h = new Harness({ agent: "A1a" });
    await h.openContext("S01", "入口移到交付侧之后我们还剩什么");
    const rec = h.finish({ status: "ok", input: "x", output: {} });

    expect(rec.contextMode).toBe("external_only");
    expect(rec.noAnchorReason).toContain("分不出高低");
    // 「这次试的是哪个配方」跟锚没锚上无关：纯外部时也要记得住，否则复现不了。
    expect(rec.contextRecipe).toBe("S01");
    expect(rec.snapshotId).toBe("");
    expect(rec.trace.some((n) => n.label === "转纯外部")).toBe(true);
  });
});
