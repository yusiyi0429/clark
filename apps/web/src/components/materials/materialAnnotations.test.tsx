import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { TMaterialAnnotationView, TMaterialDetailResponse, TMaterialEditProposalView } from "@warmap/contracts";
import { AnnotationBar, AnnotationComposer, HistoryCard, ProposalBanner, SELECTION_SCRIPT } from "./MaterialAnnotations";

const person = { personId: "p1", displayName: "孙铭泽" };
const note = (status: TMaterialAnnotationView["status"], extra: Partial<TMaterialAnnotationView> = {}): TMaterialAnnotationView => ({
  id: `a-${status}`, materialId: "m1", version: 2, quote: "今天开会", body: "改成明天", author: person, status,
  appliedVersion: null, note: null, createdAt: "2026-10-05T06:20:00Z", ...extra,
});
const detail = (annotations: TMaterialAnnotationView[], removedCount = 0) => ({
  annotations, proposals: [],
  removed: Array.from({ length: removedCount }, (_, index) => ({ id: `v2-${index}`, version: 2, text: `删掉的第 ${index + 1} 段`, requestedBy: person, at: "2026-10-05T06:20:00Z", annotation: null, restorable: true })),
}) as unknown as TMaterialDetailResponse;

describe("材料批注", () => {
  it("有批注在改时提示正在修改，并给出批注数与垃圾篓入口；都没有时不出现", () => {
    const html = renderToStaticMarkup(<AnnotationBar detail={detail([note("queued"), note("applying"), note("applied", { appliedVersion: 3 })], 2)} onRestore={async () => null} />);
    expect(html).toContain("Co-Agent 正在按批注修改（还有 2 条）");
    expect(html).toContain("批注 3");
    expect(html).toContain("已删除 2 段");
    expect(html).not.toContain("删掉的第 1 段"); // 垃圾篓默认收起
    expect(renderToStaticMarkup(<AnnotationBar detail={detail([])} onRestore={async () => null} />)).toBe("");
  });

  it("悬停历史卡列出批注、改之前的原文和谁在哪一版改的", () => {
    const html = renderToStaticMarkup(<HistoryCard history={[
      { version: 3, kind: "modified", before: "今天开会", requestedBy: person, at: "2026-10-05T06:20:00Z", annotation: { id: "a1", quote: "今天开会", body: "改成明天", author: person } },
      { version: 2, kind: "added", before: "", requestedBy: null, at: "2026-10-04T06:20:00Z", annotation: null },
    ]} />);
    expect(html).toContain("批注「今天开会」：改成明天");
    expect(html).toContain("原来：今天开会");
    expect(html).toContain("第 3 版");
    expect(html).toContain("这段是新加的");
  });

  it("修改提议显示摘要、前两处改动与「按这个改 / 忽略」", () => {
    const proposal: TMaterialEditProposalView = { id: "p1", materialId: "m1", version: 2, summary: "按讨论把会期改到周五", proposedFor: person, status: "pending", createdAt: "2026-10-05T06:20:00Z",
      changes: [{ before: "周三", after: "周五" }, { before: "10 点", after: "14 点" }, { before: "A", after: "B" }] };
    const html = renderToStaticMarkup(<ProposalBanner proposal={proposal} onDecide={async () => null} />);
    expect(html).toContain("按讨论把会期改到周五");
    expect(html).toContain("<del>周三</del><ins>周五</ins>");
    expect(html).toContain("还有 1 处");
    expect(html).toContain("按这个改");
    expect(html).toContain("忽略");
  });

  it("选中后先是「写批注」小按钮；Word 预览注入的选区脚本只往父页面发消息", () => {
    const html = renderToStaticMarkup(<AnnotationComposer selection={{ text: "今天开会", prefix: "", suffix: "", top: 10, left: 0 }} editable onSubmit={async () => null} onClose={() => undefined} />);
    expect(html).toContain("写批注");
    expect(SELECTION_SCRIPT).toContain("parent.postMessage");
    expect(SELECTION_SCRIPT).not.toMatch(/src=|fetch\(|XMLHttpRequest/);
  });
});
