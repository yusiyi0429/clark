import { describe, expect, it } from "vitest";

import { FIXTURE_BLOCK_COUNT, FIXTURE_JSONL } from "./fixture";
import { parseBlocks } from "./parse";
import { normalizeRef, readBlock, type JudgmentBlock, type LayeredTableBlock } from "./schema";

const line = (o: unknown): string => JSON.stringify(o);

describe("parseBlocks", () => {
  it("验收 fixture 十五个块全部出来，一行都没坏", () => {
    const r = parseBlocks(FIXTURE_JSONL, { complete: true });
    expect(r.meta?.title).toContain("瓶颈在上架与调度");
    expect(r.meta?.confidence).toBe("较强支持");
    expect(r.blocks).toHaveLength(FIXTURE_BLOCK_COUNT);
    expect(r.bad).toEqual([]);
    expect(r.pending).toBe("");
    // 十五种块各一种以上：类型齐了才谈得上「渲染通过全部组件」。
    expect(new Set(r.blocks.map((b) => b.type)).size).toBe(15);
  });

  it("流式：没写完的最后一行是 pending，不算坏行", () => {
    const cut = FIXTURE_JSONL.slice(0, Math.floor(FIXTURE_JSONL.length * 0.55));
    expect(cut.endsWith("\n")).toBe(false);
    const r = parseBlocks(cut);
    expect(r.blocks.length).toBeGreaterThan(2);
    expect(r.blocks.length).toBeLessThan(FIXTURE_BLOCK_COUNT);
    expect(r.bad).toEqual([]);
    expect(r.pending.length).toBeGreaterThan(0);
    // 前缀里的块和整份里的前几个块是同一批 —— 边跑边渲染不会中途变样。
    const whole = parseBlocks(FIXTURE_JSONL, { complete: true });
    expect(r.blocks).toEqual(whole.blocks.slice(0, r.blocks.length));
  });

  it("收尾那一次，半截的最后一行就是坏行", () => {
    const cut = FIXTURE_JSONL.slice(0, Math.floor(FIXTURE_JSONL.length * 0.55));
    const r = parseBlocks(cut, { complete: true });
    expect(r.pending).toBe("");
    expect(r.bad).toHaveLength(1);
    expect(r.bad[0].why).toContain("不是合法 JSON");
  });

  it("一行坏掉只丢一行", () => {
    const text = [
      line({ type: "prose", md: "第一段。" }),
      '{"type":"prose","md":"这里有个裸引号"漏出来了"}',
      line({ type: "prose", md: "第三段。" }),
      "",
    ].join("\n");
    const r = parseBlocks(text, { complete: true });
    expect(r.blocks).toHaveLength(2);
    expect(r.bad).toHaveLength(1);
    expect(r.bad[0].line).toBe(2);
  });

  it("代码块围栏静默跳过，空行也一样", () => {
    const text = ["```json", line({ type: "prose", md: "正文。" }), "", "```", ""].join("\n");
    const r = parseBlocks(text, { complete: true });
    expect(r.blocks).toHaveLength(1);
    expect(r.bad).toEqual([]);
  });

  it("交了两行元数据以第一行为准，第二行记账", () => {
    const text = [
      line({ type: "report_meta", title: "先来的这一句", confidence: "较强支持", dataCutoff: "2026-08-20" }),
      line({ type: "report_meta", title: "后来的那一句" }),
      line({ type: "prose", md: "正文。" }),
      "",
    ].join("\n");
    const r = parseBlocks(text, { complete: true });
    expect(r.meta?.title).toBe("先来的这一句");
    expect(r.bad).toHaveLength(1);
    expect(r.bad[0].why).toContain("第二行 report_meta");
  });

  it("整篇裹成一个数组交上来：收下，但记一条", () => {
    const arr = [
      { type: "report_meta", title: "标题即判断", confidence: "初步提示", dataCutoff: "2026-08-01" },
      { type: "prose", md: "正文。" },
      { type: "falsify_card", conditions: ["出现反例"] },
    ];
    const r = parseBlocks(JSON.stringify(arr), { complete: true });
    expect(r.meta?.title).toBe("标题即判断");
    expect(r.blocks).toHaveLength(2);
    expect(r.bad).toHaveLength(1);
    expect(r.bad[0].why).toContain("整篇是一个 JSON 数组");
  });

  it("流式中途的半截数组不兜 —— 它永远 parse 不出来", () => {
    const r = parseBlocks('[{"type":"prose","md":"正文');
    expect(r.blocks).toEqual([]);
    expect(r.bad).toEqual([]);
    expect(r.pending.length).toBeGreaterThan(0);
  });
});

