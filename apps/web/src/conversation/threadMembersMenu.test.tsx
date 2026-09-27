import { beforeEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({ values: [] as unknown[], index: 0,
  useState(initial: unknown) {
    const index = hooks.index++;
    if (!(index in hooks.values)) hooks.values[index] = initial;
    return [hooks.values[index], (next: unknown) => { hooks.values[index] = typeof next === "function"
      ? (next as (value: unknown) => unknown)(hooks.values[index]) : next; }];
  },
}));
const api = vi.hoisted(() => ({ GET: vi.fn(), POST: vi.fn() }));
vi.mock("react", () => ({ useState: hooks.useState }));
vi.mock("@/lib/api/client", () => ({ browserApi: api }));

import { ThreadMembersMenu } from "./ThreadMembersMenu";

type Node = { props?: Record<string, unknown> };
function children(node: unknown): unknown[] {
  if (Array.isArray(node)) return node.flatMap(children);
  if (!node || typeof node !== "object") return [];
  const props = (node as Node).props;
  return props ? [node, ...children(props.children)] : [];
}
function label(node: unknown): string {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(label).join("");
  return node && typeof node === "object" ? label((node as Node).props?.children) : "";
}
function control(root: unknown, tag: string, text: string): Record<string, unknown> {
  const found = children(root).find((node) => (node as { type?: string }).type === tag && label(node).includes(text));
  if (!found) throw new Error(`missing ${tag}: ${text}`);
  return (found as Node).props!;
}
const props = { objectType: "issue" as const, objectId: "issue-1", viewerId: "person-1",
  members: [{ personId: "person-1", displayName: "测试甲", title: null }], onChanged: vi.fn() };
function render(extra: { inviteOnly?: boolean } = {}) { hooks.index = 0; return ThreadMembersMenu({ ...props, ...extra }); }

beforeEach(() => { hooks.values = []; vi.clearAllMocks(); vi.stubGlobal("window", { dispatchEvent: vi.fn() }); });

describe("群成员入口", () => {
  it("首次议题邀请可选人、写理由并提交", async () => {
    api.GET.mockResolvedValue({ data: { people: [{ personId: "person-2", displayName: "测试乙" }] } });
    api.POST.mockResolvedValue({ data: { members: [] } });
    (control(render({ inviteOnly: true }), "button", "拉人进群").onClick as () => void)();
    await vi.waitFor(() => expect(api.GET).toHaveBeenCalled());
    const dialog = render({ inviteOnly: true });
    expect(control(dialog, "section", "拉人进群")["aria-label"]).toBe("拉人进群");
    const checkbox = children(dialog).find((node) => (node as Node).props?.type === "checkbox") as Node;
    (checkbox.props!.onChange as () => void)();
    const textarea = children(render({ inviteOnly: true })).find((node) => (node as { type?: string }).type === "textarea") as Node;
    (textarea.props!.onChange as (event: unknown) => void)({ target: { value: "请一起判断" } });
    (control(render({ inviteOnly: true }), "button", "确认拉人").onClick as () => void)();
    await vi.waitFor(() => expect(api.POST).toHaveBeenCalledWith("/api/threads/{objectType}/{objectId}/members", {
      params: { path: { objectType: "issue", objectId: "issue-1" } }, body: { personIds: ["person-2"], note: "请一起判断" },
    }));
    expect(props.onChanged).toHaveBeenCalled();
  });

  it("成员列表中的退出需二次确认", async () => {
    api.POST.mockResolvedValue({ response: { status: 204 } });
    (control(render(), "button", "群成员").onClick as () => void)();
    (control(render(), "button", "退出群聊").onClick as () => void)();
    const confirm = render();
    expect(control(confirm, "section", "退出群聊")["aria-label"]).toBe("退出群聊");
    expect(api.POST).not.toHaveBeenCalled();
    (control(confirm, "button", "确认退出").onClick as () => void)();
    await vi.waitFor(() => expect(api.POST).toHaveBeenCalledWith("/api/threads/{objectType}/{objectId}/leave", {
      params: { path: { objectType: "issue", objectId: "issue-1" } },
    }));
  });
});
