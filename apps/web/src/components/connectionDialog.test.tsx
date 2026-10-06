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
import { ConnectAgentForm, PersonalTokenForm, connectionState, watchFirstUse } from "./ConnectAgentForm";
import { OAuthConnectForm } from "./OAuthConnectForm";

type Node = ReactElement<Record<string, unknown>>;
function nodes(value: ReactNode): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!isValidElement(value)) return [];
  const node = value as Node;
  // 连接表单是共用组件：展开它，按钮和输入框就在同一棵树里（hooks 按调用顺序接着计数）。
  // These existing cases exercise the PAT fallback explicitly.
  if (node.type === ConnectAgentForm) return [node, ...nodes(PersonalTokenForm(node.props as Parameters<typeof PersonalTokenForm>[0]))];
  return [node, ...nodes(node.props.children as ReactNode)];
}
const render = (role: "ceo" | "member" = "member") => { ui.cursor = 0; return nodes(ConnectionDialog({ role })); };
const named = (all: Node[], label: string) => all.find((node) => node.props.children === label && typeof node.props.onPress === "function");
beforeEach(() => { ui.values = []; ui.cursor = 0; vi.clearAllMocks(); vi.stubGlobal("window", { location: { origin: "https://tianshu.example" } }); });

describe("个人连接对话框", () => {
  it("默认使用浏览器授权，个人令牌必须显式切换到备用方式", () => {
    ui.cursor = 0;
    let tree = ConnectAgentForm({ role: "member" }) as Node;
    let children = tree.props.children as Node[];
    expect(children[0].type).toBe(OAuthConnectForm);
    expect(children[1].props.children).toBe("使用个人令牌连接（备用）");
    (children[1].props.onClick as () => void)();
    ui.cursor = 0;
    tree = ConnectAgentForm({ role: "member" }) as Node;
    children = tree.props.children as Node[];
    expect(children[0].type).toBe(PersonalTokenForm);
  });
  it("CEO 版只介绍只读查询，不显示自动同步或每周同步", () => {
    const tree = render("ceo");
    const content = JSON.stringify(tree);
    expect(content).toContain("今天有什么要我拍板");
    expect(content).toContain("它只能看，拍板、签发、确认仍在天枢里做");
    expect(content).not.toContain("每周同步进展");
    expect(content).not.toContain("每周五 18:00 自动同步进展");
    expect(tree.some((node) => node.props.role === "switch")).toBe(false);
  });

  it("CEO 下载的说明文件使用只读工具验证连接", async () => {
    ui.post.mockResolvedValue({ data: { token: "tsm_ceo_once", view: { id: "ceo-token", name: "CEO 设备", client: "codex",
      createdAt: "2026-09-28T00:00:00Z", expiresAt: null, lastUsedAt: null } } });
    let tree = render("ceo");
    (tree.find((node) => node.type === "input")!.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: "CEO 设备" } });
    tree = render("ceo");
    (named(tree, "生成连接说明")!.props.onPress as () => void)();
    await vi.waitFor(() => expect(render("ceo").some((node) => JSON.stringify(node).includes("tsm_ceo_once"))).toBe(true));
    const blobs: Blob[] = [];
    const link = { click: vi.fn(), remove: vi.fn(), href: "", download: "" };
    vi.stubGlobal("URL", { createObjectURL: (blob: Blob) => { blobs.push(blob); return "blob:ceo-guide"; }, revokeObjectURL: vi.fn() });
    vi.stubGlobal("document", { createElement: () => link, body: { append: vi.fn() } });
    tree = render("ceo");
    (tree.find((node) => typeof node.props.onPress === "function" && JSON.stringify(node.props.children).includes("下载连接说明"))!.props.onPress as () => void)();
    const guide = await blobs[0].text();
    expect(guide).toContain("`list_pending`");
    expect(guide).toContain("本说明使用的 CEO 工具只读");
    expect(guide).not.toContain("每周五自动同步");
  });
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
    expect(JSON.stringify(tree)).toContain("[mcp_servers.tianshu]");
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

  it("个人令牌默认 90 天；切换每周同步不会改动有效期", () => {
    const selected = (tree: Node[]) => tree.find((node) => node.props["aria-labelledby"] === "connection-expiry")!.props.selectedKeys;
    let tree = render();
    expect(selected(tree)).toEqual(["90"]);
    (tree.find((node) => node.props.role === "switch")!.props.onClick as () => void)();
    tree = render();
    expect(selected(tree)).toEqual(["90"]);
    (tree.find((node) => node.props.role === "switch")!.props.onClick as () => void)();
    expect(selected(render())).toEqual(["90"]);
    ui.values = [];
    expect(selected(render("ceo"))).toEqual(["90"]);
  });

  it("连接列表按状态显示：等待连接、已连上、最近同步", () => {
    const base = { id: "t", name: "笔记本", client: "codex" as const, createdAt: "2026-09-28T00:00:00Z", expiresAt: null };
    expect(connectionState({ ...base, lastUsedAt: null, lastProgressAt: null })).toBe("等待连接");
    expect(connectionState({ ...base, lastUsedAt: "2026-09-30T02:00:00Z", lastProgressAt: null })).toMatch(/^已连上 · 最近使用 /);
    expect(connectionState({ ...base, lastUsedAt: "2026-09-30T02:00:00Z", lastProgressAt: "2026-09-30T02:05:00Z" })).toMatch(/^最近同步 /);
  });

  it("生成后轮询到首次调通就停；连接被撤销也停", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", { setTimeout, clearTimeout, location: { origin: "https://tianshu.example" } });
    try {
      const seen: (string | null)[] = [];
      const view = (lastUsedAt: string | null) => ({ id: "token-1", name: "笔记本", client: "codex", createdAt: "2026-09-28T00:00:00Z", expiresAt: null, lastUsedAt, lastProgressAt: null });
      ui.get.mockResolvedValueOnce({ data: { tokens: [view(null)] } }).mockResolvedValueOnce({ data: { tokens: [view("2026-09-30T02:00:00Z")] } });
      watchFirstUse("token-1", (item) => seen.push(item.lastUsedAt), 5_000);
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(ui.get).toHaveBeenCalledTimes(2);
      expect(seen).toEqual([null, "2026-09-30T02:00:00Z"]);
      ui.get.mockReset(); ui.get.mockResolvedValue({ data: { tokens: [] } });
      watchFirstUse("token-1", () => undefined, 5_000);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(ui.get).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
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
