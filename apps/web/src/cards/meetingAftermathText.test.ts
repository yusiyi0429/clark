import { describe, expect, it } from "vitest";
import { actionCountText, childDecisionLabel, decisionGroups, sameSentence } from "./MeetingCard";
import type { MeetingPayload } from "./payloads";

type Item = NonNullable<MeetingPayload["outcome"]>["items"][number];
const todo = (status: string, effectRef: string | null = null) => ({ id: "t", kind: "todo", text: "x", ownerPersonId: "liu", review: { status, effectRef } }) as unknown as Item;

describe("会议页会后事项的文字", () => {
  it("待办收成一行，按实际推送写，不把没推送的说成已推给负责人", () => {
    expect(actionCountText([todo("pending"), todo("pending")])).toBe("2 项待办");
    expect(actionCountText([todo("confirmed", "task:1"), todo("pending")])).toBe("2 项待办 · 1 项已推给负责人");
    expect(actionCountText(Array.from({ length: 7 }, () => todo("confirmed", "task:1")))).toBe("7 项待办已推给负责人");
  });

  it("会议共识按主决定分组，子项挂在主决定下面，写自己的状态（只读）", () => {
    const d = (id: string, parentItemId: string | null = null, status = "pending") => ({ id, kind: "decision", text: id, parentItemId, review: { status, effectRef: null } }) as unknown as Item;
    const all = [d("m1"), d("c1", "m1"), d("c2", "m1"), d("m2"), d("c3", "m2"), d("m3")];
    expect(decisionGroups(all, all).map(({ item, children }) => [item.id, children.map((child) => child.id)])).toEqual([["m1", ["c1", "c2"]], ["m2", ["c3"]], ["m3", []]]);
    expect(childDecisionLabel(d("c1", "m1"))).toBeNull();
    expect(childDecisionLabel(d("c1", "m1", "confirmed"))).toEqual({ state: "confirmed", label: "已确认" });
    expect(childDecisionLabel(d("c1", "m1", "dismissed"))).toEqual({ state: "dismissed", label: "已忽略" });
  });

  it("纪要表格行改写出的原话已全部写在条目里时，算同一句，不再显示两遍（巡检 P2-27）", () => {
    const text = "重写公司战略与商业模式材料：按“总体愿景—当前业务—核心/辅线—能力与收入—进入路径”重构；更新业务架构图。（牵头：战略与材料团队；时间：下一轮管理层审阅前；完成标准：主线唯一。）";
    const quote = "战略与材料团队：重写公司战略与商业模式材料；按“总体愿景—当前业务—核心/辅线—能力与收入—进入路径”重构；更新业务架构图；下一轮管理层审阅前";
    expect(sameSentence(quote, text)).toBe(true);
    expect(sameSentence("我们下周先去客户现场看看再说", text)).toBe(false);
  });
});
