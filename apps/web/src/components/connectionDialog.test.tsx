import { beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";

const ui = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, post: vi.fn(), del: vi.fn(), get: vi.fn(), ask: vi.fn() }));
vi.mock("react", async (original) => {
  const real = await original<typeof import("react")>();
  return { ...real, useEffect: () => undefined, useState: (initial: unknown) => {
    const index = ui.cursor++;
    if (!(index in ui.values)) ui.values[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
    return [ui.values[index], (next: unknown) => { ui.values[index] = typeof next === "function" ? (next as (value: unknown) => unknown)(ui.values[index]) : next; }];
  } };
});
vi.mock("@/lib/api/client", () => ({ browserApi: { GET: ui.get, POST: ui.post, DELETE: ui.del } }));
vi.mock("@/components/ConfirmDialog", () => ({ useConfirm: () => ({ ask: ui.ask, dialog: null }) }));
import { ConnectionDialog } from "./ConnectionDialog";

type Node = ReactElement<Record<string, unknown>>;
function nodes(value: ReactNode): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!isValidElement(value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children as ReactNode)];
}
const render = () => { ui.cursor = 0; return nodes(ConnectionDialog()); };
const named = (all: Node[], label: string) => all.find((node) => node.props.children === label && typeof node.props.onPress === "function");
beforeEach(() => { ui.values = []; ui.cursor = 0; vi.clearAllMocks(); vi.stubGlobal("window", { location: { origin: "https://tianshu.example" } }); });

describe("个人连接对话框", () => {
  it("没有令牌也显示每周同步，指令和定时命令收在折叠里，可复制", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const tree = render();
    const content = JSON.stringify(tree);
    expect(content).toContain("每周同步进展");
    expect(content).toContain("同步本周进展");
    expect(content).toContain("codex exec");
    expect(content).toContain("mcp__tianshu__append_progress");
    const copyInstruction = tree.find((node) => node.props.children === "复制指令")!;
    await (copyInstruction.props.onClick as () => Promise<void>)();
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("没有进展的事项不要写，不要编造"));
  });

  it("生成后主动作是下载连接说明；令牌只在这次出现，文件里是给 Agent 的步骤", async () => {
    const secret = "tsm_test_secret";
    const created = { token: secret, view: { id: "token-1", name: "我的笔记本", client: "codex", createdAt: "2026-09-28T00:00:00Z", expiresAt: null, lastUsedAt: null } };
    ui.post.mockResolvedValue({ data: created });
    let tree = render();
    expect(JSON.stringify(tree)).not.toContain(secret);
    (tree.find((node) => node.type === "input")!.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: "我的笔记本" } });
    tree = render();
    (named(tree, "生成连接说明")!.props.onPress as () => void)();
    await vi.waitFor(() => expect(render().some((node) => JSON.stringify(node).includes(secret))).toBe(true));
    tree = render();
    expect(JSON.stringify(tree)).toContain("codex mcp add tianshu");
    const blobs: Blob[] = [];
    const link = { click: vi.fn(), remove: vi.fn(), href: "", download: "" };
    vi.stubGlobal("URL", { createObjectURL: (blob: Blob) => { blobs.push(blob); return "blob:guide"; }, revokeObjectURL: vi.fn() });
    vi.stubGlobal("document", { createElement: () => link, body: { append: vi.fn() } });
    const download = tree.find((node) => typeof node.props.onPress === "function" && JSON.stringify(node.props.children).includes("下载连接说明"))!;
    (download.props.onPress as () => void)();
    expect(link.download).toBe("天枢连接说明.md");
    expect(link.click).toHaveBeenCalledOnce();
    const text = await blobs[0].text();
    expect(text).toContain(secret);
    expect(text).toContain("https://tianshu.example/mcp/me");
    expect(text).toContain("不要提交到 git");
    ui.values = [];
    expect(JSON.stringify(render())).not.toContain(secret);
  });

  it("撤销先确认，确认后从列表移除", async () => {
    ui.post.mockResolvedValue({ data: { token: "tsm_once", view: { id: "token-2", name: "工作机", client: "claude", createdAt: "2026-09-28T00:00:00Z", expiresAt: null, lastUsedAt: null } } });
    ui.ask.mockResolvedValue(true); ui.del.mockResolvedValue({ response: { status: 204 } });
    let tree = render();
    (tree.find((node) => node.type === "input")!.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: "工作机" } });
    tree = render(); (named(tree, "生成连接说明")!.props.onPress as () => void)();
    await vi.waitFor(() => expect(render().some((node) => node.props.children === "撤销")).toBe(true));
    tree = render();
    (named(tree, "撤销")!.props.onPress as () => void)();
    await vi.waitFor(() => expect(ui.del).toHaveBeenCalled());
    expect(ui.ask).toHaveBeenCalledOnce();
    expect(ui.del).toHaveBeenCalledWith("/api/me/tokens/{id}", { params: { path: { id: "token-2" } } });
    expect(JSON.stringify(render())).not.toContain("tsm_once");
  });
});
