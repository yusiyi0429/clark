import { describe, expect, it } from "vitest";
import { fixtureReport } from "@/lib/agent/a4/blocks/fixture";
import { boardReport, docIdOf, evidenceRefOf, navigableTrace, resolveReportTraces } from "./report-traces";
import type { AgentRunRecord, BoardJudgement, ResearchDoc, Trace } from "./types";

/** 一份只有证据表的报告 —— 这几条测试要的就是「E 编号在哪一份里解析」。 */
const docWith = (evidence: { id: string; url?: string; sourceName?: string }[]): ResearchDoc =>
  ({
    issueId: "ISS-239",
    blocks: {
      title: "",
      confidence: "初步提示",
      dataCutoff: "",
      lane: { model: "m", short: "M" },
      evidencePackId: "p",
      blocks: [],
      evidence: evidence.map((e) => ({
        id: e.id,
        claim: `${e.id} 的说法`,
        sourceName: e.sourceName ?? `${e.id} 的站`,
        sourceType: "公司披露",
        verified: true,
        retrievedAt: "2026-09-07T03:00:00.000Z",
        ...(e.url ? { url: e.url } : {}),
        independenceGroup: `g-${e.id}`,
        grade: "A",
        origin: "ledger",
      })),
    },
  }) as unknown as ResearchDoc;

describe("报告引用按来源快照定位", () => {
  it("旧判断不绑定到后来的同名 E1", () => {
    const oldDoc = { issueId: "ISS-1", blocks: fixtureReport() } as ResearchDoc;
    const newer = { ...oldDoc, sourceText: "later" };
    const j = { origin: "research", issueId: "ISS-1", at: "2026-09-04T18:37:51+08:00" } as BoardJudgement;
    const runs = [
      { agent: "A4", output: oldDoc, finishedAt: "2026-09-04T10:27:35Z" },
      { agent: "A4", output: newer, finishedAt: "2026-09-04T10:37:00Z" },
      { agent: "A5", input: "ISS-1 · title", output: {}, createdAt: "2026-09-04T10:36:25Z", finishedAt: "2026-09-04T10:37:51.874Z" },
    ] as unknown as AgentRunRecord[];
    expect(boardReport(j, runs)).toBe(oldDoc);
    expect(boardReport(j, runs.filter((r) => r.agent !== "A5"))).toBeUndefined();
  });

  it("能定位的编号接到原文，其他说明不变成网址", () => {
    const blocks = fixtureReport();
    blocks.evidence[0] = { ...blocks.evidence[0], id: "E1", url: "https://example.com/original" };
    const doc = { blocks } as ResearchDoc;
    const notes = resolveReportTraces([
      { kind: "int", source: "E1", href: "E1" },
      { kind: "int", source: "反证1", href: "反证1" },
      { kind: "ext", source: "unknown", href: "javascript:alert(1)" },
    ], doc);
    expect(notes[0]).toMatchObject({ kind: "ext", href: "https://example.com/original" });
    // 「反证1」不是编号也不是文档 —— 保留文字，不缀「未定位」（它本来就没有地址）。
    expect(notes[1]).toEqual({ kind: "int", source: "反证1" });
    expect(notes[2].href).toBeUndefined();
    // 没有报告可查 = 解析不出。**不去别处找一个叫 E1 的。**
    expect(resolveReportTraces([{ kind: "int", source: "E1", href: "E1" }])[0].href).toBeUndefined();
  });
});

