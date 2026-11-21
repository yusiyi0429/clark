// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { StrictMode, act, type ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { TChatMessage, TChatPerson } from "@warmap/contracts";
import { ChatBody, chatQuote, chatWho, type ChatActions } from "./ChatView";

const at = "2026-11-20T08:00:00.000Z";
const id = "00000000-0000-4000-8000-000000000001";
let serial = 1;
const msg = (fields: Partial<TChatMessage>): TChatMessage => ({
  id: `00000000-0000-4000-8000-${String(++serial).padStart(12, "0")}`, author: "asker", text: "演练记录交到哪？", at, replyTo: null, sources: [],
  answer: null, wait: null, seen: false, retracted: false, correction: null, ...fields,
});
const who = (m: Partial<TChatMessage>, side: "with" | "from", asked?: TChatMessage) => chatWho(msg(m), side, { peer: "测试研发", myBuddy: "Miles" }, asked);
const q = msg({ author: "asker", answer: "answered" });
const waitQ = msg({ author: "asker", text: "网页的回滚演练能不能免掉？", answer: "answered", wait: { reason: "commit", at, closed: false } });
const actions: ChatActions = {
  send: async () => true, retry: async () => undefined, askOwner: async () => undefined, correct: async () => true, retract: async () => undefined,
};
const render = (side: "with" | "from", messages: TChatMessage[], peer: Partial<TChatPerson> = {}) => renderToStaticMarkup(
  <ChatBody chat={{ id, side, peer: { personId: "p-peer", displayName: "测试研发", left: false, ...peer }, peerBuddy: { name: "小研", form: "classic" },
    relation: "friends", messages, firstWaiting: null }} buddy={{ name: "Miles", form: "classic" }} actions={actions} />,
);
const 溪南 = { displayName: "溪南" };
const css = join(dirname(fileURLToPath(import.meta.url)), "chats.module.css");

// 真挂到 jsdom 上：量高度、滚动 jsdom 不会算，用桩。
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const undo: (() => void)[] = [];
const stub = (target: object, key: string, descriptor: PropertyDescriptor) => {
  const before = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, ...descriptor });
  undo.push(() => { if (before) Object.defineProperty(target, key, before); else delete (target as Record<string, unknown>)[key]; });
};
let root: Root | null = null;
const mount = (node: ReactNode) => {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(node));
  return host;
};
afterEach(() => {
  act(() => root?.unmount()); root = null;
  document.body.innerHTML = "";
  while (undo.length) undo.pop()!();
});
const typeInto = (field: HTMLTextAreaElement, text: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, text);
  field.dispatchEvent(new Event("input", { bubbles: true }));
});
const buttonNamed = (host: HTMLElement, label: string) => [...host.querySelectorAll("button")].find((button) => button.textContent === label)!;

