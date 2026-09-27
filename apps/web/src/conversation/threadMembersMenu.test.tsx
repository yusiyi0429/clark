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
const confirm = vi.hoisted(() => ({ ask: vi.fn() }));
vi.mock("react", async (original) => ({ ...(await original<typeof import("react")>()), useState: hooks.useState }));
vi.mock("@/lib/api/client", () => ({ browserApi: api }));
vi.mock("@/components/ConfirmDialog", () => ({ useConfirm: () => ({ ask: confirm.ask, dialog: null }) }));

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
/** 找到带 onPress、文字包含 text 的按钮。 */
function pressable(root: unknown, text: string): () => void {
  const found = children(root).find((node) => typeof (node as Node).props?.onPress === "function" && label(node).includes(text));
  if (!found) throw new Error(`missing button: ${text}`);
  return (found as Node).props!.onPress as () => void;
}
const props = { objectType: "issue" as const, objectId: "issue-1", viewerId: "person-1",
  members: [{ personId: "person-1", displayName: "测试甲", title: null }], onChanged: vi.fn() };
function render(extra: { inviteOnly?: boolean } = {}) { hooks.index = 0; return ThreadMembersMenu({ ...props, ...extra }); }

beforeEach(() => { hooks.values = []; vi.clearAllMocks(); vi.stubGlobal("window", { dispatchEvent: vi.fn() }); });

describe("群成员入口", () => {
  it("首次议题邀请可选人、写理由并提交", async () => {
    api.GET.mockResolvedValue({ data: { people: [{ personId: "person-2", displayName: "测试乙" }] } });
    api.POST.mockResolvedValue({ data: { members: [] } });
    pressable(render({ inviteOnly: true }), "拉人进群")();
    await vi.waitFor(() => expect(api.GET).toHaveBeenCalled());
    await Promise.resolve();
    const dialog = render({ inviteOnly: true });
    expect(children(dialog).some((node) => (node as Node).props?.isOpen === true)).toBe(true);
    const checkbox = children(dialog).find((node) => (node as Node).props?.type === "checkbox") as Node;
    (checkbox.props!.onChange as (event: unknown) => void)({ target: { checked: true } });
    const textarea = children(render({ inviteOnly: true })).find((node) => (node as { type?: string }).type === "textarea") as Node;
    (textarea.props!.onChange as (event: unknown) => void)({ target: { value: "请一起判断" } });
    pressable(render({ inviteOnly: true }), "拉进群")();
    await vi.waitFor(() => expect(api.POST).toHaveBeenCalledWith("/api/threads/{objectType}/{objectId}/members", {
      params: { path: { objectType: "issue", objectId: "issue-1" } }, body: { personIds: ["person-2"], note: "请一起判断" },
    }));
    await vi.waitFor(() => expect(props.onChanged).toHaveBeenCalled());
  });

  it("成员列表中的退出需二次确认，取消时不退出", async () => {
    api.POST.mockResolvedValue({ response: { status: 204 } });
    confirm.ask.mockResolvedValueOnce(false);
    pressable(render(), "退出群聊")();
    await vi.waitFor(() => expect(confirm.ask).toHaveBeenCalledTimes(1));
    expect(api.POST).not.toHaveBeenCalled();
    confirm.ask.mockResolvedValueOnce(true);
    pressable(render(), "退出群聊")();
    await vi.waitFor(() => expect(api.POST).toHaveBeenCalledWith("/api/threads/{objectType}/{objectId}/leave", {
      params: { path: { objectType: "issue", objectId: "issue-1" } },
    }));
  });
});
