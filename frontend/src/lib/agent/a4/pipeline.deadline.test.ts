/**
 * **到点交东西出来，并且说清少做了什么。**
 *
 * 2026-08-27 那一轮（ISS-112）跑了 47 分钟没出稿，一号位当时定的口径是 20 分钟；2026-09-01
 * 换到网宿之后单次生成的时延翻了几倍，那个数从实测上装不下，口径改成 30 分钟
 * （`deadline.ts` 的 `DEFAULT_DEADLINE_MS`）。**这一条测的不是那个数**，测的是到点收口
 * 这件事本身，所以它自己压一个上限、不读默认值。这一条把上限
 * 压到 25 秒再跑一整条：假模型是瞬时返回的，所以真正被压掉的不是「跑得慢」，而是每一步开始
 * 之前那一问 —— 剩下的时间凑不出「这一步 + 后面必须做的事」就不开始（`deadline.ts`）。
 *
 * 25 秒是挑过的：它比「一次调用值得发」的下限（`CALL_FLOOR_MS`，20 秒）大，所以调用照旧发得
 * 出去，测的是**取舍**而不是「时间到了一次都发不出去」。
 *
 * 打桩注意与 `pipeline.test.ts` 同：`openContext` 在这台机器上连不到图服务，必须打成转纯
 * 外部那一档。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runDeepResearchV2 } from "./pipeline";
import type { A4Input } from "./prompt";

vi.mock("@/lib/ontology/context", () => ({ openOntologyContext: vi.fn() }));

const { openOntologyContext } = await import("@/lib/ontology/context");
type Opened = Awaited<ReturnType<typeof openOntologyContext>>;
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

const input = (title: string): A4Input => ({
  issueId: "ISS-DEADLINE",
  title,
  scope: null,
  preTake: null,
  preOpenQuestions: [],
  judgments: [],
});

describe("到点收口", () => {
  beforeEach(() => {
    process.env.TKOS_MODEL_MOCK = "1";
    process.env.TKOS_DR_V2 = "1";
    process.env.TKOS_A4_DEADLINE_MS = "25000";
    vi.mocked(openOntologyContext).mockReset();
    vi.mocked(openOntologyContext).mockResolvedValue(external);
  });
  afterEach(() => {
    delete process.env.TKOS_MODEL_MOCK;
    delete process.env.TKOS_DR_V2;
    delete process.env.TKOS_A4_DEADLINE_MS;
  });

  it("时间不够时照旧交出一份报告，而且缺口清单里说得出是时间压掉的", async () => {
    const r = await runDeepResearchV2(input("时间不够的一轮"));

    // 1. 交东西出来 —— 不是抛超时，也不是一份空文档。
    expect(r.run.status).toBe("ok");
    expect((r.doc.sourceText ?? "").length).toBeGreaterThan(0);

    // 2. 少做的那几件事**印在报告文首**。少搜而不说的话，一份因为到点收口的报告和一份
    //    「外面就是没有材料」的报告在屏幕上一模一样。
    const head = r.doc.sourceText ?? "";
    expect(head).toContain("【本轮机检未过的部分】");
    expect(head).toContain("这一轮的时间上限是 25 秒");
    expect(head).toContain("按现状收口");
  });

  it("草稿都没时间写，取证整段不发，并且说出来", async () => {
    const r = await runDeepResearchV2(input("一波都发不出的一轮"));
    // 一波都发不出 = 一轮取证都没有。这不是「搜过没找到」。
    expect(r.evidencing.rounds).toHaveLength(0);
    const head = r.doc.sourceText ?? "";
    // 25 秒连草稿都排不下：草稿空着，命题无从抽（2026-09-06 起空草稿不排计划），取证连链都不起。
    expect(head).toContain("N1 草稿是空的，检索计划与取证不跑");
  });

  it("上限给足时不留任何一句「按现状收口」—— 那几句只在真压掉了才写", async () => {
    process.env.TKOS_A4_DEADLINE_MS = String(30 * 60_000);
    const r = await runDeepResearchV2(input("时间够的一轮"));
    expect(r.run.status).toBe("ok");
    expect(r.doc.sourceText ?? "").not.toContain("按现状收口");
    // 时间够的那一轮取证是真跑了的 —— 否则上一条测的就不是时间。
    expect(r.evidencing.rounds.length).toBeGreaterThanOrEqual(1);
  });
});
