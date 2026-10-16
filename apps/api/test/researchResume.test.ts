import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { migrate } from "../src/migrate.js";
import { createResearchService, resumeResearch, type ResearchRunner } from "../src/research.js";
import type { PreflightAgent, PreflightAgentInput } from "../src/meetingPreflight.js";
import { createTestDb, preflightCandidate, testEnv } from "./helpers.js";

const auth = { authorization: `Bearer ${testEnv.driServiceToken}` };
const issuePayload = (n: number) => ({ externalId: `resume-research-${n}`, submitterPersonId: "person-fixture-002", title: `补跑预研议题 ${n}`,
  whyNow: "窗口临近", sourceRef: `dri://planning/resume-research-${n}`, location: { level: "battlefield", battlefieldId: "growth" } });
const imported = JSON.stringify({ status: "failed", runId: null, previousRunIds: [], error: { code: "IMPORTED_WITHOUT_RESEARCH", message: "导入资料没有预研报告", at: "2026-05-01T00:00:00.000Z" } });

async function createIssues(pool: import("pg").Pool, count: number): Promise<string[]> {
  const setup = await buildApp({ pool, env: testEnv });
  try {
    const ids: string[] = [];
    for (let n = 1; n <= count; n += 1) {
      const res = await setup.inject({ method: "POST", url: "/api/dri/issues", headers: auth, payload: issuePayload(n) });
      ids.push(res.json().cards[0].objectRef.id as string);
    }
    return ids;
  } finally { await setup.close(); }
}

async function waitFor(check: () => Promise<boolean>, tries = 200): Promise<void> {
  for (let i = 0; i < tries; i += 1) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 20)); }
}

describe("场次启动后补跑议题预研", () => {
  it("只补还没有预研的议题，最多 3 个同时跑；已有预研、模型真跑失败的不动", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      const ids = await createIssues(pool, 6);
      for (const id of ids.slice(0, 4)) await db.query("UPDATE issues SET research = $2::jsonb WHERE id = $1", [id, imported]);
      await db.query("UPDATE issues SET research = $2::jsonb WHERE id = $1",
        [ids[4], JSON.stringify({ status: "ready", runId: "old", previousRunIds: [], error: null, doc: { summary: "已有预研" } })]);
      await db.query("UPDATE issues SET research = $2::jsonb WHERE id = $1",
        [ids[5], JSON.stringify({ status: "failed", runId: "old", previousRunIds: [], error: { code: "research_failed", message: "预研超时，请重试", at: "2026-05-01T00:00:00.000Z" } })]);

      let active = 0; let peak = 0; const seen: string[] = [];
      const runner: ResearchRunner = async (input) => {
        seen.push(input.issue.id); active += 1; peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 30));
        active -= 1;
        return {};
      };
      const service = createResearchService({ pool, runner });
      expect(await resumeResearch(pool.query.bind(pool), service, { concurrency: 3 })).toBe(4);
      await service.idle();
      expect([...seen].sort()).toEqual([...ids.slice(0, 4)].sort());
      expect(peak).toBeLessThanOrEqual(3);
      expect(peak).toBeGreaterThan(1);
      const rows = (await db.query("SELECT id, research FROM issues")).rows as { id: string; research: { status: string; runId: string | null; doc?: unknown } }[];
      const byId = new Map(rows.map((row) => [row.id, row.research]));
      expect(byId.get(ids[4])).toMatchObject({ status: "ready", runId: "old", doc: { summary: "已有预研" } });
      expect(byId.get(ids[5])).toMatchObject({ status: "failed", runId: "old" });
      for (const id of ids.slice(0, 4)) expect(byId.get(id)?.runId).not.toBeNull();
      // 再补一次不会重复跑：刚跑过的都是模型给的失败（不合法输出），不在「还没有预研」之列
      expect(await resumeResearch(pool.query.bind(pool), service)).toBe(0);
    });
  });

  it("启动后先补预研，会前预审等预研都跑完再补跑；默认不开（正式环境）", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      const ids = await createIssues(pool, 2);
      for (const id of ids) await db.query("UPDATE issues SET research = $2::jsonb WHERE id = $1", [id, imported]);
      const setup = await buildApp({ pool, env: testEnv, preflightAgent: { async generate(input: PreflightAgentInput) { return { candidate: preflightCandidate(input.issues.map((issue) => `issue:${issue.id}`)) }; } } });
      let meetingId: string;
      try {
        const created = await setup.inject({ method: "POST", url: "/api/dri/meetings", headers: auth, payload: { title: "补跑顺序会", scheduledAt: "2026-06-01T10:00:00.000+08:00",
          leadDriId: "person-fixture-002", ceoParticipantId: "person-fixture-001", participants: ["person-fixture-002"], externalId: "resume-order-meeting", issueIds: ids } });
        meetingId = created.json().cards[0].objectRef.id as string;
      } finally { await setup.close(); }
      await db.query("UPDATE meetings SET preflight = $2::jsonb WHERE id = $1", [meetingId,
        JSON.stringify({ status: "pending", pendingSince: "2026-05-02T01:00:00.000Z", runId: null, entries: [], basis: "", brief: "", error: null, generatedAt: null })]);

      const events: string[] = [];
      const runner: ResearchRunner = async (input) => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        events.push(`research:${input.issue.id}`);
        return {};
      };
      const preflightAgent: PreflightAgent = { background: true, async generate(input) {
        events.push("preflight");
        const candidate = preflightCandidate(input.issues.map((issue) => `issue:${issue.id}`));
        candidate.entries[0].sourceRefs.push(`meeting:${input.meeting.id}`);
        return { candidate };
      } };

      // 默认关：只补预审，不碰预研
      const plain = await buildApp({ pool, env: testEnv, researchService: createResearchService({ pool, runner }), preflightAgent: { ...preflightAgent } });
      try {
        await plain.ready();
        await waitFor(async () => events.includes("preflight"));
      } finally { await plain.close(); }
      expect(events).toEqual(["preflight"]);

      events.length = 0;
      await db.query("UPDATE meetings SET preflight = $2::jsonb WHERE id = $1", [meetingId,
        JSON.stringify({ status: "pending", pendingSince: "2026-05-02T01:00:00.000Z", runId: null, entries: [], basis: "", brief: "", error: null, generatedAt: null })]);
      const app = await buildApp({ pool, env: testEnv, researchService: createResearchService({ pool, runner }), preflightAgent, resumeResearchOnReady: true });
      try {
        await app.ready();
        await waitFor(async () => events.includes("preflight"));
        expect(events).toHaveLength(3);
        expect(events[2]).toBe("preflight");
        expect(events.slice(0, 2).sort()).toEqual(ids.map((id) => `research:${id}`).sort());
      } finally { await app.close(); }
    });
  });
});
