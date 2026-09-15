/**
 * 这一支跑的时候，**手上那一份有没有被摆到任务表上**（`pipeline.ts` 的 `keep`）。
 *
 * ## 为什么这条要单独测，而且要测在产线这一侧
 *
 * 「一轮没跑完也要留下已经写出来的东西」这件事已经有测试了 ——
 * `store.research-salvage.test.ts`。但那一份把 `runDeepResearch` 整个 mock 掉，自己叫一次
 * `taskReports(...)` 再抛。也就是说它验的是**库那一侧接不接得住**，从来没验过真实产线会不会
 * 报。于是 2026-08-26 默认从四链路转到这一支时，产线那一头断了而测试全绿：这一支七个
 * `h.step()` 一个 `h.reports()` 都没有，`UnfinishedResearchRound.reports` 在默认路上恒为空。
 * 2026-08-31 的 ISS-208 是第一件有账可查的（活了不到 16 分钟，留下 0 份原件）。
 *
 * 所以这一份认的是**那一次上报本身**：打掉 `@/lib/agent/tasks`，数 `taskReports` 被叫了几次、
 * 递上去的是什么。不走 store，因为 store 那一侧已经有人验了 —— 这里要按住的是那条线的上游。
 *
 * 打桩注意（同 `pipeline.test.ts`）：先静态 import 被测的消费方，再动态 import 被 mock 的
 * 模块 —— 顺序反了，`vi.importActual` 会把真模块塞进模块缓存，`openContext` 就会真的去连图
 * 服务，而这台机器上没有。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runDeepResearch } from "./run";
import type { A4Input } from "./prompt";
import type { DraftReport } from "@/lib/data/types";

process.env.TKOS_MODEL_MOCK = "1";

/** 这一轮里 `taskReports` 收到的每一份清单，按先后排。 */
const reported: DraftReport[][] = [];

vi.mock("@/lib/agent/tasks", async () => {
  const actual = await vi.importActual<typeof import("@/lib/agent/tasks")>("@/lib/agent/tasks");
  return {
    ...actual,
    /*
     * 真的那一个头一句是「不是 running 就返回」，而这里没有一张真任务表 —— 不打掉的话
     * 这个测试永远绿，因为一次都不会走到 sink 那一句。
     */
    taskReports: (_kind: string, _id: string, list: DraftReport[]) => {
      reported.push(list.map((d) => ({ ...d })));
    },
    taskStep: () => {},
  };
});

vi.mock("@/lib/ontology/context", () => ({ openOntologyContext: vi.fn() }));

const { openOntologyContext } = await import("@/lib/ontology/context");
type Opened = Awaited<ReturnType<typeof openOntologyContext>>;
/** 纯外部那一档 —— 一号位真机上两次整跑走的都是它（同 `pipeline.test.ts`）。 */
const external = {
  mode: "external_only",
  bundle: null,
  anchor: null,
  noAnchorReason: "这一池分不出高低（前 4 名分数拉不开）",
  staticContext: "",
  snapshotId: null,
  trace: [],
  warnings: [],
} as unknown as Opened;

const input = (title = "维信诺所处的行业"): A4Input => ({
  issueId: "ISS-TEST",
  title,
  scope: null,
  preTake: null,
  preOpenQuestions: [],
  judgments: [],
});

/** 有正文的那几份 —— `keepFinishedReport` 只留这一种，别的落不进库。 */
const withText = (): DraftReport[] =>
  reported.flat().filter((d): d is DraftReport => Boolean(d.text?.trim()));

describe("跑的时候把手上那一份摆出去（落盘那条线的上游）", () => {
  beforeEach(() => {
    reported.length = 0;
    delete process.env.TKOS_DR_V2;
    vi.mocked(openOntologyContext).mockResolvedValue(external);
  });

  it("默认那条路报过带正文的原件 —— 这一条断了，被掐断的那一轮就什么都留不下", async () => {
    await runDeepResearch(input(), { progress: { kind: "deep", id: "ISS-TEST" } });
    expect(withText().length).toBeGreaterThan(0);
  }, 120_000);

  it("页签 key 是 `agent` —— 和落库之后那一份一模一样", async () => {
    /*
     * 对不上的后果不是多一栏：他正读着这一栏，报告落库那一瞬 key 变了，屏幕把他弹回主源
     * （见 `DraftReport.key`）。落库那一份的 key 由 `store.listReports` 给，主源那一栏写死
     * 是 `agent`，而这一版只有一份报告。
     */
    await runDeepResearch(input(), { progress: { kind: "deep", id: "ISS-TEST" } });
    expect([...new Set(withText().map((d) => d.key))]).toEqual(["agent"]);
  }, 120_000);

  it("正文顶着一句「这不是一份跑完的报告」—— 它和一份出稿在屏幕上长得一样", async () => {
    /*
     * 这一句不是客套。一份 N1 草稿是零证据的模型先验，一份 N5 出稿过了三层门，两者摆在同
     * 一栏里长得一模一样 —— 屏幕上那句「出自一轮没跑完的深研」答的是「哪一轮」，答不了
     * 「哪一步」。
     */
    await runDeepResearch(input(), { progress: { kind: "deep", id: "ISS-TEST" } });
    // 先要有东西可查：一份都没报的时候，下面那个 for 一次都不进，这条会空转通过。
    expect(withText().length).toBeGreaterThan(0);
    for (const d of withText()) {
      expect(d.text).toContain("这不是一份跑完的报告");
      expect(d.text).toContain("没有过出口对账");
    }
  }, 120_000);

  it("越跑越新：留下来的那一份换过好几轮，最后一次是成稿", async () => {
    /*
     * 三个落点（N1 草稿 / N4 合并稿 / N5 成稿）各报一次，所以正文至少换过三副样子。只报一次
     * 的话，断在 N5 的那一轮留下的是一份 N1 草稿，而那一轮真正值钱的东西已经写出来了。
     */
    await runDeepResearch(input(), { progress: { kind: "deep", id: "ISS-TEST" } });
    const texts = withText().map((d) => d.text ?? "");
    expect(new Set(texts).size).toBeGreaterThanOrEqual(3);
    // 最后那一份是成稿：只有它带着区块（`ReportBlocks`），前两份没有。
    expect(withText().at(-1)?.blocks).toBeDefined();
  }, 120_000);

  it("四链路那一支照旧报 —— 这一版没把旧路那条线改坏", async () => {
    process.env.TKOS_DR_V2 = "0";
    await runDeepResearch(input(), { progress: { kind: "deep", id: "ISS-TEST" } });
    expect(withText().length).toBeGreaterThan(0);
  }, 120_000);
});
