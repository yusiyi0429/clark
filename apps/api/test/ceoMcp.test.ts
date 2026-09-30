import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { emptyDraft, emptyPreflight } from "../src/meetingStore.js";
import { call, executionFixture, newTask } from "./executionFixture.js";
import { createTestApp, TEST_CEO, TEST_MEMBER } from "./helpers.js";

const rpc = (id: number, method: string, params?: Record<string, unknown>) =>
  ({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
const send = (app: Awaited<ReturnType<typeof createTestApp>>["app"], token: string, id: number, method: string, params?: Record<string, unknown>) =>
  app.inject({ method: "POST", url: "/mcp/me", headers: { authorization: `Bearer ${token}`, accept: "application/json, text/event-stream" },
    payload: rpc(id, method, params) });
const invoke = async (app: Awaited<ReturnType<typeof createTestApp>>["app"], token: string, id: number, name: string, args: Record<string, unknown> = {}) =>
  (await send(app, token, id, "tools/call", { name, arguments: args })).json().result as { isError: boolean; content: { text: string }[] };
const value = (result: { content: { text: string }[] }) => JSON.parse(result.content[0].text);

describe("CEO 个人 MCP", () => {
  it("CEO 有公司只读工具与个人复盘工具；详情、待办和周进展不含动作凭据", async () => {
    const f = await executionFixture("open");
    try {
      const created = await call(f, f.ceo, "POST", "/api/me/tokens", { name: "CEO 工具", client: "codex", expiresInDays: 30 });
      expect(created.statusCode).toBe(200);
      const { token, view } = created.json();
      expect((await call(f, f.ceo, "GET", "/api/me/tokens")).json().tokens[0].id).toBe(view.id);
      const memberToken = (await call(f, f.member, "POST", "/api/me/tokens", { name: "成员工具", client: "claude", expiresInDays: 30 })).json().token;
      const initialized = (await send(f.t.app, token, 1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } })).json();
      expect(initialized.result.instructions).toContain("拍板、签发、确认请回天枢网页操作");
      const ceoTools = (await send(f.t.app, token, 2, "tools/list")).json().result.tools;
      expect(ceoTools.map((tool: { name: string }) => tool.name)).toEqual(["get_issue", "get_meeting", "company_progress", "get_mission_card", "edit_mission_card", "list_pending", "get_my_review", "save_review_draft"]);
      expect(ceoTools.filter((tool: { name: string }) => !["save_review_draft", "edit_mission_card"].includes(tool.name)).every((tool: { annotations?: { readOnlyHint?: boolean } }) => tool.annotations?.readOnlyHint === true)).toBe(true);
      expect((await send(f.t.app, memberToken, 3, "tools/list")).json().result.tools.map((tool: { name: string }) => tool.name))
        .toEqual(["list_my_items", "get_item", "append_progress", "update_status", "get_mission_card", "edit_mission_card", "list_pending", "get_my_review", "save_review_draft"]);
      expect(value(await invoke(f.t.app, memberToken, 4, "get_issue", { issueId: randomUUID() })))
        .toMatchObject({ code: "FORBIDDEN", message: "这个工具只对 CEO 开放" });
      expect(value(await invoke(f.t.app, token, 5, "append_progress", { itemId: randomUUID(), body: "test" })))
        .toMatchObject({ code: "FORBIDDEN", message: "这个工具只对成员开放" });

      const issue = await f.t.app.inject({ method: "POST", url: "/api/dri/issues",
        headers: { authorization: `Bearer ${f.t.env.driServiceToken}` },
        payload: { externalId: randomUUID(), submitterPersonId: TEST_MEMBER.personId, title: "十月验收口径",
          whyNow: "需要确定", sourceRef: "dri://mcp-test", location: { level: "battlefield", battlefieldId: "growth" } } });
      expect(issue.statusCode).toBe(201);
      const issueId = issue.json().cards[0].objectRef.id as string;
      const meetingId = randomUUID();
      const preflight = { ...emptyPreflight(), status: "ready", brief: "按验收口径讨论",
        entries: [{ id: "agenda-1", kind: "agenda", title: "验收口径", body: "讨论十月口径", sourceRefs: ["test"] }] };
      await f.t.sql(`INSERT INTO meetings(id,version,title,status,scheduled_at,lead_dri_id,ceo_participant_id,participants,issue_ids,preflight,draft,materials,origin_ref,ends_at)
        VALUES($1,1,'验收口径会','scheduled',$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,'[]'::jsonb,'{}'::jsonb,$9)`,
      [meetingId, "2026-10-11T02:00:00Z", TEST_MEMBER.personId, TEST_CEO.personId,
        JSON.stringify([{ personId: TEST_MEMBER.personId, displayName: "测试乙", roles: ["dri"], sourceRef: "test", updatedAt: "2026-10-01" }]),
        JSON.stringify([issueId]), JSON.stringify(preflight), JSON.stringify(emptyDraft()), "2026-10-11T03:00:00Z"]);
      // executionFixture 的简版已签发计划没有首页投影需要的协商数组。
      await f.t.sql("UPDATE monthly_plans SET negotiation=$1::jsonb", [JSON.stringify({ edits: [], checkedItemIds: [], feedback: [], note: "" })]);
      const results = [
        await invoke(f.t.app, token, 6, "list_pending"),
        await invoke(f.t.app, token, 7, "get_issue", { issueId }),
        await invoke(f.t.app, token, 8, "get_meeting", { meetingId }),
        await invoke(f.t.app, token, 9, "get_mission_card", { cardId: f.card }),
        await invoke(f.t.app, token, 10, "company_progress", {}),
      ];
      for (const result of results) {
        expect(result.isError).toBe(false);
        expect(JSON.stringify(value(result))).not.toMatch(/"(?:actionId|actions|token|secret|signature)"/i);
      }
      expect(value(results[0]).items).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "issue", id: issueId, href: `/issues/${issueId}` }),
        expect.objectContaining({ kind: "meeting", id: meetingId, href: `/meetings/${meetingId}` }),
      ]));
      expect(value(results[1])).toMatchObject({ id: issueId, meetings: [{ id: meetingId }] });
      expect(value(results[2])).toMatchObject({ id: meetingId, agenda: [{ title: "验收口径" }] });
      expect(value(results[3])).toMatchObject({ id: f.card, battlefield: { id: "growth" }, missions: [{ title: "上线" }, { title: "验证" }] });
      expect((await call(f, f.ceo, "DELETE", `/api/me/tokens/${view.id}`)).statusCode).toBe(204);
      expect((await send(f.t.app, token, 11, "tools/list")).statusCode).toBe(401);
    } finally { await f.t.close(); }
  });

  it("company_progress 校验周并按战场、人员筛选进展与状态计数", async () => {
    const f = await executionFixture();
    try {
      const { token } = (await call(f, f.ceo, "POST", "/api/me/tokens", { name: "进展", client: "other", expiresInDays: null })).json();
      const linked = (await call(f, f.member, "POST", "/api/me/tasks", newTask())).json();
      const plain = (await call(f, f.member, "POST", "/api/me/tasks", newTask(null, { title: "独立事项" }))).json();
      await f.t.sql(`INSERT INTO task_progress(id,task_id,author_id,source,body,links,created_at)
        VALUES($1,$2,$3,'web','本周战场进展','[]'::jsonb,$4),($5,$6,$3,'web','本周独立进展','[]'::jsonb,$4),
          ($7,$2,'person-fixture-003','web','协作者进展','[]'::jsonb,$4)`,
      [randomUUID(), linked.id, TEST_MEMBER.personId, "2026-10-07T02:00:00Z", randomUUID(), plain.id, randomUUID()]);
      const filtered = value(await invoke(f.t.app, token, 1, "company_progress", { week: "2026-W41", battlefieldId: "growth", personId: TEST_MEMBER.personId }));
      expect(filtered.week).toBe("2026-W41");
      expect(filtered.people).toMatchObject([{ personId: TEST_MEMBER.personId, items: [{ itemId: linked.id }] }]);
      expect(filtered.people).toHaveLength(1);
      expect(filtered.statusByBattlefield).toMatchObject([{ battlefieldId: "growth", not_started: 1 }]);
      expect(filtered.statusByBattlefield).not.toEqual(expect.arrayContaining([expect.objectContaining({ battlefieldId: null })]));
      const otherWeek = value(await invoke(f.t.app, token, 2, "company_progress", { week: "2026-W40" }));
      expect(otherWeek.people).toEqual([]);
      expect(value(await invoke(f.t.app, token, 3, "company_progress", { week: "2027-W53" })).code).toBe("INVALID_INPUT");
    } finally { await f.t.close(); }
  });

  it("双角色人的令牌同时列出两套工具", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tianshu-ceo-mcp-"));
    const seed = join(dir, "people.json");
    await writeFile(seed, JSON.stringify({ schemaVersion: "company-people.v1", people: [
      { personId: TEST_CEO.personId, displayName: "测试甲", roles: ["ceo", "dri"] },
      { personId: TEST_MEMBER.personId, displayName: "测试乙", roles: ["dri"] },
    ] }));
    let t: Awaited<ReturnType<typeof createTestApp>> | undefined;
    try {
      t = await createTestApp({ companyPeopleSeed: seed });
      const cookie = await t.loginCookie();
      const { token } = (await t.app.inject({ method: "POST", url: "/api/me/tokens", headers: { cookie, origin: t.publicOrigin },
        payload: { name: "双身份", client: "codex", expiresInDays: null } })).json();
      const tools = (await send(t.app, token, 1, "tools/list")).json().result.tools;
      expect(tools.map((tool: { name: string }) => tool.name)).toEqual([
        "list_my_items", "get_item", "append_progress", "update_status", "get_issue", "get_meeting", "company_progress", "get_mission_card", "edit_mission_card", "list_pending", "get_my_review", "save_review_draft",
      ]);
    } finally { await t?.close(); await rm(dir, { recursive: true, force: true }); }
  });
});
