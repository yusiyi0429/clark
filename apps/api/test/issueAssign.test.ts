import { describe, expect, it } from "vitest";
import { createTestApp, TEST_CEO, TEST_MEMBER } from "./helpers.js";

/** 议题指派主责人（docs/superpowers/specs/2026-10-12-assign-and-mission-status.md）。 */
describe("issue.assign", () => {
  it("指派写主责与历史、拉进议题群并通知；重放不重复、旧版本冲突、不能指给自己；移出后不能指派", async () => {
    const t = await createTestApp();
    try {
      const issue = await t.createIssue();
      const id = issue.objectRef.id;
      const ceo = await t.loginCookie(), member = await t.memberCookie();
      const headers = { cookie: ceo, origin: t.publicOrigin };
      const get = (url: string, cookie = ceo) => t.app.inject({ method: "GET", url, headers: { cookie } });
      const card = async () => (await get(`/api/cards/issues/${id}`)).json().cards[0];
      const exec = (actionId: string, input: unknown, cookie = ceo) => t.app.inject({ method: "POST", url: "/api/actions/execute",
        headers: { cookie, origin: t.publicOrigin }, payload: { actionId, input } });
      const assignAction = (c: { actions: { actionType: string; actionId: string; label: string }[] }) => c.actions.find((a) => a.actionType === "issue.assign")!;

      const before = await card();
      expect(before.payload.assignee).toBeNull();
      expect(assignAction(before).label).toBe("指派");

      // 不能指给自己，也不能指给名单外的人。
      expect((await exec(assignAction(before).actionId, { personId: TEST_CEO.personId })).statusCode).toBe(400);
      expect((await exec(assignAction(before).actionId, { personId: "nobody" })).statusCode).toBe(400);
      // 成员不能指派。
      expect((await exec(assignAction(before).actionId, { personId: TEST_MEMBER.personId }, member)).statusCode).toBe(403);

      const first = await exec(assignAction(before).actionId, { personId: TEST_MEMBER.personId, note: "请牵头联络渠道方" });
      expect(first.statusCode, first.body).toBe(200);
      const assigned = first.json().cards[0];
      expect(assigned.version).toBe(before.version + 1);
      expect(assigned.payload.assignee).toMatchObject({ personId: TEST_MEMBER.personId, displayName: "测试乙", assignedBy: TEST_CEO.personId, note: "请牵头联络渠道方" });
      expect(assigned.payload.assignee).not.toHaveProperty("fingerprint");
      expect(assigned.payload.assignments).toHaveLength(1);
      expect(assignAction(assigned).label).toBe("改派");

      // 同一 actionId + 同一输入重放：不加版本、不再发通知。
      const replay = await exec(assignAction(before).actionId, { personId: TEST_MEMBER.personId, note: "请牵头联络渠道方" });
      expect(replay.statusCode).toBe(200);
      expect(replay.json().cards[0].version).toBe(assigned.version);
      // 旧版本的另一份输入：冲突并带最新卡。
      const stale = await exec(assignAction(before).actionId, { personId: TEST_MEMBER.personId, note: "换一句" });
      expect(stale.statusCode).toBe(409);
      expect(stale.json().latestCard.version).toBe(assigned.version);
      // 指派给当前主责且说明相同：无变化。
      const same = await exec(assignAction(assigned).actionId, { personId: TEST_MEMBER.personId, note: "请牵头联络渠道方" });
      expect(same.json().cards[0].version).toBe(assigned.version);

      const members = await t.sql("SELECT person_id FROM thread_members WHERE object_type='issue' AND object_id=$1 AND left_at IS NULL ORDER BY person_id", [id]);
      expect(members.map((row) => row.person_id)).toEqual([TEST_CEO.personId, TEST_MEMBER.personId].sort());
      const notices = (await get("/api/me/notifications", member)).json().notifications.filter((n: { kind: string }) => n.kind === "issue_assigned");
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatchObject({ objectType: "issue", objectId: id });
      expect(notices[0].text).toContain("请你主责议题");
      expect(notices[0].text).toContain("：请牵头联络渠道方");

      // 成员侧只读卡带主责。
      const mine = (await get(`/api/me/cards/issues/${id}`, member)).json();
      expect(mine.payload.assignee).toMatchObject({ personId: TEST_MEMBER.personId });

      // 移出后不暴露、服务端也拒绝。
      const dismiss = assigned.actions.find((a: { actionType: string }) => a.actionType === "issue.dismiss");
      expect((await exec(dismiss.actionId, { reason: "不再需要" })).statusCode).toBe(200);
      const dismissed = await card();
      expect(dismissed.actions.some((a: { actionType: string }) => a.actionType === "issue.assign")).toBe(false);
      const late = await exec(assignAction(assigned).actionId, { personId: TEST_MEMBER.personId, note: "再试" });
      expect(late.statusCode).toBe(409);
    } finally { await t.close(); }
  });
});
