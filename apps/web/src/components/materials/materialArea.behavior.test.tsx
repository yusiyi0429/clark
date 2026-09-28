import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const hooks = vi.hoisted(() => ({ values: [] as unknown[], index: 0,
  useState(initial: unknown) {
    const index = hooks.index++;
    if (!(index in hooks.values)) hooks.values[index] = initial;
    return [hooks.values[index], (next: unknown) => { hooks.values[index] = typeof next === "function"
      ? (next as (value: unknown) => unknown)(hooks.values[index]) : next; }];
  },
}));
const confirm = vi.hoisted(() => ({ ask: vi.fn() }));
vi.mock("react", async (original) => ({ ...(await original<typeof import("react")>()),
  useState: hooks.useState, useEffect: () => undefined, useCallback: (fn: unknown) => fn,
  useRef: () => ({ current: { value: "" } }) }));
vi.mock("@/components/shell/MaterialTabs", () => ({ MaterialTabs: () => null, useRememberedScroll: () => undefined }));
vi.mock("@/components/ConfirmDialog", () => ({ useConfirm: () => ({ ask: confirm.ask, dialog: null }) }));

import type { TMaterialDetailResponse, TMaterialView } from "@warmap/contracts";
import { ObjectMaterialArea, MaterialReader } from "./ObjectMaterialArea";

type Node = { type?: unknown; props?: Record<string, unknown> };
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object") return [];
  const node = value as Node;
  return node.props ? [node, ...nodes(node.props.children)] : [];
}
const id = "11111111-1111-4111-8111-111111111111";
const material = { id, objectType: "issue", objectId: "issue-1", fileName: "计划.md", format: "markdown",
  sizeBytes: 2, origin: "upload", owner: { personId: "p1", displayName: "甲" },
  createdAt: "2026-10-05T06:00:00Z", updatedAt: "2026-10-05T06:00:00Z", version: 1,
  editable: true, canDelete: true, lastRevision: null } as TMaterialView;
const select = vi.fn();
const render = (selected = "summary") => { hooks.index = 0; return ObjectMaterialArea({ objectType: "issue", objectId: "issue-1",
  baseTabs: [{ id: "summary", label: "总结与判断", title: "总结与判断" },
    { id: "research", label: "研究与依据", title: "研究与依据" }],
  selected, onSelect: select, children: "议题内容" }); };
const response = (body: unknown, ok = true) => ({ ok, json: async () => body });

beforeEach(() => { hooks.values = []; vi.clearAllMocks(); });

describe("材料区操作", () => {
  it("显示原有页签和上传入口；上传中显示占位，成功后选中新材料", async () => {
    hooks.values[1] = true;
    const fetch = vi.fn().mockResolvedValueOnce(response(material)).mockResolvedValueOnce(response({ materials: [material], canUpload: true }));
    vi.stubGlobal("fetch", fetch);
    const tree = render();
    const tabs = nodes(tree).find((node) => Array.isArray(node.props?.tabs));
    expect((tabs?.props?.tabs as { label: string }[]).map((tab) => tab.label)).toEqual(["总结与判断", "研究与依据"]);
    expect(nodes(tree).some((node) => node.props?.["aria-label"] === "上传材料" && node.type === "button")).toBe(true);
    const input = nodes(tree).find((node) => node.type === "input");
    (input?.props?.onChange as (event: unknown) => void)({ target: { files: [new File(["正文"], "计划.md")] } });
    expect(nodes(render()).some((node) => node.props?.role === "status" && node.props.children === "上传中…")).toBe(true);
    await vi.waitFor(() => expect(select).toHaveBeenCalledWith(id));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("上传失败显示原因；删除先确认，取消不发送请求", async () => {
    hooks.values[1] = true;
    const fetch = vi.fn().mockResolvedValueOnce(response({ message: "上传被拒绝" }, false));
    vi.stubGlobal("fetch", fetch);
    const input = nodes(render()).find((node) => node.type === "input");
    (input?.props?.onChange as (event: unknown) => void)({ target: { files: [new File(["正文"], "计划.md")] } });
    await vi.waitFor(() => expect(nodes(render()).some((node) => node.props?.children === "上传被拒绝")).toBe(true));
    hooks.values[0] = [material];
    confirm.ask.mockResolvedValueOnce(false);
    const reader = nodes(render(id)).find((node) => node.type === MaterialReader);
    await (reader?.props?.onRemove as () => Promise<void>)();
    expect(confirm.ask).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    confirm.ask.mockResolvedValueOnce(true);
    fetch.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce(response({ materials: [], canUpload: true }));
    await (reader?.props?.onRemove as () => Promise<void>)();
    expect(fetch).toHaveBeenCalledWith(`/api/materials/issue/issue-1/${id}`, { method: "DELETE" });
    expect(select).toHaveBeenCalledWith("summary");
  });

  it("展开 HTML 改动列表，按文字展示修改、删除和新增", () => {
    const html = { ...material, format: "html" as const, fileName: "方案.html", version: 2,
      lastRevision: { version: 2, requestedBy: material.owner, summary: "更新方案", at: material.updatedAt } };
    const detail: TMaterialDetailResponse = { material: html, version: 2, latest: true, revision: html.lastRevision,
      revisions: [html.lastRevision], blocks: [
        { text: `<p>${"新".repeat(210)}</p>`, change: { kind: "modified", before: "<p>旧方案</p>", spans: [] } },
        { text: "", change: { kind: "removed", before: "<b>删去</b>" } },
        { text: "<p>加上</p>", change: { kind: "added" } },
      ] };
    const props = { material: html, detail, base: "/api/materials/issue/issue-1", onRemove: () => undefined, onVersion: () => undefined };
    hooks.index = 0;
    const tree = MaterialReader(props);
    const count = nodes(tree).find((node) => node.type === "button" && node.props?.["aria-expanded"] === false);
    expect(count?.props?.["aria-expanded"]).toBe(false);
    (count?.props?.onClick as () => void)();
    hooks.index = 0;
    const markup = renderToStaticMarkup(MaterialReader(props));
    expect(markup).toContain("修改");
    expect(markup).toContain("原来：旧方案");
    expect(markup).toContain(`现在：${"新".repeat(200)}`);
    expect(markup).not.toContain("新".repeat(201));
    expect(markup).toContain("删除");
    expect(markup).toContain("删去");
    expect(markup).toContain("新增");
    expect(markup).toContain("加上");
  });
});
