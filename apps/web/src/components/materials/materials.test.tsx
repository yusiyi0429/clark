import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { TMaterialDetailResponse, TMaterialView } from "@warmap/contracts";
import { MaterialReader } from "./ObjectMaterialArea";

const material: TMaterialView = { id: "11111111-1111-4111-8111-111111111111", objectType: "issue", objectId: "issue-1",
  fileName: "版本规划.md", format: "markdown", sizeBytes: 40, origin: "upload", owner: { personId: "p1", displayName: "孙铭泽" },
  createdAt: "2026-10-05T06:00:00Z", updatedAt: "2026-10-05T06:20:00Z", version: 2, editable: true, canEdit: true, pending: 0, canDelete: true, working: false,
  lastRevision: { version: 2, requestedBy: { personId: "p1", displayName: "孙铭泽" }, summary: "调整时间", at: "2026-10-05T06:20:00Z", annotation: null } };
const detail: TMaterialDetailResponse = { material, version: 2, latest: true, revision: material.lastRevision!,
  revisions: [material.lastRevision!, { version: 1, requestedBy: null, summary: null, at: material.createdAt, annotation: null }],
  blocks: [{ text: "明天开会", change: { kind: "modified", before: "今天开会", spans: [{ text: "明", changed: true }, { text: "天开会", changed: false }] }, history: [] },
    { text: "", change: { kind: "removed", before: "删掉的一段" }, history: [] }, { text: "新段落", change: { kind: "added" }, history: [] }],
  annotations: [], proposals: [],
  removed: [{ id: "v2-1", version: 2, text: "删掉的一段", requestedBy: { personId: "p1", displayName: "孙铭泽" }, at: "2026-10-05T06:20:00Z", annotation: null, restorable: true }] };
const render = (m = material, d: TMaterialDetailResponse | null = detail) => renderToStaticMarkup(<MaterialReader material={m} detail={d}
  base="/api/materials/issue/issue-1" onRemove={() => undefined} onVersion={() => undefined}
  onAnnotate={async () => null} onRestore={async () => null} onDecide={async () => null} />);

describe("材料阅读", () => {
  it("标出改字；删掉的内容正文里不显示、进「已删除 N 段」；保留下载、本人删除与改动记录", () => {
    const html = render();
    expect(html).toContain("第 2 版");
    expect(html).toContain("改动记录");
    expect(html).toContain("查看批注和修改历史");
    expect(html).not.toContain("删掉的一段");
    expect(html).toContain("已删除 1 段");
    expect(html).toContain("下载");
    expect(html).toContain(">删除</button>");
  });
  it("非上传者没有删除；旧版有回到最新；PDF 有只读说明", () => {
    expect(render({ ...material, canDelete: false })).not.toContain(">删除</button>");
    expect(render(material, { ...detail, version: 1, latest: false })).toContain("回到最新");
    const pdf = { ...material, format: "pdf" as const, editable: false, fileName: "资料.pdf" };
    expect(render(pdf, { ...detail, material: pdf, blocks: null })).toContain("只有 Markdown 和 HTML 能让 Agent 修改");
  });
  it("Agent 新写的首版保留写作记录", () => {
    const first = { ...material, origin: "agent" as const, version: 1,
      lastRevision: { version: 1, requestedBy: material.owner, summary: "新写规划", at: material.createdAt, annotation: null } };
    expect(render(first, { ...detail, material: first, version: 1, latest: true, revision: first.lastRevision,
      revisions: [first.lastRevision], blocks: [{ text: "初稿", change: null, history: [] }] })).toContain("第 1 版 · Agent 按孙铭泽的要求新写");
  });
  it("修改过的 Markdown 块仍按格式显示", () => {
    const formatted = { ...detail, blocks: [{ text: "**新判断**", change: { kind: "modified" as const,
      before: "**旧判断**", spans: [{ text: "新", changed: true }, { text: "判断", changed: false }] }, history: [] }] };
    const html = render(material, formatted);
    expect(html).toContain("<strong>新判断</strong>");
    expect(html).not.toContain("**新判断**");
    expect(html).toContain("查看批注和修改历史");
  });
  it("HTML 用仅允许脚本的 sandbox iframe 加载选中的版本", () => {
    const html = { ...material, format: "html" as const, fileName: "方案.html" };
    const markup = render(html, { ...detail, material: html,
      blocks: [{ text: "<p>新方案</p>", change: { kind: "modified", before: "<p>旧方案</p>", spans: [] }, history: [] }] });
    expect(markup).toContain('sandbox="allow-scripts"');
    expect(markup).toContain(`/preview?version=2`);
    expect(markup).not.toContain("allow-same-origin");
    expect(markup).not.toContain("只读");
    const older = render({ ...html, version: 3 }, { ...detail, material: html, version: 2, latest: false,
      blocks: [{ text: "<p>新方案</p>", change: { kind: "modified", before: "<p>旧方案</p>", spans: [] }, history: [] }] });
    expect(older).toContain("这是第 2 版，不是最新");
    expect(older).toContain("1 处</button>");
    expect(older).toContain(`/preview?version=2`);
  });
});
