import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createObjectMaterial, type MaterialViewer } from "../src/objectMaterials.js";
import { SYSTEM_PROMPT } from "../src/piConversationRuntime.js";
import { findForbiddenPhrase } from "../src/promptStyle.js";
import { CITATION_SCHEME, NAMED_SOURCE_REF, SOURCE_CITATION_RULES } from "../src/sourceCitations.js";
import { TEST_CEO, createTestApp } from "./helpers.js";

const CEO: MaterialViewer = { personId: TEST_CEO.personId, role: "ceo", displayName: "测试甲" };

// 出处（10/14）：正文直接陈述，出处写成句末的 [名称](地址)，前端显示成小标记；内部依据 cite:<ref>，带网址的写网址，都没有写 cite:source。
describe("回答里的出处", () => {
  it("写法：Markdown 链接，内部依据 cite:<ref>（群材料段落、群讨论、历史决定、议题研究、会议），带网址写网址，都没有写 cite:source", () => {
    expect(CITATION_SCHEME).toBe("cite:");
    expect(NAMED_SOURCE_REF).toBe("source");
    // 旧企业知识已退役（ADR-0027），不再教模型写 memory: 引用
    expect(SOURCE_CITATION_RULES).not.toContain("memory:");
    for (const text of ["[资料名称](地址)", "cite:<引用标记>", "#p<段号>", "read_group_evidence", "read_decision_history",
      "cite:research:<议题 id>", "cite:issue:<议题 id>", "cite:meeting:<会议 id>", "cite:world:<ref>", "不能自己拼、不能猜", "出处带网址的写原网址", "cite:source", "名称里不写内部编号"]) {
      expect(SOURCE_CITATION_RULES).toContain(text);
    }
    expect(findForbiddenPhrase(SOURCE_CITATION_RULES)).toBeNull();
  });

  it("原生只读提示词不带出处写法", () => {
    expect(SYSTEM_PROMPT).not.toContain("# 出处的写法");
  });

  it("只知道材料 id 时找到它挂在哪个对象下；无权限、不存在都按 404", async () => {
    const t = await createTestApp();
    try {
      const issue = await t.createIssue();
      const ref = { objectType: "issue" as const, objectId: issue.objectRef.id };
      const made = await createObjectMaterial(t.pool, ref, CEO, "交付周报", "# 交付周报\n\n第一段。", "新写周报", randomUUID());
      const cookie = await t.loginCookie();
      const found = await t.app.inject({ method: "GET", url: `/api/materials/locate/${made.id}`, headers: { cookie } });
      expect(found.statusCode, found.body).toBe(200);
      expect(found.json()).toMatchObject({ materialId: made.id, objectType: "issue", objectId: ref.objectId, fileName: "交付周报.md", format: "markdown", version: 1 });
      const missing = await t.app.inject({ method: "GET", url: `/api/materials/locate/${randomUUID()}`, headers: { cookie } });
      expect(missing.statusCode).toBe(404);
      const member = await t.memberCookie();
      expect((await t.app.inject({ method: "GET", url: `/api/materials/locate/${made.id}`, headers: { cookie: member } })).statusCode).toBe(404);
      expect((await t.app.inject({ method: "GET", url: "/api/materials/locate/not-a-uuid", headers: { cookie } })).statusCode).toBe(400);
    } finally { await t.close(); }
  }, 20_000);
});
