import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { MeetingTranscriptPage } from "@warmap/contracts";
import { createTestApp, preflightCandidate, TEST_CEO, TEST_MEMBER, type TestApp } from "./helpers.js";
import type { PreflightAgent } from "../src/meetingPreflight.js";

// 逐字稿按发言段分页读：只给 CEO 和实际参会的人，其他人和不存在的会一样 404。
const PEOPLE_SEED = fileURLToPath(new URL("./fixtures/company-people-candidate.json", import.meta.url));
const CEO = TEST_CEO.personId; // 测试甲
const MEMBER = TEST_MEMBER.personId; // 测试乙
const HOST = "person-fixture-003"; // 测试丙：主持人

const preflightAgent: PreflightAgent = { async generate(input) { return { candidate: preflightCandidate(input.issues.map((issue) => `issue:${issue.id}`)) }; } };

async function meetingWithTurns(t: TestApp, count: number): Promise<{ ceo: string; meetingId: string; turns: { id: string }[] }> {
  const ceo = await t.loginCookie();
  const issueCard = await t.createIssue();
  const create = (issueCard as unknown as { actions: { actionType: string; actionId: string }[] }).actions.find((a) => a.actionType === "issue.create_meeting")!;
  const created = await t.app.inject({ method: "POST", url: "/api/actions/execute", headers: { cookie: ceo, origin: t.publicOrigin }, payload: {
    actionId: create.actionId,
    input: { title: "渠道复盘会", scheduledAt: "2026-06-01T10:00:00.000+08:00", leadDriId: MEMBER, ceoParticipantId: CEO, participants: [HOST, MEMBER], issueIds: [issueCard.objectRef.id] },
  } });
  expect(created.statusCode, created.body).toBe(200);
  const meetingId = created.json().cards[0].objectRef.id as string;
  const turns = Array.from({ length: count }, (_, index) => ({
    id: `turn-${String(index + 1).padStart(3, "0")}`,
    speakerId: index % 2 ? HOST : CEO,
    startedAt: new Date(Date.parse("2026-06-01T02:00:00.000Z") + index * 10_000).toISOString(),
    text: `第 ${index + 1} 段`,
  }));
  // 种子里只有测试乙是 DRI：建会后把主持人换成测试丙，测试乙只是手填的参会人。
  await t.sql("UPDATE meetings SET status = 'held', lead_dri_id = $3, transcript = $2::jsonb WHERE id = $1",
    [meetingId, JSON.stringify({ schemaVersion: "warmap-transcript.v1", meetingId, importedAt: "2026-06-01T03:00:00.000Z", turns }), HOST]);
  return { ceo, meetingId, turns };
}

describe("逐字稿按发言段读", () => {
  it("参会人按页读逐字稿", async () => {
    const t = await createTestApp({ companyPeopleSeed: PEOPLE_SEED }, undefined, { preflightAgent });
    try {
      const { ceo, meetingId, turns } = await meetingWithTurns(t, 300);
      const member = await t.memberCookie();
      const first = await t.app.inject({ method: "GET", url: `/api/meetings/${meetingId}/transcript?limit=200`, headers: { cookie: member } });
      expect(first.statusCode).toBe(200);
      const page = first.json();
      expect(Value.Check(MeetingTranscriptPage, page)).toBe(true);
      expect(page.turns).toHaveLength(200);
      expect(page.nextTurn).toBe(turns[200].id);
      expect(page.total).toBe(300);
      expect(page.turns[0]).toEqual({ id: "turn-001", speakerName: "测试甲", startedAt: "2026-06-01T02:00:00.000Z", text: "第 1 段" });
      expect(page.turns[1].speakerName).toBe("测试丙");

      const rest = (await t.app.inject({ method: "GET", url: `/api/meetings/${meetingId}/transcript?from=${page.nextTurn}`, headers: { cookie: ceo } })).json();
      expect(rest.turns.map((turn: { id: string }) => turn.id)).toEqual(turns.slice(200).map((turn) => turn.id));
      expect(rest.nextTurn).toBeNull();
      // 不给 limit 时一页 200 段，最多 500 段。
      expect((await t.app.inject({ method: "GET", url: `/api/meetings/${meetingId}/transcript`, headers: { cookie: ceo } })).json().turns).toHaveLength(200);
      expect((await t.app.inject({ method: "GET", url: `/api/meetings/${meetingId}/transcript?limit=501`, headers: { cookie: ceo } })).statusCode).toBe(400);
    } finally {
      await t.close();
    }
  });

  it("不在场的人读不到逐字稿", async () => {
    const t = await createTestApp({ companyPeopleSeed: PEOPLE_SEED }, undefined, { preflightAgent });
    try {
      const { ceo, meetingId } = await meetingWithTurns(t, 3);
      // 飞书参会名单里只有主持人：手填的参会人测试乙不算在场。
      await t.sql("UPDATE meetings SET attendees_actual = $2::jsonb WHERE id = $1", [meetingId, JSON.stringify([HOST])]);
      const member = await t.memberCookie();
      const absent = await t.app.inject({ method: "GET", url: `/api/meetings/${meetingId}/transcript`, headers: { cookie: member } });
      const missing = await t.app.inject({ method: "GET", url: "/api/meetings/00000000-0000-4000-8000-000000000000/transcript", headers: { cookie: member } });
      expect(absent.statusCode).toBe(404);
      expect(missing.statusCode).toBe(404);
      // 除了每次请求各自的 requestId，两者一字不差。
      const body = (response: typeof absent) => ({ ...response.json(), requestId: undefined });
      expect(body(absent)).toEqual(body(missing));
      expect(absent.json().code).toBe("NOT_FOUND");
      expect(absent.body).not.toContain("渠道复盘会");
      // CEO 照样能读。
      expect((await t.app.inject({ method: "GET", url: `/api/meetings/${meetingId}/transcript`, headers: { cookie: ceo } })).json().total).toBe(3);
    } finally {
      await t.close();
    }
  });
});
