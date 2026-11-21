import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { TChatMessage, TChatView } from "@warmap/contracts";

// 同步的钩子：useState 按位置存值，重画时还在（照 friendSheet.test.tsx）。
const hooks = vi.hoisted(() => ({
  position: 0, values: [] as unknown[],
  useState(initial: unknown) {
    const key = hooks.position++;
    if (!(key in hooks.values)) hooks.values[key] = typeof initial === "function" ? (initial as () => unknown)() : initial;
    return [hooks.values[key], (next: unknown) => { hooks.values[key] = typeof next === "function" ? (next as (value: unknown) => unknown)(hooks.values[key]) : next; }];
  },
}));
vi.mock("react", async (original) => ({ ...(await original<typeof import("react")>()), useState: hooks.useState }));

/** 输入框换成替身：截下 onSend 和 quote。 */
type BarProps = { onSend: (text: string, files: File[]) => Promise<boolean>; quote: { key: string; label: string; onClear: () => void } | null };
const bar = vi.hoisted(() => ({ props: null as BarProps | null }));
vi.mock("./InputBar", () => ({ InputBar: (props: BarProps) => { bar.props = props; return null; } }));
import { ChatBody, type ChatActions } from "./ChatView";

const at = "2026-11-20T08:00:00.000Z";
const question = (n: number, text: string): TChatMessage => ({
  id: `00000000-0000-4000-8000-00000000000${n}`, author: "asker", text, at, replyTo: null, sources: [],
  answer: "answered", wait: { reason: "commit", at, closed: false }, seen: false, retracted: false, correction: null,
});
const price = question(1, "报价能定吗");
const plan = question(2, "排期谁来定");
const chat = (firstWaiting: string | null): TChatView => ({ id: "00000000-0000-4000-8000-000000000009", side: "from",
  peer: { personId: "p", displayName: "测试乙", left: false }, peerBuddy: null, relation: "friends", messages: [price, plan], firstWaiting });
const send = vi.fn<ChatActions["send"]>(async () => true);
const actions: ChatActions = { send, retry: async () => undefined, askOwner: async () => undefined, correct: async () => true, retract: async () => undefined };
const render = (view: TChatView) => {
  hooks.position = 0;
  renderToStaticMarkup(<ChatBody chat={view} buddy={{ name: "Miles", form: "classic" }} actions={actions} />);
  return bar.props!;
};

beforeEach(() => { hooks.values = []; send.mockClear(); });

describe("主人连回两句", () => {
  it("回完一件引下一件；点掉引用再发不带 replyTo", async () => {
    expect(render(chat(price.id)).quote?.label).toBe("回复 报价能定吗");
    await bar.props!.onSend("报价周五定", []);
    expect(send).toHaveBeenLastCalledWith("报价周五定", price.id);
    // 读回来的这段里最早等我的换成了排期。
    expect(render(chat(plan.id)).quote?.label).toBe("回复 排期谁来定");
    bar.props!.quote!.onClear();
    expect(render(chat(plan.id)).quote).toBeNull();
    await bar.props!.onSend("先按去年的价谈", []);
    expect(send).toHaveBeenLastCalledWith("先按去年的价谈", undefined);
    // 单说一句以后又回到引最早等我的那句：排期还在等。
    expect(render(chat(plan.id)).quote?.label).toBe("回复 排期谁来定");
  });
});
