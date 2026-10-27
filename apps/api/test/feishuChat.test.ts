import { afterEach, describe, expect, it } from "vitest";
import type { ConversationRuntime } from "../src/conversations.js";
import type { FeishuClient } from "../src/feishu/client.js";
import { messageText, toFeishuMarkdown } from "../src/feishuChat.js";
import { createTestApp, TEST_CEO, type TestApp } from "./helpers.js";

type Sent = { kind: "card" | "post" | "update"; to: string; markdown: string };

function fakeFeishu(failUpdate = false) {
  const sent: Sent[] = [];
  let next = 0;
  const markdownOf = (content: object) => {
    const post = (content as { zh_cn?: { content: { text: string }[][] } }).zh_cn;
    if (post) return { markdown: post.content[0][0].text };
    return { markdown: (content as { elements: { tag: string; content?: string }[] }).elements.find((element) => element.tag === "markdown")?.content ?? "" };
  };
  const client = {
    async sendMessage(_type: string, id: string, msgType: string, content: object) {
      sent.push({ kind: msgType === "post" ? "post" : "card", to: id, ...markdownOf(content) });
      return { messageId: `om_${++next}` };
    },
    async updateCard(messageId: string, content: object) {
      if (failUpdate) throw new Error("no scope");
      sent.push({ kind: "update", to: messageId, ...markdownOf(content) });
    },
  } as unknown as FeishuClient;
  return { client, sent };
}

const answering = (answer: string): ConversationRuntime => ({
  async run(input) {
    input.emit({ type: "message", delta: answer });
    return { assistantMessage: answer, runtimeEntries: [] };
  },
});

const dm = (openId: string, text: string, type = "text") => ({
  sender: { sender_type: "user", sender_id: { open_id: openId } },
  message: { message_id: `om_in_${Math.random()}`, chat_type: "p2p", message_type: type, content: JSON.stringify(type === "text" ? { text } : { image_key: "x" }) },
});

let t: TestApp | undefined;
afterEach(async () => { await t?.close(); t = undefined; });

async function start(runtime: ConversationRuntime, failUpdate = false) {
  const feishu = fakeFeishu(failUpdate);
  t = await createTestApp({}, runtime, { feishuClient: feishu.client });
  await t.loginCookie();
  await t.sql("INSERT INTO feishu_identities (person_id, open_id, name) VALUES ($1, 'ou_ceo', '测试甲')", [TEST_CEO.personId]);
  return feishu;
}

describe("飞书私聊机器人 = 首页对话", () => {
  it("以本人身份问首页对话：先回「正在想」小卡，写完小卡缩成用时、回答另发普通消息；问与答都存进首页对话并标飞书", async () => {
    const feishu = await start(answering("## 本周进展\n- 战场 A 推进中 [记忆](cite:pmem:x)，见[《经营原则》](cite:doc:1)。 [进展](cite:progress:2)\n详见[会议](/meetings/m1)"));
    await t!.app.feishuChat!.onMessage(dm("ou_ceo", "这周怎么样"));
    await t!.app.feishuChat!.idle();

    expect(feishu.sent[0]).toMatchObject({ kind: "card", to: "ou_ceo" });
    expect(feishu.sent[0].markdown).toContain("正在想");
    const [shrunk, answer] = feishu.sent.slice(-2);
    expect(shrunk).toMatchObject({ kind: "update", to: "om_1" });
    expect(shrunk.markdown).toMatch(/用时 \d+ 秒/);
    expect(answer).toMatchObject({ kind: "post", to: "ou_ceo" });
    expect(answer.markdown).toContain("**本周进展**");
    expect(answer.markdown).toContain("- 战场 A 推进中，见《经营原则》。\n");
    expect(answer.markdown).not.toContain("cite:");
    expect(answer.markdown).toContain(`${t!.publicOrigin}/api/auth/feishu/start?next=${encodeURIComponent("/meetings/m1")}`);

    const cookie = await t!.loginCookie();
    const history = (await t!.app.inject({ method: "GET", url: "/api/conversations/global/messages", headers: { cookie } })).json().messages as
      { role: string; content: string; via?: string }[];
    expect(history.map((message) => [message.role, message.via])).toEqual([["user", "feishu"], ["assistant", "feishu"]]);
    expect(history[0].content).toBe("这周怎么样");
  });

  it("改不了卡（没开更新权限）时小卡停在「正在想」，回答照样另发", async () => {
    const feishu = await start(answering("好的"), true);
    await t!.app.feishuChat!.onMessage(dm("ou_ceo", "在吗"));
    await t!.app.feishuChat!.idle();
    expect(feishu.sent.map((item) => item.kind)).toEqual(["card", "post"]);
    expect(feishu.sent[1].markdown).toBe("好的");
  });

  it("没关联天枢的飞书身份、非文字消息、群消息：不进对话", async () => {
    const feishu = await start(answering("不该出现"));
    await t!.app.feishuChat!.onMessage(dm("ou_stranger", "你好"));
    await t!.app.feishuChat!.onMessage(dm("ou_ceo", "", "image"));
    await t!.app.feishuChat!.onMessage({ ...dm("ou_ceo", "群里"), message: { chat_type: "group", message_type: "text", content: JSON.stringify({ text: "群里" }) } });
    await t!.app.feishuChat!.idle();
    expect(feishu.sent.map((item) => item.markdown)).toEqual([
      expect.stringContaining("还没和天枢账号关联"),
      expect.stringContaining("只看得懂文字消息"),
    ]);
    expect((await t!.sql("SELECT count(*)::int AS n FROM conversation_messages"))[0].n).toBe(0);
  });
});

describe("消息文字与回答格式", () => {
  it("富文本把各段文字拼起来；图表块去掉并提示在天枢查看", () => {
    expect(messageText("post", JSON.stringify({ zh_cn: { title: "问题", content: [[{ tag: "text", text: "第一段" }], [{ tag: "text", text: "第二段" }]] } })))
      .toBe("问题\n第一段\n第二段");
    const answer = toFeishuMarkdown("结论\n\n```timeline\n{\"items\":[]}\n```\n\n完", "https://t.example");
    expect(answer).toMatchObject({ content: "结论\n\n完", richDropped: true, truncated: false });
  });
});
