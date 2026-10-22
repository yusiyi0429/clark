import { afterEach, describe, expect, it, vi } from "vitest";
import type { TestApp } from "./helpers.js";
import { CEO, confirm, HOST, OWNER, ready, setup } from "./meetingCardFixture.js";
import { projection, stubWorld } from "./worldFixture.js";

// 给独立 Chat 的宿主只读接口（10/22 与人豪定稿）：X-Viewer-Role 必填并按人员目录核对；待决议题、预约会议、首页卡片（工具清单 10/22 人豪定为不做）。
const TOKEN = "internal-chat-test";
const HOUR = 60 * 60 * 1000;
const NEW_ROUTES = ["/internal/pending-issues", "/internal/scheduled-meetings", "/internal/home-cards"];

const get = (t: TestApp, url: string, personId: string, role?: string) => t.app.inject({ method: "GET", url,
  headers: { authorization: `Bearer ${TOKEN}`, "x-owner-id": personId, ...(role ? { "x-viewer-role": role } : {}) } });

/** 假本体：挂点 PO，只读（整卡确认要读）。 */
function ontology() {
  const po = {
    object_id: "obj-po-1", object_type: "PeriodGoal", title: "十月交付", revision_id: "obj-po-1-r5", object_version: 5, version: 5,
    lifecycle: { status: "active" }, contract_version: "tkos.world/0.3", external_refs: [],
    blocks: [{ id: "target", components: [{ id: "acc-1", type: "acceptance_criterion", text: "十月底前 3 家客户上线" }] }],
  };
  stubWorld((call) => call.url.pathname === `/v1/world/objects/${po.object_id}` ? projection(po) : { items: [], next_cursor: null });
}

/** 把会挪到相对现在的时间。 */
const place = (t: TestApp, meetingId: string, startOffset: number, endOffset: number) =>
  t.sql("UPDATE meetings SET scheduled_at = $2, ends_at = $3, ended_at = NULL WHERE id = $1",
    [meetingId, new Date(Date.now() + startOffset), new Date(Date.now() + endOffset)]);

/** 复制一场还没交记录的预约会（同样的参会人和会议群），没有会议卡。 */
async function cloneScheduled(t: TestApp, meetingId: string, startOffset: number, endOffset: number): Promise<string> {
  const id = crypto.randomUUID();
  await t.sql("CREATE TEMP TABLE m_copy AS SELECT * FROM meetings WHERE id = $1", [meetingId]);
  await t.sql("UPDATE m_copy SET id = $1, status = 'scheduled', transcript = NULL", [id]);
  await t.sql("INSERT INTO meetings SELECT * FROM m_copy");
  await t.sql("DROP TABLE m_copy");
  await t.sql(`INSERT INTO thread_members (object_type, object_id, person_id, added_by)
    SELECT object_type, $2, person_id, added_by FROM thread_members WHERE object_type = 'meeting' AND object_id = $1`, [meetingId, id]);
  await place(t, id, startOffset, endOffset);
  return id;
}

afterEach(() => vi.unstubAllGlobals());

