import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import type { Card } from "@/lib/api/client";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
const { DISMISS_NOTE, DismissDialogContent, IssueMoreMenu, JoinDialogContent, MoreMenuList, moreMenuEntries } = await import("./IssueMoreMenu");

/** 议题页页头「更多 ⋯」：加入已有会议…、移出议题…（一号位视角，没有「安排一场会议」）。 */
type El = { type?: unknown; props?: Record<string, unknown> };
function nodes(value: unknown): El[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object") return [];
  const node = value as El;
  return node.props ? [node, ...nodes(node.props.children)] : [];
}
const text = (value: unknown): string => Array.isArray(value) ? value.map(text).join("") : typeof value === "string" ? value
  : value && typeof value === "object" && (value as El).props ? text((value as El).props!.children) : "";
const buttons = (tree: unknown) => nodes(tree).filter((node) => node.props && ("onPress" in node.props));
const buttonLabelled = (tree: unknown, label: string) => buttons(tree).find((node) => text(node.props!.children) === label);

const card = (types: string[]) => ({ id: "issue:1", kind: "issue", objectRef: { type: "issue", id: "1", version: 1 }, title: "议题", payload: {},
  actions: types.map((actionType) => ({ actionId: `a-${actionType}`, actionType, label: actionType })) }) as unknown as Card;

describe("更多菜单的项", () => {
  it("有加入会议、移出两个动作时列两项，文字带省略号表示后面还有一步；只有一个就只列一个", () => {
    expect(moreMenuEntries(card(["issue.join_meeting", "issue.dismiss"]), true).map((entry) => entry.label)).toEqual(["加入已有会议…", "移出议题…"]);
    expect(moreMenuEntries(card(["issue.dismiss"]), true).map((entry) => entry.id)).toEqual(["dismiss"]);
    expect(moreMenuEntries(card(["issue.join_meeting"]), true).map((entry) => entry.id)).toEqual(["join"]);
  });

  it("没有「安排一场会议」：即使卡上带 issue.create_meeting 也不进菜单；议题不在待处理时一项都没有", () => {
    const entries = moreMenuEntries(card(["issue.create_meeting", "issue.join_meeting", "issue.dismiss"]), true);
    expect(entries.map((entry) => entry.label).join("")).not.toContain("安排");
    expect(moreMenuEntries(card(["issue.join_meeting", "issue.dismiss"]), false)).toEqual([]);
    expect(moreMenuEntries(card([]), true)).toEqual([]);
  });

  it("触发钮读屏名「更多操作」；没有可用项时整颗不出现；浮层没打开时不占页面", () => {
    const html = renderToStaticMarkup(<IssueMoreMenu card={card(["issue.join_meeting", "issue.dismiss"])} onCard={() => undefined} pendingIssue scheduledMeetings={[]} />);
    expect(html).toContain('aria-label="更多操作"');
    expect(html).not.toContain("加入已有会议");
    expect(renderToStaticMarkup(<IssueMoreMenu card={card([])} onCard={() => undefined} pendingIssue scheduledMeetings={[]} />)).toBe("");
  });

  it("菜单项：每项一颗按钮，点哪项就把那项交出去；字面是中文", () => {
    const picks: string[] = [];
    const tree = MoreMenuList({ entries: moreMenuEntries(card(["issue.join_meeting", "issue.dismiss"]), true), onPick: (id) => picks.push(id) });
    const items = buttons(tree);
    expect(items.map((item) => text(item.props!.children))).toEqual(["加入已有会议…", "移出议题…"]);
    (items[1].props!.onPress as () => void)();
    expect(picks).toEqual(["dismiss"]);
    expect(renderToStaticMarkup(tree as ReactElement)).not.toMatch(/Meeting|scheduled|dismiss/);
  });
});

