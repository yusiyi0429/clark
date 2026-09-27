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
  it("生成后才显示令牌和命令；关闭重新打开不再显示明文", async () => {
    const secret = "tsm_test_secret";
    const created = { token: secret, view: { id: "token-1", name: "我的笔记本", client: "codex", createdAt: "2026-09-28T00:00:00Z", expiresAt: null, lastUsedAt: null } };
    ui.post.mockResolvedValue({ data: created });
    let tree = render();
    expect(JSON.stringify(tree)).not.toContain(secret);
    (tree.find((node) => node.type === "input")!.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: "我的笔记本" } });
    tree = render();
    (named(tree, "生成令牌")!.props.onPress as () => void)();
    await vi.waitFor(() => expect(render().some((node) => JSON.stringify(node).includes(secret))).toBe(true));
    tree = render();
    expect(JSON.stringify(tree)).toContain(secret);
    expect(JSON.stringify(tree)).toContain("codex mcp add tianshu");
    expect(JSON.stringify(tree)).toContain("claude mcp add");
    ui.values = [];
    expect(JSON.stringify(render())).not.toContain(secret);
  });

  it("撤销先确认，确认后从列表移除", async () => {
    ui.post.mockResolvedValue({ data: { token: "tsm_once", view: { id: "token-2", name: "工作机", client: "claude", createdAt: "2026-09-28T00:00:00Z", expiresAt: null, lastUsedAt: null } } });
    ui.ask.mockResolvedValue(true); ui.del.mockResolvedValue({ response: { status: 204 } });
    let tree = render();
    (tree.find((node) => node.type === "input")!.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: "工作机" } });
    tree = render(); (named(tree, "生成令牌")!.props.onPress as () => void)();
    await vi.waitFor(() => expect(render().some((node) => node.props.children === "撤销")).toBe(true));
    tree = render();
    (named(tree, "撤销")!.props.onPress as () => void)();
    await vi.waitFor(() => expect(ui.del).toHaveBeenCalled());
    expect(ui.ask).toHaveBeenCalledOnce();
    expect(ui.del).toHaveBeenCalledWith("/api/me/tokens/{id}", { params: { path: { id: "token-2" } } });
    expect(JSON.stringify(render())).not.toContain("tsm_once");
  });
});