/* ISS-239：判断板上出现过 `href=/docs/E30`，点开必然报文档不存在。 */
describe("E 编号与文档链接（ISS-239）", () => {
  const doc = docWith([{ id: "E30", url: "https://vip.stock.finance.sina.com.cn/corp/view/a.php?id=1" }]);

  it("`E30` 和旧数据的 `/docs/E30` 解析到同一条外部原文", () => {
    const out = resolveReportTraces(
      [
        { kind: "int", source: "E30", href: "E30" },
        { kind: "int", source: "2025 年报摘要", href: "/docs/E30" },
        { kind: "int", source: "E30", href: "[E30]" },
      ],
      doc
    );
    for (const t of out) {
      expect(t.kind).toBe("ext");
      expect(t.href).toBe("https://vip.stock.finance.sina.com.cn/corp/view/a.php?id=1");
    }
  });

  it("`/docs/E30` 不再因为「以 / 开头」就算有效地址", () => {
    // 连渲染那一侧的最后一道闸也不认它了 —— 老数据不经过解析直接上屏时靠这一句。
    expect(navigableTrace("/docs/E30")).toBe(false);
    expect(navigableTrace("/docs/DOC-51")).toBe(true);
    expect(navigableTrace("/judgments/01-J7")).toBe(true);
    expect(navigableTrace("/nope/x")).toBe(false);
    expect(navigableTrace("//evil.example/x")).toBe(false);
    expect(navigableTrace("https://example.com/a")).toBe(true);
  });

  it("同一个编号在两份报告里是两条证据，不许串联", () => {
    const a = docWith([{ id: "E30", url: "https://a.example/report-a" }]);
    const b = docWith([{ id: "E30", url: "https://b.example/report-b" }]);
    const note: Trace[] = [{ kind: "int", source: "E30", href: "E30" }];
    expect(resolveReportTraces(note, a)[0].href).toBe("https://a.example/report-a");
    expect(resolveReportTraces(note, b)[0].href).toBe("https://b.example/report-b");
    // 那一份里压根没有 E30：保留文字 + 未定位，不去另一份里借一个。
    const none = resolveReportTraces(note, docWith([{ id: "E1", url: "https://a.example/e1" }]))[0];
    expect(none.href).toBeUndefined();
    expect(none.source).toBe("E30（未定位）");
  });

  it("同一个编号解析出两个地址时一条都不接 —— 接哪个都是猜", () => {
    const two = docWith([
      { id: "E30", url: "https://a.example/one" },
      { id: "E30", url: "https://a.example/two" },
    ]);
    const out = resolveReportTraces([{ kind: "int", source: "E30", href: "E30" }], two)[0];
    expect(out.href).toBeUndefined();
    expect(out.source).toBe("E30（未定位）");
  });

  it("真 DOC 保留，未知 DOC 不可点击", () => {
    const docExists = (id: string) => id === "DOC-51";
    const out = resolveReportTraces(
      [
        { kind: "int", source: "04 域 8 月 Mission Cards", href: "/docs/DOC-51" },
        { kind: "int", source: "一份已经删掉的材料", href: "/docs/DOC-99" },
      ],
      undefined,
      { docExists }
    );
    expect(out[0]).toMatchObject({ kind: "int", href: "/docs/DOC-51" });
    expect(navigableTrace(out[0].href)).toBe(true);
    expect(out[1].href).toBeUndefined();
    expect(out[1].source).toBe("一份已经删掉的材料（未定位）");
    expect(navigableTrace(out[1].href)).toBe(false);
  });

  it("不递 docExists 时退到只验形状 —— 拦得住 E30，拦不住已删掉的 DOC-99", () => {
    const out = resolveReportTraces(
      [
        { kind: "int", source: "存在的", href: "/docs/DOC-51" },
        { kind: "int", source: "删掉的", href: "/docs/DOC-99" },
        { kind: "int", source: "编号当文档用", href: "/docs/E30" },
      ],
      docWith([{ id: "E1", url: "https://a.example/e1" }])
    );
    expect(out[0].href).toBe("/docs/DOC-51");
    expect(out[1].href).toBe("/docs/DOC-99");
    expect(out[2].href).toBeUndefined();
  });

  it("抠编号与抠文档 ID 的形状", () => {
    expect(evidenceRefOf("E30")).toBe("E30");
    expect(evidenceRefOf("e30")).toBe("E30");
    expect(evidenceRefOf("[E30]")).toBe("E30");
    expect(evidenceRefOf("#E30")).toBe("E30");
    expect(evidenceRefOf("/docs/E30")).toBe("E30");
    expect(evidenceRefOf("docs/E30")).toBe("E30");
    expect(evidenceRefOf("/docs/DOC-51")).toBe("");
    expect(evidenceRefOf("Everest")).toBe("");
    expect(docIdOf("/docs/DOC-51")).toBe("DOC-51");
    expect(docIdOf("DOC-D4")).toBe("DOC-D4");
    expect(docIdOf("/docs/E30")).toBe("");
    expect(docIdOf("/judgments/01-J7")).toBe("");
  });
});
