import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { carryBlocks, createWeeklyReviewWorldSync } from "../src/weeklyReviewWorld.js";
import { projection, stubWorld, withWorld } from "./worldFixture.js";

afterEach(() => vi.unstubAllGlobals());

const PERSON = "liu-renhao";
const missionHead = { object_id: "11111111-1111-4111-8111-111111111111", object_type: "Mission", title: "Ontology & Data Grounding", revision_id: "rev-m",
  object_version: 4, version: 4, external_refs: [{ system: "tianshu", id: "mission:renhao-202610-b" }], lifecycle: { status: "draft" }, contract_version: "tkos.world/0.3" };
/** 0.3 实测的读回形状（world-02，10/18 用 world_get_state 读的）：块是列表，refs 是对象，条目 url 可以是 null。 */
const previousSnapshot = {
  object_id: "snap-1", as_of: "2026-10-15T14:10:00Z", period: "2026-10", payload_type: { id: "execution_state", display_name: "执行状态" },
  blocks: [
    { id: "current_state", value: { refs: [], text: "资料包第一批已发布", artifacts: [], components: [] } },
    { id: "progress", value: { refs: [], text: "", artifacts: [], components: [
      { id: "daily:41b0a17f", refs: [], text: "10/15：升 0.3", type: "progress_item", scope: null, artifacts: [],
        attributes: { entries: [{ at: "2026-10-15T02:25:00Z", url: null, text: "升级", source: "claude" }], principal_id: "p-siyi", principal_name: "于斯一", external_status: "进行中" },
        ref: "snap-1@1#progress/daily:41b0a17f" },
      { id: `weekly:${PERSON}`, refs: [], text: "上周的周复盘条目", type: "progress_item", scope: null, artifacts: [], attributes: {}, ref: "x" }] } },
    { id: "milestones", value: null },
    { id: "materials", value: { refs: [{ object_id: "o1", ref: "o1@3" }], text: "资料包", artifacts: ["https://tokenking.feishu.cn/wiki/a"], components: [] } },
  ],
};