describe("readBlock", () => {
  it("认不出的类型报出那个词，不静默丢", () => {
    const r = readBlock({ type: "timeline_chart", items: [] });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.why).toContain("timeline_chart");
  });

  it("空块拒掉：一块空白在 lint 里没有可指认的对象", () => {
    expect(readBlock({ type: "prose", md: "   " }).ok).toBe(false);
    expect(readBlock({ type: "kpi_cards", cards: [] }).ok).toBe(false);
    expect(readBlock({ type: "funnel", stages: [{ label: "只有一级", value: 1 }] }).ok).toBe(false);
    expect(readBlock({ type: "divergence_view", topic: "只有一方", positions: [{ lane: "A", verdict: "是" }] }).ok).toBe(
      false
    );
  });

  it("缺证伪条件的判断照旧收下 —— 那一条归 lint 报", () => {
    const r = readBlock({
      type: "judgment",
      claim: "这一轮的瓶颈在调度",
      confidence: "较强支持",
      direction: "支持",
    });
    expect(r.ok).toBe(true);
    const b = (r as { value: JudgmentBlock }).value;
    expect(b.falsifyCondition).toBe("");
    expect(b.defaulted).toBeUndefined();
  });

  it("没写分档的判断留一条记账：「写了初步提示」和「压根没写」要分得出", () => {
    const r = readBlock({ type: "judgment", claim: "瓶颈在调度" });
    const b = (r as { value: JudgmentBlock }).value;
    expect(b.confidence).toBe("初步提示");
    expect(b.defaulted).toEqual(["confidence", "direction"]);
  });

  it("分层表的档次给不齐就整列不要，不半列半空", () => {
    const ok = readBlock({
      type: "layered_table",
      columns: ["A", "B"],
      rows: [["1", "2"], ["3", "4"]],
      rowGrade: ["A", "C"],
    });
    expect((ok as { value: LayeredTableBlock }).value.rowGrade).toEqual(["A", "C"]);

    const half = readBlock({
      type: "layered_table",
      columns: ["A", "B"],
      rows: [["1", "2"], ["3", "4"]],
      rowGrade: ["A"],
    });
    expect((half as { value: LayeredTableBlock }).value.rowGrade).toBeUndefined();
  });

  it("证据利用率那一块：编号归一，缺理由照旧收下", () => {
    /*
     * 缺理由要在 lint（A4-B11）那里被拒，所以这里必须收下 —— 在这里拒的表现是那一行
     * 凭空消失，然后 A4-B11 报的变成「这一份压根没有 evidence_usage」，返修那一轮
     * 被问的问题就跟真错的地方对不上了。
     */
    const r = readBlock({
      type: "evidence_usage",
      used: ["e1", "[E2]", "3"],
      discarded: [{ id: "E4", reason: "" }, { reason: "没有编号的这一条留不下来" }],
    });
    expect(r.ok).toBe(true);
    expect(r.ok && r.value.type === "evidence_usage" && r.value.used).toEqual(["E1", "E2", "E3"]);
    expect(r.ok && r.value.type === "evidence_usage" && r.value.discarded).toEqual([
      { id: "E4", reason: "" },
    ]);
  });

  it("两边都空的那一行等于没交", () => {
    // 一块只写了 type 的对账渲染出来是一句「都去哪儿了」加一片空白，而它没有任何可对账的内容。
    expect(readBlock({ type: "evidence_usage", used: [], discarded: [] }).ok).toBe(false);
  });

  it("步长为 0 的滑块拖不动，按量程补一个", () => {
    const r = readBlock({
      type: "param_model",
      params: [{ id: "price", label: "电价", default: 0.5, min: 0, max: 1, step: 0 }],
      outputs: [{ label: "日电费", expr: "price * 24" }],
      disclaimer: "只算电费",
    });
    expect(r.ok).toBe(true);
    expect(r.ok && r.value.type === "param_model" && r.value.params[0].step).toBeCloseTo(0.01);
  });
});

describe("normalizeRef", () => {
  it("三种写法归成同一个字符串", () => {
    for (const raw of ["E3", "e3", " [E3] ", "3"]) expect(normalizeRef(raw)).toBe("E3");
  });
});