describe("同事对话页", () => {
  it("每句标谁说的", () => {
    expect(who({ author: "asker" }, "with")).toBeNull();
    expect(who({ author: "buddy" }, "with", q)).toBe("测试研发的伙伴 · 他还没看");
    expect(who({ author: "buddy", seen: true }, "with", q)).toBe("测试研发的伙伴 · 他看过");
    expect(who({ author: "buddy", correction: { id, text: "x", at } }, "with", q)).toBe("测试研发的伙伴 · 他改过");
    expect(who({ author: "buddy", seen: true }, "with", waitQ)).toBe("测试研发的伙伴 · 转测试研发本人 · 他看过");
    expect(who({ author: "buddy", retracted: true }, "with", q)).toBe("测试研发收回了一句");
    expect(who({ author: "owner" }, "with")).toBe("测试研发"); expect(who({ author: "asker_buddy" }, "with")).toBe("Miles 替你问的");
    expect(who({ author: "buddy" }, "from", waitQ)).toBe("Miles · 转给你 · 要承诺"); expect(who({ author: "asker_buddy" }, "from")).toBe("测试研发的伙伴问的");
    expect(who({ author: "buddy", retracted: true }, "from", q)).toBe("Miles · 收回了");
    expect(who({ author: "buddy", correction: { id, text: "x", at } }, "from", q)).toBe("Miles · 改过");
    expect(who({ author: "buddy" }, "from", q)).toBe("Miles");
    expect(who({ author: "asker" }, "from")).toBe("测试研发"); expect(who({ author: "owner" }, "from")).toBeNull();
  });

  it("问的人这边", () => {
    const html = (answer: TChatMessage["answer"]) => render("with", [msg({ author: "asker", answer })]);
    expect(html("answering")).toContain('data-testid="typing"'); expect(html("failed")).toMatch(/没答上来[\s\S]*重试[\s\S]*问本人/);
    expect(html("limited")).toContain("今天问满了"); expect(html("limited")).not.toContain("重试");
    expect(html("asked_owner")).toContain("转测试研发本人");
    expect(render("with", [q, msg({ author: "buddy", replyTo: q.id, sources: ["说明（11/20）"] })])).toMatch(/出处：说明（11\/20）[\s\S]*问本人/);
    expect(render("with", [waitQ, msg({ author: "buddy", replyTo: waitQ.id })])).not.toContain("问本人");
    const gone = render("with", [q, msg({ author: "buddy", replyTo: q.id, text: "", retracted: true, correction: { id, text: "以本人这句为准", at } })]);
    expect(gone).toContain("测试研发收回了一句"); expect(gone).toContain("以本人这句为准"); expect(gone).not.toContain("问本人");
    expect(render("with", [])).toContain("发给测试研发的伙伴");
  });

  it("主人这边；对方已离开只读", () => {
    for (const word of ["改", "收回", "回这句", "回溪南"]) expect(render("from", [q, msg({ author: "buddy", replyTo: q.id })], 溪南)).toContain(word);
    const corrected = render("from", [q, msg({ author: "buddy", replyTo: q.id, correction: { id, text: "以这句为准", at } })], 溪南);
    expect(corrected).toContain("以这句为准"); expect(corrected).not.toMatch(/>改</);
    expect(render("from", [q, msg({ author: "buddy", replyTo: q.id, retracted: true })], 溪南)).not.toMatch(/>收回<|>改</);
    const left = render("with", [q], { ...溪南, left: true }); expect(left).toContain("已离开"); expect(left).not.toContain("发给溪南的伙伴");
    expect(render("from", [q, msg({ author: "buddy", replyTo: q.id })], { ...溪南, left: true })).not.toMatch(/回这句|>收回<|>改<|回溪南/);
  });

  it("主人这边的引用：缺省引最早等我的那句；回完一件（读回来的这段换了最早等我的）就引下一件；点掉就不引", () => {
    const plan = msg({ author: "asker", text: "排期谁来定", answer: "answered", wait: { reason: "commit", at, closed: false } });
    const view = (firstWaiting: string | null, side: "with" | "from" = "from") => ({ id, side, peer: { personId: "p", displayName: "测试研发", left: false },
      peerBuddy: null, relation: "friends" as const, messages: [waitQ, plan], firstWaiting });
    expect(chatQuote(view(waitQ.id), "waiting")?.id).toBe(waitQ.id);
    expect(chatQuote(view(plan.id), "waiting")).toMatchObject({ id: plan.id, label: "回复 排期谁来定" });
    expect(chatQuote(view(null), "waiting")).toBeNull();
    expect(chatQuote(view(waitQ.id), null)).toBeNull();
    expect(chatQuote(view(waitQ.id), plan.id)?.id).toBe(plan.id);
    expect(chatQuote(view(waitQ.id, "with"), "waiting")).toBeNull();
  });

  it("改一句：字框随内容变高（挂上和每次输入时设成 scrollHeight），那行撑到最大宽", async () => {
    let height = 240;
    stub(HTMLTextAreaElement.prototype, "scrollHeight", { get: () => height });
    const answer = msg({ author: "buddy", replyTo: q.id, text: "按拆分手册拆四件。".repeat(14) });
    const host = mount(<ChatBody chat={{ id, side: "from", peer: { personId: "p-peer", displayName: "溪南", left: false }, peerBuddy: null,
      relation: "friends", messages: [q, answer], firstWaiting: null }} buddy={{ name: "Miles", form: "classic" }} actions={actions} />);
    await act(async () => buttonNamed(host, "改").click());
    const field = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="改这句"]')!;
    expect(field.style.height).toBe("240px");
    expect(host.querySelector(`[data-id="${answer.id}"] > [data-editing]`)).not.toBeNull();
    height = 300;
    typeInto(field, field.value + "再加一句。");
    expect(field.style.height).toBe("300px");
  });

  describe("打开时停在哪", () => {
    const waiting = msg({ author: "asker", text: "排期谁来定", answer: "answered", wait: { reason: "commit", at, closed: false } });
    const lines = [q, msg({ author: "buddy", replyTo: q.id }), waiting, msg({ author: "buddy", replyTo: waiting.id })];
    const view = (messages: TChatMessage[]) => <StrictMode><ChatBody chat={{ id, side: "from", peer: { personId: "p-peer", displayName: "溪南", left: false },
      peerBuddy: null, relation: "friends", messages, firstWaiting: waiting.id }} buddy={{ name: "Miles", form: "classic" }} actions={actions} /></StrictMode>;
    /** 日志区 scrollHeight 恒为 1000，scrollTop 记在各元素上；scrollIntoView 记下滚到了谁。 */
    const scrolling = () => {
      const tops = new WeakMap<Element, number>();
      const into: Element[] = [];
      stub(HTMLElement.prototype, "scrollHeight", { get: () => 1000 });
      stub(Element.prototype, "scrollTop", { get(this: Element) { return tops.get(this) ?? 0; }, set(this: Element, top: number) { tops.set(this, top); } });
      stub(Element.prototype, "scrollIntoView", { value(this: Element) { into.push(this); } });
      return into;
    };
    const logOf = (host: HTMLElement) => host.querySelector(`[data-id="${waiting.id}"]`)!.parentElement!.parentElement!;

    it("from 侧停在最早等我的那句（StrictMode 下 effect 跑两遍也不再滚到最底），那句的气泡闪一下", () => {
      const into = scrolling();
      const host = mount(view(lines));
      const row = host.querySelector(`[data-id="${waiting.id}"]`)!;
      expect(into).toContain(row);
      expect(logOf(host).scrollTop).not.toBe(1000);
      expect(row.querySelector("[data-bubble]")!.getAttribute("data-cite-flash")).toBe("true");
    });

    it("后来多了句子再到最新；同样句数重画不动", () => {
      scrolling();
      const host = mount(view(lines));
      act(() => root!.render(view(lines)));
      expect(logOf(host).scrollTop).not.toBe(1000);
      act(() => root!.render(view([...lines, msg({ author: "asker", text: "那就周五" })])));
      expect(logOf(host).scrollTop).toBe(1000);
    });
  });

  it("样式不写字号、不出省略号", () => {
    expect(readFileSync(css, "utf8")).not.toMatch(/font-size|font-weight|text-overflow:\s*ellipsis|line-clamp/);
  });
});
