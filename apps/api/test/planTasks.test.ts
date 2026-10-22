import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorldPlanTaskSource } from "../src/planTasks.js";
import { WorldClient } from "../src/worldClient.js";
import { instance, stubWorld as stubFetch, worldEnv } from "./worldFixture.js";

/** 本体里的 Task 对象：父引用在 relations，短名是 title，结果和验收标准在 definition 块。 */
function taskObject(id: string, title: string, parent: unknown, components: { type: string; text: string }[]) {
  return { business: { object_id: id, object_type: "Task", title, domain_id: "<domain:eo>",
    relations: [{ field: "depends_on", relation: "depends_on", value: [] }, { field: "parent_ref", relation: "belongs_to", value: parent }],
    blocks: [{ id: "definition", value: { components: components.map((item, index) => ({ id: `c${index}`, ...item })) } },
      { id: "play", value: { components: [{ id: "p1", type: "acceptance_criterion", text: "别的块里的不算" }] } }] } };
}
const ref = (id: string) => ({ object_id: id, revision_id: "<revision>", object_version: 2, ref: `${id}@2` });

/** world 客户端桩：外部引用 mission:execution-one 对得上本体 <mission-1>（列表头带 domain_id）；记下列 Task 和取对象的调用。 */
function stubWorld(objects: Record<string, ReturnType<typeof taskObject>>) {
  const calls = { list: [] as Record<string, unknown>[], get: [] as string[] };
  const world = {
    listObjects: async (filters: Record<string, unknown>) => {
      if (filters.external_system) return filters.external_system === "tianshu" && filters.external_id === "mission:execution-one"
        ? [{ object_id: "<mission-1>", object_type: "Mission", domain_id: "<domain:eo>" }] : [];
      calls.list.push(filters);
      return Object.keys(objects).map((id) => ({ object_id: id, object_type: "Task" }));
    },
    getObject: async (id: string) => { calls.get.push(id); return objects[id]; },
  };
  return { world: world as unknown as Parameters<typeof createWorldPlanTaskSource>[0], calls };
}

describe("首页 Task 行的本体来源", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("只留父引用指向这个 Mission 的 Task；短名、结果、验收标准按本体字段取", async () => {
    const { world, calls } = stubWorld({
      "<task-a>": taskObject("<task-a>", "回流方案定稿", ref("<mission-1>"),
        [{ type: "acceptance_criterion", text: "纪要能读回" }, { type: "outcome", text: "会议结论写进本体" }, { type: "acceptance_criterion", text: "两人实测通过" }]),
      "<task-b>": taskObject("<task-b>", "别人的 Task", ref("<mission-2>"), [{ type: "outcome", text: "不该出现" }]),
      "<task-c>": taskObject("<task-c>", "还没写结果", [ref("<mission-1>")], [{ type: "acceptance_criterion", text: "只有一条标准" }]),
    });
    const tasks = await createWorldPlanTaskSource(world)([{ id: "execution-one", code: "execution-one" }]);
    expect(tasks).toEqual([
      { taskId: "<task-a>", missionId: "execution-one", name: "回流方案定稿", doneDefinition: "会议结论写进本体", criteria: ["纪要能读回", "两人实测通过"] },
      { taskId: "<task-c>", missionId: "execution-one", name: "还没写结果", doneDefinition: null, criteria: ["只有一条标准"] },
    ]);
    expect(calls.list).toEqual([{ type: "Task", domain_id: "<domain:eo>" }]);
    expect(calls.get.sort()).toEqual(["<task-a>", "<task-b>", "<task-c>"]);
  });

  it("Mission 在本体里找不到：这个 Mission 没有 Task，不报错、不列对象", async () => {
    const { world, calls } = stubWorld({ "<task-a>": taskObject("<task-a>", "回流方案定稿", ref("<mission-1>"), []) });
    expect(await createWorldPlanTaskSource(world)([{ id: "execution-two", code: "execution-two" }])).toEqual([]);
    expect(calls.list).toEqual([]);
  });

  it("真实客户端：按外部引用找 Mission、按它的域列 Task、跟着翻页，同时最多取 4 个对象", async () => {
    const ids = Array.from({ length: 7 }, (_, index) => `<task-${index}>`);
    let inFlight = 0, peak = 0;
    const calls = stubFetch(async ({ url }) => {
      if (url.pathname === "/v1/world/objects") {
        if (url.searchParams.get("external_system")) return { items: [{ object_id: "<mission-1>", object_type: "Mission", domain_id: "<domain:eo>" }], next_cursor: null };
        const page = url.searchParams.get("cursor") ? ids.slice(4) : ids.slice(0, 4);
        return { items: page.map((id) => ({ object_id: id, object_type: "Task" })), next_cursor: url.searchParams.get("cursor") ? null : "page-2" };
      }
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      const id = decodeURIComponent(url.pathname.split("/").at(-1)!);
      return taskObject(id, id, ref("<mission-1>"), []);
    });
    const client = new WorldClient(async () => ({ rows: [] }) as never, worldEnv, instance);
    const tasks = await createWorldPlanTaskSource(client)([{ id: "execution-one", code: "execution-one" }]);
    expect(tasks.map((task) => task.taskId)).toEqual(ids);
    expect(peak).toBe(4);
    const lists = calls.filter(({ url }) => url.pathname === "/v1/world/objects").map(({ url }) => Object.fromEntries(url.searchParams));
    expect(lists).toEqual([{ external_system: "tianshu", external_id: "mission:execution-one" },
      { type: "Task", domain_id: "<domain:eo>" }, { type: "Task", domain_id: "<domain:eo>", cursor: "page-2" }]);
    expect(calls.every(({ method }) => method === "GET")).toBe(true);
  });
});
