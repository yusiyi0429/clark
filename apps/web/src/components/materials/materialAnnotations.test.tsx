import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TMaterialAnnotationView, TMaterialDetailResponse, TMaterialEditProposalView, TMaterialView } from "@warmap/contracts";

/** 按调用顺序给 useState 预设值，直接渲染出打开的输入框、批注列表和不采用的原因框。 */
const hooks = vi.hoisted(() => ({ values: [] as unknown[], index: 0,
  useState(initial: unknown) {
    const index = hooks.index++;
    if (!(index in hooks.values)) hooks.values[index] = initial;
    return [hooks.values[index], () => undefined];
  },
}));
vi.mock("react", async (original) => ({ ...(await original<typeof import("react")>()), useState: hooks.useState }));
import { AnnotationBar, AnnotationComposer, HistoryCard, ProposalBanner, SELECTION_SCRIPT } from "./MaterialAnnotations";

const render = (node: ReactElement, ...values: unknown[]) => { hooks.values = values; hooks.index = 0; return renderToStaticMarkup(node); };
const person = { personId: "p1", displayName: "孙铭泽" };
const uploader = { personId: "p2", displayName: "王创峰" };
const note = (status: TMaterialAnnotationView["status"], extra: Partial<TMaterialAnnotationView> = {}): TMaterialAnnotationView => ({
  id: `a-${status}`, materialId: "m1", version: 2, quote: "今天开会", body: "改成明天", author: person, status,
  appliedVersion: null, note: null, decidedBy: null, stale: false, canDecide: false, canApply: false, createdAt: "2026-10-05T06:20:00Z", ...extra,
});
/** 默认是协作者在看王创峰上传的 Markdown：不能改。 */
const material = (extra: Partial<TMaterialView> = {}): TMaterialView => ({ id: "m1", objectType: "task", objectId: "t1", fileName: "方案.md",
  format: "markdown", sizeBytes: 10, origin: "upload", owner: uploader, createdAt: "2026-10-05T06:00:00Z", updatedAt: "2026-10-05T06:20:00Z",
  version: 2, editable: true, canEdit: false, pending: 0, canDelete: false, lastRevision: null, working: false, ...extra });
const detail = (annotations: TMaterialAnnotationView[], removedCount = 0, viewing = material()) => ({
  material: viewing, annotations, proposals: [],
  removed: Array.from({ length: removedCount }, (_, index) => ({ id: `v2-${index}`, version: 2, text: `删掉的第 ${index + 1} 段`, requestedBy: person, at: "2026-10-05T06:20:00Z", annotation: null, restorable: true })),
}) as unknown as TMaterialDetailResponse;
const bar = (value: TMaterialDetailResponse, ...values: unknown[]) =>
  render(<AnnotationBar detail={value} onRestore={async () => null} onDecide={async () => null} />, ...values);

beforeEach(() => { hooks.values = []; hooks.index = 0; });

