import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadWeeklyProgress, weekRange } from "../src/weeklyProgress.js";
import { call, executionFixture, newTask } from "./executionFixture.js";

const candidatePeople = fileURLToPath(new URL("./fixtures/company-people-candidate.json", import.meta.url));
const now = new Date("2026-10-10T02:00:00Z");

describe("本体每周进展拉取", () => {
  it("北京时间周一闭区间起点、跨年与默认周", () => {
    expect(weekRange(undefined, new Date("2026-10-04T15:59:59Z"))).toEqual({
      week: "2026-W40", from: "2026-09-28T00:00:00+08:00", to: "2026-10-05T00:00:00+08:00",
    });
    expect(weekRange(undefined, new Date("2026-10-04T16:00:00Z"))).toEqual({
      week: "2026-W41", from: "2026-10-05T00:00:00+08:00", to: "2026-10-12T00:00:00+08:00",
    });
    expect(weekRange("2027-W01", now).from).toBe("2027-01-04T00:00:00+08:00");
    expect(() => weekRange("2027-W53", now)).toThrow(RangeError);
    // 2026 年 1 月 1 日是周四，按 ISO 有第 53 周：12/28 到次年 1/4（不含）；那几天「默认本周」也是它。
    expect(weekRange("2026-W53", now)).toEqual({ week: "2026-W53", from: "2026-12-28T00:00:00+08:00", to: "2027-01-04T00:00:00+08:00" });
    expect(weekRange(undefined, new Date("2027-01-02T04:00:00Z")).week).toBe("2026-W53");
  });

  it("按作者与事项分组，读取当前任务状态和个人任务，并校验服务 token", async () => {
    const f = await executionFixture();
    const app = await buildApp({
      pool: f.t.pool, env: { ...f.t.env, companyPeopleSeed: candidatePeople, ontologyServiceToken: "ontology-test-token" },
      now: () => now,
      conversationRuntime: { async run(input) { return { assistantMessage: "", runtimeEntries: input.runtimeEntries }; } },
    });
    try {
      const missionTask = (await call(f, f.member, "POST", "/api/me/tasks", newTask())).json();
      const plainTask = (await call(f, f.member, "POST", "/api/me/tasks", newTask(null, { title: "独立事项" }))).json();
      const invited = await call(f, f.member, "POST", `/api/me/tasks/${missionTask.id}/collaborators`, { personIds: ["person-fixture-003"] });
      const dated = await call(f, f.member, "PATCH", `/api/me/tasks/${missionTask.id}`, { version: invited.json().version, dueDate: "2026-10-20" });
      expect((await call(f, f.member, "POST", `/api/me/tasks/${missionTask.id}/accept`,
        { version: dated.json().version, verdict: null, standards: [], deliverableMaterialIds: [] })).statusCode).toBe(200);
      const insert = async (taskId: string, authorId: string, at: string, body: string) => {
        const id = randomUUID();
        await f.t.sql(`INSERT INTO task_progress(id,task_id,author_id,source,body,links,created_at)
          VALUES($1,$2,$3,'codex',$4,$5,$6)`, [id, taskId, authorId, body, JSON.stringify([{ url: "https://example.com/evidence" }]), at]);
        return id;
      };
      await insert(missionTask.id, "person-fixture-002", "2026-10-04T15:59:59Z", "上周日");
      const monday = await insert(plainTask.id, "person-fixture-002", "2026-10-04T16:00:00Z", "周一零点");
      const collaborator = await insert(missionTask.id, "person-fixture-003", "2026-10-05T00:00:00Z", "协作进展");
      await insert(missionTask.id, "person-fixture-002", "2026-10-06T01:00:00Z", "任务进展");
      await insert(plainTask.id, "person-fixture-002", "2026-10-06T02:00:00Z", "后续进展");
      await insert(missionTask.id, "person-fixture-002", "2026-10-11T16:00:00Z", "下周一");
      const get = (url: string, token = "ontology-test-token") => app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });

      const disabled = await f.t.app.inject({ method: "GET", url: "/api/ontology/weekly-progress" });
      expect(disabled.statusCode).toBe(503);
      expect(disabled.json()).toMatchObject({ code: "ONTOLOGY_SYNC_DISABLED", message: "本体同步未配置" });
      expect((await get("/api/ontology/weekly-progress", "wrong")).statusCode).toBe(401);
      expect((await get("/api/ontology/weekly-progress?week=invalid")).statusCode).toBe(400);
      expect((await get("/api/ontology/weekly-progress?week=2027-W53")).statusCode).toBe(400);
      const response = await get("/api/ontology/weekly-progress");
      expect(response.statusCode).toBe(200);
      const report = response.json();
      expect(report).toMatchObject({ week: "2026-W41", from: "2026-10-05T00:00:00+08:00", to: "2026-10-12T00:00:00+08:00" });
      expect(report.generatedAt).toMatch(/\+08:00$/);
      expect(report.people.map((person: { displayName: string }) => person.displayName)).toEqual(["测试丙", "测试乙"]);
      const [collaboratorGroup, ownerGroup] = report.people;
      expect(collaboratorGroup).toMatchObject({ personId: "person-fixture-003", items: [{
        itemId: missionTask.id, role: "collaborator", entries: [{ id: collaborator, body: "协作进展" }],
      }] });
      expect(ownerGroup.items.map((item: { itemId: string }) => item.itemId)).toEqual([plainTask.id, missionTask.id]);
      expect(ownerGroup.items[0]).toMatchObject({ role: "owner", mission: null, entries: [{ id: monday }, { body: "后续进展" }] });
      expect(ownerGroup.items[1]).toMatchObject({ role: "owner", status: "done", dueDate: "2026-10-20",
        mission: { missionId: "execution-one", title: "上线", step: 1, steps: 1 }, entries: [{ body: "任务进展" }] });
      expect(JSON.stringify(report)).not.toContain("上周日");
      expect(JSON.stringify(report)).not.toContain("下周一");
      expect((await get("/api/ontology/weekly-progress?week=2026-W40")).json().people[0].items[0].entries[0].body).toBe("上周日");
      const withoutName = await loadWeeklyProgress(f.t.pool.query.bind(f.t.pool), weekRange("2026-W41", now), new Map());
      expect(withoutName.people.find((person) => person.personId === "person-fixture-003")?.displayName).toBe("person-fixture-003");
    } finally { await app.close(); await f.t.close(); }
  });
});