describe("周复盘提交后写本体", () => {
  it("新快照带上上一条的全部块，读回形状换回写入形状，只换本人的周复盘条目", () => {
    const blocks = carryBlocks(previousSnapshot, { id: `weekly:${PERSON}`, type: "progress_item", text: "这周" }) as any;
    expect(blocks.current_state).toEqual({ text: "资料包第一批已发布" });
    expect(blocks.milestones).toBeUndefined();
    expect(blocks.materials).toEqual({ text: "资料包", refs: ["o1@3"], artifacts: ["https://tokenking.feishu.cn/wiki/a"] });
    expect(blocks.progress.components).toEqual([
      { id: "daily:41b0a17f", type: "progress_item", text: "10/15：升 0.3",
        attributes: { entries: [{ at: "2026-10-15T02:25:00Z", text: "升级", source: "claude" }], principal_id: "p-siyi", principal_name: "于斯一", external_status: "进行中" } },
      { id: `weekly:${PERSON}`, type: "progress_item", text: "这周" }]);
    expect(carryBlocks({ ...previousSnapshot, payload_type: "goal_state" }, { id: "w" })).toEqual({ progress: { components: [{ id: "w" }] } });
  });

  it("按「关键进展」引用到的 Task、Mission 各记一条外部事件再写快照；本体里没有的 Task 记 skipped；契约按对象当前的 0.3", async () => {
    await withWorld(async (client, { pool }) => {
      const q = pool.query.bind(pool);
      const task = randomUUID(), progress = randomUUID(), review = randomUUID();
      await q(`INSERT INTO missions(id,version,code,period,title,owner_id,capability_id,battlefield_ids,outcome,source_ref,source_document_id,source_revision,source_title)
        VALUES('m-renhao',1,'renhao-202610-b','2026-10','Ontology','${PERSON}','method','[]','目标','t','t',1,'t')`);
      await q("INSERT INTO tasks(id,title,status,owner_id,created_by,mission_id,step_order) VALUES($1,'接 0.3','in_progress',$2,$2,'m-renhao',1)", [task, PERSON]);
      await q(`INSERT INTO task_progress(id,task_id,author_id,source,body,links,created_at) VALUES($1,$2,$3,'web','写完','[{"url":"https://github.com/x/pull/7"}]',now())`, [progress, task, PERSON]);
      const body = { overall: { text: "状态：绿｜在轨[Mission](cite:mission:m-renhao)。", sources: [] },
        progress: { text: `- 0.3 写入接好了[10/16 进展 · 接 0.3](cite:progress:${progress})。\n- 没有出处的这行不同步`, sources: [] },
        issues: { text: "无", sources: [] }, implications: { text: "无", sources: [] }, actions: { text: "无", sources: [] } };
      await q(`INSERT INTO weekly_reviews(id,person_id,week_start,status,body,submitted_at,world_sync_status,created_at,updated_at)
        VALUES($1,$2,'2026-10-12','submitted',$3::jsonb,'2026-10-16T08:00:00Z','pending',now(),now())`, [review, PERSON, JSON.stringify(body)]);
      const actions: any[] = [];
      const calls = stubWorld(({ url, method, body: sent }) => {
        if (url.pathname === "/v1/world/objects" && url.searchParams.get("external_id") === `todo:${task}`) return { items: [], next_cursor: null };
        if (url.pathname === "/v1/world/objects") return { items: [missionHead], next_cursor: null };
        if (url.pathname.endsWith("/state")) return { object_id: missionHead.object_id, snapshot: previousSnapshot };
        if (url.pathname.startsWith("/v1/world/objects/")) return projection(missionHead);
        if (url.pathname === "/v1/actions/prepare") return { expected_versions: [] };
        if (url.pathname === "/v1/actions" && method === "POST") {
          actions.push(sent);
          return { receipt_id: `r${actions.length}`, status: "committed", result: sent.action_type === "world_record_event" ? { event_id: "ev-1" } : { ref: "snap-2@1", event_id: "ev-2" } };
        }
        throw new Error(`unexpected ${method} ${url}`);
      });
      const sync = createWeeklyReviewWorldSync({ pool, client, publicOrigin: "https://tianshu.test", names: () => new Map([[PERSON, "刘人豪"]]),
        now: () => new Date("2026-10-16T08:30:00Z") });
      sync.schedule(review);
      await sync.close();
      expect(calls.every((call) => call.headers.get("authorization") === "Bearer stub-world-token")).toBe(true);
      expect(actions.map((action) => [action.action_type, action.contract_version, action.idempotency_key])).toEqual([
        ["world_record_event", "tkos.world/0.3", `tianshu:weekly-review:${review}:event:${missionHead.object_id}`],
        ["world_refresh_state", "tkos.world/0.3", `tianshu:weekly-review:${review}:state:${missionHead.object_id}`]]);
      expect(actions[0].params).toMatchObject({ category: "other", subject_refs: [`${missionHead.object_id}@4`], occurred_at: "2026-10-16T16:29:00+08:00",
        content: { text: "【周复盘】刘人豪 10/12–10/18\n- 0.3 写入接好了。", artifacts: ["https://github.com/x/pull/7", `https://tianshu.test/me/weekly-reviews/${review}`] } });
      const payload = actions[1].params.payload;
      expect(payload).toMatchObject({ subject_ref: `${missionHead.object_id}@4`, as_of: "2026-10-16T16:29:00+08:00", period: "2026-10",
        payload_type: "execution_state", source_event_refs: ["event:ev-1"], title: "Ontology & Data Grounding · 刘人豪 10/12–10/18 周复盘" });
      expect(payload.blocks.progress.components.map((item: any) => item.id)).toEqual(["daily:41b0a17f", `weekly:${PERSON}`]);
      expect(payload.blocks.progress.components[1]).toEqual({ id: `weekly:${PERSON}`, type: "progress_item", text: "刘人豪 10/12–10/18 周复盘：0.3 写入接好了。",
        artifacts: ["https://github.com/x/pull/7", `https://tianshu.test/me/weekly-reviews/${review}`],
        attributes: { principal_id: "<principal:eo-owner>", principal_name: "刘人豪", external_status: "进行中",
          entries: [{ at: "2026-10-16T16:00:00+08:00", source: "web", text: "0.3 写入接好了。" }] } });
      expect(JSON.stringify(actions)).not.toContain("没有出处的这行不同步");
      const row = (await q("SELECT world_sync_status, world_sync FROM weekly_reviews WHERE id=$1", [review])).rows[0];
      expect(row).toEqual({ world_sync_status: "done", world_sync: [
        { target: `task:${task}`, status: "skipped", code: "NOT_IN_WORLD" },
        { target: "mission:renhao-202610-b", status: "committed", eventId: "ev-1", snapshotRef: "snap-2@1" }] });
    });
  });
});