describe("材料批注", () => {
  it("有批注在改时提示正在修改，并给出批注数与垃圾篓入口；都没有时不出现", () => {
    const html = bar(detail([note("queued"), note("applying"), note("applied", { appliedVersion: 3 })], 2));
    expect(html).toContain("Co-Agent 正在按批注修改（还有 2 条）");
    expect(html).toContain("批注 3");
    expect(html).toContain("已删除 2 段");
    expect(html).not.toContain("删掉的第 1 段"); // 垃圾篓默认收起
    expect(bar(detail([]))).toBe("");
  });

  it("悬停历史卡列出批注、改之前的原文和谁在哪一版改的；别人的批注写明谁采用", () => {
    const html = renderToStaticMarkup(<HistoryCard history={[
      { version: 4, kind: "modified", before: "明天开会", requestedBy: uploader, at: "2026-10-06T06:20:00Z", annotation: { id: "a2", quote: "明天开会", body: "加上地点", author: person } },
      { version: 3, kind: "modified", before: "今天开会", requestedBy: person, at: "2026-10-05T06:20:00Z", annotation: { id: "a1", quote: "今天开会", body: "改成明天", author: person } },
      { version: 2, kind: "added", before: "", requestedBy: null, at: "2026-10-04T06:20:00Z", annotation: null },
    ]} />);
    expect(html).toContain("批注「今天开会」：改成明天");
    expect(html).toContain("原来：今天开会");
    expect(html).toContain("第 4 版 · 王创峰采用");
    expect(html).toContain("第 3 版 · 孙铭泽让 Co-Agent 改的");
    expect(html).toContain("这段是新加的");
  });

  it("修改提议显示摘要、前两处改动与「按这个改 / 忽略」；不能改的人提的写明是谁", () => {
    const proposal: TMaterialEditProposalView = { id: "p1", materialId: "m1", version: 2, summary: "按讨论把会期改到周五", proposedBy: person, proposedFor: person, status: "pending", createdAt: "2026-10-05T06:20:00Z",
      changes: [{ before: "周三", after: "周五" }, { before: "10 点", after: "14 点" }, { before: "A", after: "B" }] };
    const html = render(<ProposalBanner proposal={proposal} onDecide={async () => null} />);
    expect(html).toContain("Co-Agent 按对话里的共识提议修改");
    expect(html).toContain("按讨论把会期改到周五");
    expect(html).toContain("<del>周三</del><ins>周五</ins>");
    expect(html).toContain("还有 1 处");
    expect(html).toContain("按这个改");
    expect(html).toContain("忽略");
    expect(render(<ProposalBanner proposal={{ ...proposal, proposedFor: uploader }} onDecide={async () => null} />)).toContain("孙铭泽在对话里提议修改");
  });

  it("选中后先是「写批注」小按钮；Word 预览注入的选区脚本只往父页面发消息", () => {
    const html = render(<AnnotationComposer selection={{ text: "今天开会", prefix: "", suffix: "", top: 10, left: 0 }} canEdit onSubmit={async () => null} onClose={() => undefined} />);
    expect(html).toContain("写批注");
    expect(SELECTION_SCRIPT).toContain("parent.postMessage");
    expect(SELECTION_SCRIPT).not.toMatch(/src=|fetch\(|XMLHttpRequest/);
  });

  it("能改的人有「保存」「立即修改」，和任务卡同一套文案；其他人只有「保存」，不加说明", () => {
    const props = { selection: { text: "今天开会", prefix: "", suffix: "", top: 10, left: 0 }, onSubmit: async () => null, onClose: () => undefined };
    const editor = render(<AnnotationComposer {...props} canEdit />, true, "改成明天");
    expect(editor).toContain('placeholder="写下修改意见"');
    expect(editor).toMatch(/>保存<\/button><button[^>]*>立即修改<\/button><\/footer>/);
    const other = render(<AnnotationComposer {...props} canEdit={false} />, true, "改成明天");
    expect(other).toMatch(/>保存<\/button><\/footer>/);
    expect(other).not.toContain("立即修改");
    expect(other).not.toMatch(/Co-Agent|只留批注/);
  });

  it("其他人保存的批注写明待上传者处理；能改的人在别人的批注上采用 / 不采用，在自己保存的上立即修改", () => {
    const html = bar(detail([note("noted", { id: "a1", stale: true }), note("noted", { id: "a2", author: uploader })]), "notes");
    expect(html.match(/待王创峰处理/g)).toHaveLength(2);
    expect(html).toContain("原文已改");
    expect(html).not.toMatch(/>(采用|不采用|立即修改)<\/button>/);
    const editor = bar(detail([note("noted", { id: "a1", canDecide: true }), note("noted", { id: "a2", author: uploader, canApply: true })], 0,
      material({ canEdit: true, pending: 1 })), "notes");
    expect(editor).not.toContain("待王创峰处理");
    expect(editor).toMatch(/>采用<\/button><button[^>]*>不采用<\/button>/);
    expect(editor).toContain(">立即修改</button>");
    const pdf = bar(detail([note("noted")], 0, material({ format: "pdf", editable: false, fileName: "资料.pdf" })), "notes");
    expect(pdf).toContain("已保存");
    expect(pdf).not.toContain("待王创峰处理");
  });

  it("不采用先填原因（可不填）再确认；不采用的收起成一行，写明谁不采用和原因；采用的写明采用人", () => {
    const form = bar(detail([note("noted", { canDecide: true })], 0, material({ canEdit: true })), "notes", false, true);
    expect(form).toContain('placeholder="原因（可不填）"');
    expect(form).toMatch(/>取消<\/button><button[^>]*>不采用<\/button>/);
    const html = bar(detail([note("declined", { decidedBy: uploader, note: "已经改过了" }),
      note("applied", { id: "a3", appliedVersion: 3, decidedBy: uploader })]), "notes");
    expect(html).toContain('<li data-status="declined" tabindex="0">');
    expect(html).toContain("王创峰不采用：已经改过了");
    expect(html).toContain("已改 · 第 3 版</span> · 王创峰采用");
  });
});
