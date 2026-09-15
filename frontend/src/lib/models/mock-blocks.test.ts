/**
 * 假模型那份区块罐头，走**真链路的三段**跑一遍：排结构 → 逐节 → 收口 → 装配 → 逐块校验。
 *
 * 这一份的用处是**零成本**验区块那一支：四条链路各跑一遍，出来的必须是能解析、能过闸的
 * 块，而不是屏幕上一句「模型没按格式交」。用的是真的 prompt 生成器和真的装配、校验函数 ——
 * 自己拼一份 JSONL 来测的话，测到的只是「我拼得对」。
 *
 * 唯一允许剩下的 p0 是 Claude 那一条**故意缺的证伪条件**（`mock-blocks.ts` 里那处注释）：
 * 它是返修那一轮在离线下唯一的触发器。它变多变少都该让这份测试先红。
 */
import { describe, expect, it } from "vitest";

import {
  a4ClosingSystem,
  a4OutlineSystem,
  a4SectionSystem,
  buildA4BlockRepair,
  buildA4ClosingUser,
  buildA4OutlineUser,
  buildA4SectionUser,
  buildEvidencePack,
  type A4ReportInput,
} from "@/lib/agent/a4/prompt";
import { lintAssembled, mustRewrite, rejectedFrom } from "@/lib/agent/a4/blocks/lint";
import { parseBlocks } from "@/lib/agent/a4/blocks/parse";
import { assembleReport, blocksToText, spliceRepair } from "@/lib/agent/a4/blocks/report";
import { assembleStaged, mergeUsage, readOutline, usageMaterial } from "@/lib/agent/a4/blocks/stages";
import { gateReport } from "@/lib/agent/a4/gate";
import { blocking } from "@/lib/agent/rules";
import { Ledger, type EvidenceDraft } from "@/lib/research/ledger";
import type { Snapshot } from "@/lib/research/fetch";

import { mockText } from "./mock";

/* ---- 台账：三条，E1/E3 同源，第三条会进 unassigned ------------------------ */

const URL_A = "https://stats.example.gov.cn/a";
const URL_B = "https://industry.example.org/b";
const BODY_A = "示例数值为 1590 EFLOPS，统计截至 2025 年末。";
const BODY_B = "这是离线自测用的占位正文，不是真实来源。";

const snap = (url: string, text: string): Snapshot => ({
  url,
  title: url.includes("stats") ? "某局季度公报" : "某行业观察",
  text,
  contentHash: `h-${url}`,
  retrievedAt: "2026-08-25T00:00:00.000Z",
  truncated: false,
});

function ledgerOf(): Ledger {
  const l = new Ledger();
  l.archive([snap(URL_A, BODY_A), snap(URL_B, BODY_B)]);
  const drafts: EvidenceDraft[] = [
    {
      propositionId: "P1",
      claim: "示例口径下算力规模为 1590 EFLOPS",
      exactQuote: "示例数值为 1590 EFLOPS，统计截至 2025 年末",
      url: URL_A,
      supportRelation: "supports",
      evidenceType: "statistic",
      authorityClass: "official_statistics",
    },
    {
      propositionId: "P1",
      claim: "这一页自称是离线自测用的占位正文",
      exactQuote: "这是离线自测用的占位正文，不是真实来源",
      url: URL_B,
      supportRelation: "supports",
      evidenceType: "statement",
      authorityClass: "other",
    },
  ];
  for (const d of drafts) {
    const e = l.record(d);
    if (!e) throw new Error(`夹具没入账：${l.rejections.at(-1)?.why}`);
  }
  return l;
}

const LEDGER = ledgerOf();

const materialOf = (evidencePack: string): A4ReportInput => ({
  issueId: "ISS-1",
  title: "入口移到交付侧之后，我们的模型能力还能不能带动成单？",
  scope: null,
  preTake: "采购决策权正在从技术评估侧移到行业交付侧。",
  preOpenQuestions: ["这个权重变化是一个行业的事还是三个？"],
  judgments: [],
  companyContext: "（离线自测）",
  cognitive: "",
  evidencePack,
  unresolved: "P2：另外两个行业同期的招标口径，本轮没有取到。",
});

const LANES = ["a4.report", "a4.report.claude", "a4.report.gpt"];

