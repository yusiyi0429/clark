import { describe, expect, it } from "vitest";
import { createTestApp } from "./helpers.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { plainKnowledgeText } from "../src/companyMemory.js";
import { plainSectionTitle } from "../src/routes/knowledge.js";
import type { ConversationRuntime } from "../src/conversations.js";

function parseSse(body: string) {
  return body.split("\n\n").map((block) => /data: (.*)/.exec(block)?.[1]).filter(Boolean).map((data) => JSON.parse(data!));
}

describe("企业知识原文直取（巡检 P0-2）", () => {
  it("按 memory:<文件>#s<n> 取一节原文；不带节号取整份；不存在或格式错给中文错误", async () => {
    const t = await createTestApp();
    try {
      const cookie = await t.memberCookie();
      const get = (ref: string) => t.app.inject({ method: "GET", url: `/api/knowledge/source?ref=${encodeURIComponent(ref)}`, headers: { cookie } });
      const one = await get("memory:company.md#s1");
      expect(one.statusCode, one.body).toBe(200);
      expect(one.json()).toMatchObject({ file: "company.md", sections: [{ id: "company.md#s1", title: "1. 测试战略" }] });
      expect(one.json().sections[0].passages.map((p: { text: string }) => p.text).join("\n")).toContain("战略锚点");
      expect((await get("company.md")).json().sections.length).toBeGreaterThan(1);
      expect((await get("memory:company.md#s99")).json()).toMatchObject({ code: "KNOWLEDGE_NOT_FOUND" });
      expect((await get("memory:../etc/passwd")).statusCode).toBe(400);
      expect((await t.app.inject({ method: "GET", url: "/api/knowledge/source?ref=company.md" })).statusCode).toBe(401);
    } finally { await t.close(); }
  });

  it("导入写的「来源／资料时间」登记段不当原文显示，更新时间用资料时间；标题去掉资料版本括注（复验）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "knowledge-src-"));
    await writeFile(join(dir, "kd-goals.md"), "# 目标（业务视角 v1.0 A4）\n\n## 目标（业务视角 v1.0 A4）\n来源：《业务视角_x》A4-LTO\n资料时间：2026-10-10T09:08:00.000Z\n\n第一段原文。\n\n第二段原文。\n", "utf8");
    const t = await createTestApp({ companyMemorySeedDir: dir });
    try {
      const cookie = await t.memberCookie();
      const res = await t.app.inject({ method: "GET", url: `/api/knowledge/source?ref=${encodeURIComponent("memory:kd-goals.md#s1")}`, headers: { cookie } });
      expect(res.statusCode, res.body).toBe(200);
      const [section] = res.json().sections;
      expect(section.title).toBe("目标");
      expect(section.updatedAt).toBe("2026-10-10T09:08:00.000Z");
      expect(section.passages.map((p: { text: string }) => p.text)).toEqual(["第一段原文。", "第二段原文。"]);
    } finally { await t.close(); await rm(dir, { recursive: true, force: true }); }
  });

  it("节标题只去掉末尾的资料版本括注", () => {
    expect(plainSectionTitle("集团身份、原则与战略（业务视角 v1.0 A1、A2）")).toBe("集团身份、原则与战略");
    expect(plainSectionTitle("TokenHub（首版）")).toBe("TokenHub（首版）");
  });

  it("给人看的正文去掉 wiki / docx / revision 括注，保留普通括号", () => {
    expect(plainKnowledgeText("飞书《业务视角》（wiki Cv8t，docx QeXA，revision 12，2026-10-10 版）。TokenHub（首版）"))
      .toBe("飞书《业务视角》。TokenHub（首版）");
  });

  it("出处里的飞书链接（括注或裸链接）不显示，书名号里的文档名保留", () => {
    expect(plainKnowledgeText("出处：《词元云集 · 9 月复盘》（https://tokenking.feishu.cn/wiki/E9DywZNqtidsBzkrcg6cRAAUn2e）；补充：2026_09_月度复盘（妙记，组织者刘人豪）（https://tokenking.feishu.cn/minutes/obcnh1，引用妙记 AI 总结）。见 https://x.feishu.cn/docx/abc 。"))
      .toBe("出处：《词元云集 · 9 月复盘》；补充：2026_09_月度复盘（妙记，组织者刘人豪）。见 。");
  });

  it("资料文件全名换成短名：去掉「业务视角_TKOS_Inception_」前缀与版本、日期", () => {
    expect(plainKnowledgeText("出处：飞书《业务视角_TKOS_Inception_集团经营上下文与指标定义_v1.0_2026-10-10》。另见《业务视角》。"))
      .toBe("出处：飞书《集团经营上下文与指标定义》。另见《业务视角》。");
  });
});

describe("对话卡住检测", () => {
  it("整轮超过卡住阈值没有任何事件（连恢复都没有进展）才停下，说明原因并在对话里留一句说明", async () => {
    const runtime: ConversationRuntime = {
      async run(input): Promise<never> {
        input.emit({ type: "tool", phase: "started", toolCallId: "1", name: "get_passages" });
        input.emit({ type: "tool", phase: "completed", toolCallId: "1", name: "get_passages", isError: false });
        await new Promise<void>((resolve) => input.signal.addEventListener("abort", () => resolve(), { once: true }));
        throw input.signal.reason;
      },
    };
    const t = await createTestApp({}, runtime, { conversationStallTimeoutMs: 40 });
    try {
      const cookie = await t.loginCookie();
      const started = Date.now();
      const response = await t.app.inject({ method: "POST", url: "/api/conversations/global/messages",
        headers: { cookie, origin: t.publicOrigin, accept: "text/event-stream" }, payload: { message: "给我看原文" } });
      expect(Date.now() - started).toBeLessThan(5_000);
      const error = parseSse(response.body).find((event) => event.type === "error");
      expect(error).toMatchObject({ code: "TURN_STALLED", resume: "retry" });
      expect(error.message).toMatch(/没有任何进展.*点「重新回答」再试一次/);
      expect((await t.conversationState("global")).messages.map((message) => message.content)).toEqual(["给我看原文", "（这次回答没有完成：长时间没有进展。）"]);
      expect(await t.agentRuns()).toEqual([expect.objectContaining({ status: "aborted", error: expect.stringContaining("stalled") })]);
    } finally { await t.close(); }
  });

  it("持续出字的长回答不会被卡住检测误停", async () => {
    const runtime: ConversationRuntime = {
      async run(input) {
        for (let i = 0; i < 8; i += 1) {
          input.emit({ type: "message", delta: `第${i}段` });
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        return { assistantMessage: "完整回答", runtimeEntries: input.runtimeEntries };
      },
    };
    const t = await createTestApp({}, runtime, { conversationStallTimeoutMs: 60 });
    try {
      const cookie = await t.loginCookie();
      const response = await t.app.inject({ method: "POST", url: "/api/conversations/global/messages",
        headers: { cookie, origin: t.publicOrigin, accept: "text/event-stream" }, payload: { message: "长一点" } });
      expect(parseSse(response.body)).toContainEqual(expect.objectContaining({ type: "done", status: "completed" }));
    } finally { await t.close(); }
  });
});
