import { afterEach, describe, expect, it, vi } from "vitest";
import type { Query } from "../src/meetingStore.js";
import { createDecisionWorldSync, type DecisionEventInput } from "../src/worldDecisionEvents.js";
import { projection, stubWorld, withWorld } from "./worldFixture.js";

// 方案 A：一条会后决定记一条本体事件；受影响的 Task 在 Mission 执行计划里有组件时指到组件；改判记 correction。
const TASK = "11111111-2222-4333-8444-555555555555";
const MISSION = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const missionHead = {
  object_id: MISSION, object_type: "Mission", title: "Ontology & Data Grounding", revision_id: "rev-3", object_version: 3, version: 3,
  external_refs: [{ system: "tianshu", id: "mission:renhao-202610-b" }], lifecycle: { status: "active" }, contract_version: "tkos.world/0.3",
  blocks: [{ id: "task_overview", components: [{ id: `todo:${TASK}`, type: "plan_item" }] }],
};

function input(overrides: Partial<DecisionEventInput> = {}): DecisionEventInput {
  return {
    decision: { id: "d1d1d1d1-0000-4000-8000-000000000001", revision: 0, statement: "接口统一改成 v2，月底前切换", decidedBy: "agent", quote: "接口统一改成 v2", speaker: "测试乙" },
    meeting: { id: "m1m1m1m1-0000-4000-8000-000000000001", title: "接口切换会", scheduledAt: new Date("2026-10-12T10:00:00+08:00"), leadDriId: "person-fixture-002" },
    targets: [{ type: "task", id: TASK }],
    supersedesEventId: null, correctionNote: null, withdrawn: false,
    ...overrides,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("会后决定写本体（方案 A）", () => {
  it("一条决定一条事件：subject_refs 指到 Mission 执行计划里的组件，正文第一行写明谁拍的板；改判记 correction", async () => {
    await withWorld(async (client, db) => {
      const q: Query = async (sql, params) => sql.includes("FROM tasks t LEFT JOIN missions") ? { rows: [{ code: "renhao-202610-b" }] } as never : db.pool.query(sql, params);
      let events = 0;
      const calls = stubWorld((call) => {
        if (call.url.pathname === "/v1/world/objects") return { items: call.url.searchParams.get("external_id") === "mission:renhao-202610-b" ? [missionHead] : [], next_cursor: null };
        if (call.url.pathname === `/v1/world/objects/${MISSION}`) return projection(missionHead);
        if (call.url.pathname === "/v1/actions/prepare") return { expected_versions: [] };
        if (call.url.pathname === "/v1/actions") return { receipt_id: `r${++events}`, status: "committed", result: { event_id: `ev-${events}` } };
        throw new Error(`unexpected ${call.url.pathname}`);
      });
      const sync = createDecisionWorldSync({ q, client, publicOrigin: "https://tianshu.test/", now: () => new Date("2026-10-13T09:00:00+08:00") });
      expect(await sync.record(input())).toEqual({ status: "committed", eventId: "ev-1" });
      const first = calls.filter((call) => call.url.pathname === "/v1/actions").at(-1)!.body;
      expect(first).toMatchObject({
        action_type: "world_record_event", contract_version: "tkos.world/0.3", target: null,
        idempotency_key: "tianshu:meeting-decision:d1d1d1d1-0000-4000-8000-000000000001:0",
        params: {
          category: "meeting",
          subject_refs: [`${MISSION}@3#task_overview/todo:${TASK}`],
          occurred_at: "2026-10-12T10:00:00+08:00",
          content: { artifacts: ["https://tianshu.test/meetings/m1m1m1m1-0000-4000-8000-000000000001"] },
          declaration: { scene: `${MISSION}@3`, trigger: "天枢会后决定生效", human_acceptance: { required: false } },
        },
      });
      expect(first.params.content.text.split("\n")).toEqual([
        "Agent 代判，Host 尚未确认", "会上定了：接口统一改成 v2，月底前切换", "会议：接口切换会（2026-10-12 10:00）", "原话（测试乙）：「接口统一改成 v2」",
      ]);

      const corrected = await sync.record(input({ decision: { ...input().decision, revision: 1, decidedBy: "host", statement: "接口统一改成 v2，下月 15 日前切换" },
        supersedesEventId: "ev-1", correctionNote: "测试乙把「接口统一改成 v2，月底前切换」改为「接口统一改成 v2，下月 15 日前切换」" }));
      expect(corrected).toEqual({ status: "committed", eventId: "ev-2" });
      const second = calls.filter((call) => call.url.pathname === "/v1/actions").at(-1)!.body;
      expect(second.params).toMatchObject({ category: "correction", supersedes_event_id: "ev-1" });
      expect(second.params.content.text.split("\n").slice(0, 3)).toEqual(["Host 已确认", "会上定了：接口统一改成 v2，下月 15 日前切换",
        "更正：测试乙把「接口统一改成 v2，月底前切换」改为「接口统一改成 v2，下月 15 日前切换」"]);
      expect(second.idempotency_key).toBe("tianshu:meeting-decision:d1d1d1d1-0000-4000-8000-000000000001:1");
    });
  });

  it("受影响的对象一个都对不上、又不是 E&O 的会：不写（skipped）", async () => {
    await withWorld(async (client, db) => {
      const q: Query = (sql, params) => db.pool.query(sql, params);
      const calls = stubWorld((call) => {
        if (call.url.pathname === "/v1/world/objects") return { items: [], next_cursor: null };
        throw new Error(`unexpected ${call.url.pathname}`);
      });
      const sync = createDecisionWorldSync({ q, client, publicOrigin: "https://tianshu.test" });
      expect(await sync.record(input({ targets: [] }))).toEqual({ status: "skipped" });
      expect(calls.filter((call) => call.method === "POST")).toEqual([]);
    });
  });
});
