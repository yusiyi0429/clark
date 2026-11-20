import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { TChatMessage, TChatPerson } from "@warmap/contracts";
import { ChatBody, chatWho, type ChatActions } from "./ChatView";

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
const css = new URL("./chats.module.css", import.meta.url);

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

  it("样式不写字号、不出省略号", () => {
    expect(readFileSync(css, "utf8")).not.toMatch(/font-size|font-weight|text-overflow:\s*ellipsis|line-clamp/);
  });
});