describe("加入已有会议弹层", () => {
  const props = { options: [{ value: "m1", label: "周五经营会" }], onChange: () => undefined, onCancel: () => undefined, onConfirm: () => undefined };

  it("用统一的 Select 选会议；没选之前「加入会议」不可点，选了之后可点并交出确认", () => {
    const empty = JoinDialogContent({ ...props, value: "", pending: false });
    const select = nodes(empty).find((node) => node.props && "options" in node.props && "placeholder" in node.props);
    expect(select?.props?.["aria-label"]).toBe("选择会议");
    expect(select?.props?.placeholder).toBe("选择一场待开的会议");
    expect(buttonLabelled(empty, "加入会议")?.props?.isDisabled).toBe(true);
    const chosen = JoinDialogContent({ ...props, value: "m1", pending: false });
    expect(buttonLabelled(chosen, "加入会议")?.props?.isDisabled).toBe(false);
    const confirmed = vi.fn();
    (buttonLabelled(JoinDialogContent({ ...props, value: "m1", pending: false, onConfirm: confirmed }), "加入会议")!.props!.onPress as () => void)();
    expect(confirmed).toHaveBeenCalledTimes(1);
  });

  it("没有待开的会议时下拉禁用并说明；提交中钮上写「正在加入…」", () => {
    const tree = JoinDialogContent({ ...props, options: [], value: "", pending: false });
    const select = nodes(tree).find((node) => node.props && "options" in node.props);
    expect(select?.props?.disabled).toBe(true);
    expect(select?.props?.placeholder).toBe("暂时没有待开的会议");
    const busy = JoinDialogContent({ ...props, value: "m1", pending: true });
    expect(nodes(busy).some((node) => text(node.props?.children) === "正在加入…" && node.props?.isDisabled === true)).toBe(true);
  });
});

describe("移出议题确认", () => {
  const props = { onReason: () => undefined, onCancel: () => undefined, onConfirm: () => undefined };

  it("说明移出后不再出现在决策面、可在已处理中恢复；原因输入框必填", () => {
    expect(DISMISS_NOTE).toBe("移出后不再出现在决策面，可在已处理中恢复。");
    const html = renderToStaticMarkup(<>{DismissDialogContent({ ...props, reason: "", pending: false })}</>);
    expect(html).toContain("移出这个议题？");
    expect(html).toContain("移出后不再出现在决策面，可在已处理中恢复。");
    expect(html).toContain("原因（必填）");
    expect(html).toMatch(/<input[^>]*required=""/);
  });

  it("原因没填（或只有空格）时「移出议题」不可点；填了才可点并交出确认", () => {
    expect(buttonLabelled(DismissDialogContent({ ...props, reason: "", pending: false }), "移出议题")?.props?.isDisabled).toBe(true);
    expect(buttonLabelled(DismissDialogContent({ ...props, reason: "   ", pending: false }), "移出议题")?.props?.isDisabled).toBe(true);
    const confirmed = vi.fn();
    const ready = buttonLabelled(DismissDialogContent({ ...props, reason: "已在别处解决", pending: false, onConfirm: confirmed }), "移出议题");
    expect(ready?.props?.isDisabled).toBe(false);
    (ready!.props!.onPress as () => void)();
    expect(confirmed).toHaveBeenCalledTimes(1);
  });

  it("确认钮是危险色；取消是默认焦点（autoFocus），确认没有", () => {
    const tree = DismissDialogContent({ ...props, reason: "已在别处解决", pending: false });
    expect(buttonLabelled(tree, "移出议题")?.props).toMatchObject({ variant: "danger" });
    expect(buttonLabelled(tree, "移出议题")?.props?.autoFocus).toBeUndefined();
    expect(buttonLabelled(tree, "取消")?.props?.autoFocus).toBe(true);
  });

  it("原因输入框走统一输入框（普通 input，不带自定义边框类），改动交给外面", () => {
    const changes: string[] = [];
    const tree = DismissDialogContent({ ...props, reason: "", pending: false, onReason: (value) => changes.push(value) });
    const input = nodes(tree).find((node) => node.type === "input");
    expect(input?.props?.["aria-label"]).toBe("移出原因");
    expect(input?.props?.maxLength).toBe(200);
    (input!.props!.onChange as (event: { target: { value: string } }) => void)({ target: { value: "重复议题" } });
    expect(changes).toEqual(["重复议题"]);
  });
});