describe("给独立 Chat 的宿主只读接口", () => {
  it("视角必填并按人员目录核对：缺视角 400，用不了 403，不在目录 404；三个会议接口也一样", async () => {
    const { t, meetingId } = await setup(undefined, { internalChatToken: TOKEN });
    try {
      for (const url of [...NEW_ROUTES, "/internal/confirmed-meetings", `/internal/confirmed-meetings/${meetingId}`, `/internal/confirmed-meetings/${meetingId}/transcript`]) {
        expect((await t.app.inject({ method: "GET", url, headers: { "x-owner-id": CEO, "x-viewer-role": "ceo" } })).statusCode).toBe(401);
        for (const role of [undefined, "admin"]) {
          const missing = await get(t, url, CEO, role);
          expect([missing.statusCode, missing.json().code]).toEqual([400, "VIEW_REQUIRED"]);
        }
        // CEO 本人没有 DRI / 参与人角色，用不了成员视角；主持人不是 CEO。
        expect((await get(t, url, CEO, "member")).json().code).toBe("VIEW_NOT_ALLOWED");
        const denied = await get(t, url, HOST, "ceo");
        expect([denied.statusCode, denied.json().code]).toEqual([403, "VIEW_NOT_ALLOWED"]);
      }
      for (const url of NEW_ROUTES) {
        const unknown = await get(t, url, "person-nobody", "member");
        expect([unknown.statusCode, unknown.json().code]).toEqual([404, "OWNER_NOT_FOUND"]);
      }
      // 会议接口保持原来的错误码。
      expect((await get(t, "/internal/confirmed-meetings", "person-nobody", "member")).json().code).toBe("MEETING_NOT_FOUND");
    } finally {
      await t.close();
    }
  });

  it("待决议题：CEO 视角全部，成员视角只看本人在议题群里的", async () => {
    const { t } = await setup(undefined, { internalChatToken: TOKEN });
    try {
      const all = (await get(t, "/internal/pending-issues", CEO, "ceo")).json();
      expect(all.viewerRole).toBe("ceo");
      const mine = await t.createIssue({ title: "测试丙在群里的议题" });
      const mineId = mine.objectRef.id;
      await t.sql("INSERT INTO thread_members (object_type, object_id, person_id, added_by) VALUES ('issue', $1, $2, $3)", [mineId, OWNER, CEO]);

      const ceoView = (await get(t, "/internal/pending-issues", CEO, "ceo")).json();
      expect(ceoView.issues).toHaveLength(all.issues.length + 1);
      expect(ceoView.issues.find((issue: { issueId: string }) => issue.issueId === mineId)).toMatchObject({
        title: "测试丙在群里的议题", label: "待决", researchStatus: expect.any(String), location: { level: "battlefield", battlefieldId: "growth" },
        createdAt: expect.stringMatching(/Z$/), href: `/issues/${mineId}` });

      const ownerView = (await get(t, "/internal/pending-issues", OWNER, "member")).json();
      expect(ownerView).toMatchObject({ viewerRole: "member", issues: [{ issueId: mineId, href: `/me/issues/${mineId}` }] });
      expect(ownerView.issues).toHaveLength(1);
      // 离开议题群后就不列了。
      await t.sql("UPDATE thread_members SET left_at = now() WHERE object_type = 'issue' AND object_id = $1 AND person_id = $2", [mineId, OWNER]);
      expect((await get(t, "/internal/pending-issues", OWNER, "member")).json().issues).toEqual([]);
    } finally {
      await t.close();
    }
  });

  it("预约会议：本人在会里、没整卡确认的会，按阶段标；整卡确认后不再出现", async () => {
    ontology();
    const { t, host, meetingId } = await setup(undefined, { internalChatToken: TOKEN });
    try {
      // 原会：逐字稿已导入、会议卡还没确认 → 待确认。
      await place(t, meetingId, -24 * HOUR, -23 * HOUR);
      const upcoming = await cloneScheduled(t, meetingId, 24 * HOUR, 25 * HOUR);
      const inProgress = await cloneScheduled(t, meetingId, -0.5 * HOUR, 0.5 * HOUR);
      const awaitingRecord = await cloneScheduled(t, meetingId, -48 * HOUR, -47 * HOUR);
      const stages = (body: { meetings: { meetingId: string; stage: string }[] }) => Object.fromEntries(body.meetings.map((m) => [m.meetingId, m.stage]));

      const ceoView = (await get(t, "/internal/scheduled-meetings", CEO, "ceo")).json();
      expect(ceoView.viewerRole).toBe("ceo");
      expect(stages(ceoView)).toEqual({ [meetingId]: "awaiting_confirm", [upcoming]: "upcoming", [inProgress]: "in_progress", [awaitingRecord]: "awaiting_record" });
      expect(ceoView.meetings.find((m: { meetingId: string }) => m.meetingId === meetingId)).toMatchObject({
        title: "接口切换会", label: "预约", endedAt: null, host: { personId: HOST, name: expect.any(String) },
        participants: expect.arrayContaining([expect.objectContaining({ personId: OWNER })]), issueIds: [expect.any(String)], href: `/meetings/${meetingId}` });
      expect(ceoView.meetings.map((m: { startsAt: string }) => m.startsAt)).toEqual([...ceoView.meetings.map((m: { startsAt: string }) => m.startsAt)].sort());

      // 测试丙退出了「即将开」那场的会议群：成员视角不列，CEO 视角照列。
      await t.sql("UPDATE thread_members SET left_at = now() WHERE object_type = 'meeting' AND object_id = $1 AND person_id = $2", [upcoming, OWNER]);
      const ownerView = (await get(t, "/internal/scheduled-meetings", OWNER, "member")).json();
      expect(stages(ownerView)).toEqual({ [meetingId]: "awaiting_confirm", [inProgress]: "in_progress", [awaitingRecord]: "awaiting_record" });
      expect(ownerView.meetings[0].href).toMatch(/^\/me\/meetings\//);
      expect(stages((await get(t, "/internal/scheduled-meetings", CEO, "ceo")).json())).toHaveProperty(upcoming);

      // 时间窗：只看明后天；不合法或超过 90 天 → 400。
      const tomorrow = new URLSearchParams({ from: new Date(Date.now() + 12 * HOUR).toISOString(), to: new Date(Date.now() + 36 * HOUR).toISOString() });
      expect(stages((await get(t, `/internal/scheduled-meetings?${tomorrow}`, CEO, "ceo")).json())).toEqual({ [upcoming]: "upcoming" });
      for (const query of ["from=yesterday", "from=2026-01-01T00:00:00Z&to=2026-06-01T00:00:00Z", "from=2026-06-01T00:00:00Z&to=2026-05-01T00:00:00Z"]) {
        const bad = await get(t, `/internal/scheduled-meetings?${query}`, CEO, "ceo");
        expect([bad.statusCode, bad.json().code]).toEqual([400, "INVALID_INPUT"]);
      }

      // 整卡确认后走确认会议接口，这里不再出现。
      const draftVersion = await ready(t, host, meetingId);
      expect((await confirm(t, host, meetingId, { draftVersion, writeToWorld: false })).statusCode).toBe(200);
      expect(stages((await get(t, "/internal/scheduled-meetings", CEO, "ceo")).json())).not.toHaveProperty(meetingId);
    } finally {
      await t.close();
    }
  });

  it("首页卡片：CEO 是公司首页的 Card，成员是我的工作台；都不带 Action", async () => {
    const { t } = await setup(undefined, { internalChatToken: TOKEN });
    try {
      const ceo = await get(t, "/internal/home-cards", CEO, "ceo");
      expect(ceo.json()).toMatchObject({ viewerRole: "ceo", scene: "公司首页" });
      const ceoCards = ceo.json().cards as Record<string, unknown>[];
      expect(ceoCards.map((card) => card.kind)).toContain("issue");
      for (const card of [...ceoCards]) {
        expect(Object.keys(card).sort()).toEqual(["cardId", "kind", "label", "objectRef", "payload", "title", "version"]);
        expect(card.label).toBe("页面");
      }
      expect(ceo.body).not.toContain("actionId");

      const member = await get(t, "/internal/home-cards", HOST, "member");
      expect(member.json()).toMatchObject({ viewerRole: "member", scene: "我的工作台" });
      for (const card of member.json().cards as { kind: string }[]) expect(["task", "mission-card", "battlefield"]).toContain(card.kind);
      expect(member.body).not.toContain("actionId");
    } finally {
      await t.close();
    }
  });
});