/** 照 `a4/run.ts` 的 `writeStaged()` 走一遍，只把模型换成罐头。 */
function staged(hint: string) {
  const entries = LEDGER.entries;
  const packIds = entries.map((e) => e.id);
  const all = materialOf(buildEvidencePack(entries));

  // system 段照样生成：真链路那三次都发它，生成时抛异常的话这条路在线上也走不通。
  expect(a4OutlineSystem(true)).toContain("排结构");
  const raw = JSON.parse(mockText(`${hint}.outline`, [{ role: "user", content: buildA4OutlineUser(all) }]));
  const { outline } = readOutline(raw, packIds);

  const sections: { id: string; text: string }[] = [];
  const parsed = [];
  const declared = [...outline.unassigned];
  for (const s of outline.sections) {
    const ids = new Set(s.evidenceIds);
    const user = buildA4SectionUser({
      ...all,
      evidencePack: buildEvidencePack(entries.filter((e) => ids.has(e.id))),
      section: s,
      thesisDraft: outline.thesisDraft,
      written: "",
    });
    expect(a4SectionSystem({ hasEvidence: true })).toContain("只写本节");
    const body = mockText(`${hint}.section`, [{ role: "user", content: user }]).trim();
    sections.push({ id: s.id, text: body });
    const p = parseBlocks(body, { complete: true });
    expect(p.bad).toEqual([]);
    parsed.push(...p.blocks);
    for (const b of p.blocks) if (b.type === "evidence_usage") declared.push(...b.discarded);
  }

  const account = mergeUsage({ packIds, blocks: parsed, declared });
  expect(a4ClosingSystem(true)).toContain("收口");
  const closing = mockText(`${hint}.closing`, [
    {
      role: "user",
      content: buildA4ClosingUser({
        ...all,
        thesisDraft: outline.thesisDraft,
        written: "",
        sectionJudgments: "",
        usage: usageMaterial(account),
      }),
    },
  ]).trim();

  const asm = assembleStaged({ outline, sections, closing, packIds });
  return { outline, asm, text: asm.text };
}

const laneMark = { model: "mock", short: "假模型", durationS: 1 };
const assembled = (text: string) =>
  assembleReport({ text, entries: LEDGER.entries, lane: laneMark, complete: true });

describe("区块罐头：四条链路各自跑通三段", () => {
  for (const hint of LANES) {
    it(`${hint} 解析得出块、对得上账、只剩那一条故意的 p0`, async () => {
      const { asm } = staged(hint);
      // 三条以上的证据包才会有 unassigned；两条时前两节各分一条，所以没交代的必须是零。
      expect(asm.usage.uncovered).toEqual([]);

      const r = assembled(asm.text);
      expect(r.blocks.length).toBeGreaterThanOrEqual(6);
      expect(r.report.blocks.some((b) => b.type === "verdict_banner")).toBe(true);
      expect(r.report.blocks.some((b) => b.type === "judgment")).toBe(true);

      const p0 = blocking(lintAssembled(r));
      const deliberate = hint === "a4.report.claude";
      expect(p0.map((x) => `${x.rule}｜${x.message}`)).toEqual(
        deliberate ? [expect.stringContaining("A4-B03")] : []
      );
    });
  }
});

describe("那一条故意缺的证伪条件把返修整条路带起来", () => {
  it("原样交回去之后仍是同一条 p0，而对齐没有对不上的", async () => {
    const { asm } = staged("a4.report.claude");
    let r = assembled(asm.text);
    const violations = lintAssembled(r);
    expect(mustRewrite(violations)).toBe(true);

    const { rejected, general, needsMeta } = rejectedFrom(violations, r.blocks, r.sources);
    expect(rejected).toHaveLength(1);

    const reply = mockText("a4.report.claude", [
      { role: "assistant", content: asm.text },
      { role: "user", content: buildA4BlockRepair(rejected, general || undefined, needsMeta) },
    ]);
    const spliced = spliceRepair({ previous: r, rejected, needsMeta, reply });
    expect(spliced.notes).toEqual([]);

    r = assembled(spliced.text);
    // 假模型不改东西，所以第二遍报的还是同一条 —— 这就是它在离线下的正确表现。
    expect(blocking(lintAssembled(r)).map((x) => x.rule)).toEqual(["A4-B03"]);
  });
});

describe("文字面过得了出口闸", () => {
  it("递上模型既有知识那几条编号之后，A4-G02 不再误报", async () => {
    const { asm } = staged("a4.report.gpt");
    const r = assembled(asm.text);
    const text = blocksToText(r.report);
    const outside = r.report.evidence.filter((e) => e.origin === "model").map((e) => e.id);
    expect(outside.length).toBeGreaterThan(0);

    const withAllow = blocking(gateReport(text, LEDGER, [], outside).violations).map((x) => x.rule);
    expect(withAllow).toEqual([]);
    // 不递的那一种：同一份报告会被判成「引了台账里没有的编号」。
    expect(blocking(gateReport(text, LEDGER, []).violations).map((x) => x.rule)).toContain("A4-G02");
  });
});

describe("散文那一支不受影响", () => {
  it("链路 hint 在没有返修提示词时照旧交散文报告", async () => {
    expect(mockText("a4.report")).toContain("## 核心判断");
    expect(mockText("a4.report.gpt")).toContain("## 未能核实的部分");
  });

  it("跨链路对账那一步交的是 divergence_view", async () => {
    const lines = mockText("a4.divergence").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(4);
    expect(new Set(lines.map((l) => l.type))).toEqual(new Set(["divergence_view"]));
  });
});
