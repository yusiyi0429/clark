import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorldPlanTaskSource, readPlanTaskById, readPlanTasks } from "../src/planTasks.js";
import { WorldClient, WorldError } from "../src/worldClient.js";
import { instance, stubWorld as stubFetch, worldEnv } from "./worldFixture.js";

/** 本体里的 Task 对象：父引用在 relations，短名是 title，结果和验收标准在 definition 块。 */
function taskObject(id: string, title: string, parent: unknown, components: { type: string; text: string }[]) {
  return { business: { object_id: id, object_type: "Task", title, domain_id: "<domain:eo>",
    relations: [{ field: "depends_on", relation: "depends_on", value: [] }, { field: "parent_ref", relation: "belongs_to", value: parent }],
    blocks: [{ id: "definition", value: { components: components.map((item, index) => ({ id: `c${index}`, ...item })) } },
      { id: "play", value: { components: [{ id: "p1", type: "acceptance_criterion", text: "别的块里的不算" }] } }] } };
}
const ref = (id: string) => ({ object_id: id, revision_id: "<revision>", object_version: 2, ref: `${id}@2` });

/**
 * world 客户端桩：外部引用 mission:execution-one 对得上本体 <mission-1>（列表头带 domain_id）；记下列 Task 和取对象的调用。
 * 对象给成 Error 时取它就失败；listFails 时列 Task 失败。
 */
function stubWorld(objects: Record<string, unknown>, options: { listFails?: boolean } = {}) {
  const calls = { list: [] as Record<string, unknown>[], get: [] as string[] };
  const world = {
    listObjects: async (filters: Record<string, unknown>) => {
      if (filters.external_system) return filters.external_system === "tianshu" && filters.external_id === "mission:execution-one"
        ? [{ object_id: "<mission-1>", object_type: "Mission", domain_id: "<domain:eo>" }] : [];
      calls.list.push(filters);
      if (options.listFails) throw new Error("列表读失败");
      return Object.keys(objects).map((id) => ({ object_id: id, object_type: "Task" }));
    },
    getObject: async (id: string) => {
      calls.get.push(id);
      if (objects[id] instanceof Error) throw objects[id];
      return objects[id];
    },
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

  it("从本体载入的 Mission：按记下的对象 id 和域、用它所在 scope 的读身份找 Task，不查外部引用；没有这个 scope 的读身份就没有 Task", async () => {
    const main = stubWorld({});
    const tk = stubWorld({ "<task-a>": taskObject("<task-a>", "会议内容写进本体", ref("<mission-tk>"), [{ type: "outcome", text: "写进本体" }]) });
    const loaded = { id: "w-mission", code: "w-mission", world: { scopeId: "scope-tk", objectId: "<mission-tk>", domainId: "<domain:agents>" } };
    const source = createWorldPlanTaskSource(main.world, { scopes: new Map([["scope-tk", tk.world]]) });
    expect(await source([loaded])).toEqual([{ taskId: "<task-a>", missionId: "w-mission", name: "会议内容写进本体", doneDefinition: "写进本体", criteria: [] }]);
    expect(tk.calls.list).toEqual([{ type: "Task", domain_id: "<domain:agents>" }]);
    expect(main.calls.list).toEqual([]);
    expect(await createWorldPlanTaskSource(main.world)([{ ...loaded, id: "other" }])).toEqual([]);
  });

  it("约定（12 月起本体字段，这里是假数据）：标准组件上的 proof、acceptor 和块上的 exclusions 带进 agreement；认可人换成天枢的人，对不上为 null；没有这几项不带", async () => {
    const withAgreement = (id: string, components: Record<string, unknown>[], exclusions?: unknown) => {
      const object = taskObject(id, id, ref("<mission-1>"), []);
      object.business.blocks[0] = { id: "definition", value: { components: components.map((item, index) => ({ id: `c${index}`, ...item })),
        ...(exclusions === undefined ? {} : { exclusions }) } } as never;
      return object;
    };
    const { world } = stubWorld({
      "<task-a>": withAgreement("<task-a>", [
        { type: "acceptance_criterion", text: "纪要能读回", proof: " 读回截图 ", acceptor: "<principal:siyi>" },
        { type: "acceptance_criterion", text: "两人实测通过", acceptor: { principal_id: "<principal:stranger>" } },
        { type: "exclusion", text: "不含飞书推送" },
      ], ["不含 M2"]),
      "<task-b>": withAgreement("<task-b>", [{ type: "outcome", text: "方案定稿", proof: "评审会纪要" }]),
      "<task-c>": withAgreement("<task-c>", [{ type: "acceptance_criterion", text: "只有标准" }]),
    });
    const personOf = (principal: string) => principal === "<principal:siyi>" ? "siyi" : null;
    const tasks = await createWorldPlanTaskSource(world, { personOf })([{ id: "execution-one", code: "execution-one" }]);
    expect(tasks.find((task) => task.taskId === "<task-a>")?.agreement).toEqual({ proofs: ["读回截图", null], acceptorIds: ["siyi", null], exclusions: ["不含 M2", "不含飞书推送"] });
    // 没有验收标准时，完成定义那一条上的 proof 就是这一条的约定。
    expect(tasks.find((task) => task.taskId === "<task-b>")).toMatchObject({ criteria: [], doneDefinition: "方案定稿", agreement: { proofs: ["评审会纪要"], acceptorIds: [null], exclusions: [] } });
    expect(tasks.find((task) => task.taskId === "<task-c>")).not.toHaveProperty("agreement");
  });

  it("Mission 在本体里找不到：这个 Mission 没有 Task，不报错、不列对象", async () => {
    const { world, calls } = stubWorld({ "<task-a>": taskObject("<task-a>", "回流方案定稿", ref("<mission-1>"), []) });
    expect(await createWorldPlanTaskSource(world)([{ id: "execution-two", code: "execution-two" }])).toEqual([]);
    expect(calls.list).toEqual([]);
  });

  it("形状和文字：组件挂在块上（value.components 为空）也认、内部代号换成公司名；没有父引用的跳过并记日志；单个对象取不到只跳过它", async () => {
    const logs = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const { world } = stubWorld({
        "<task-a>": { business: { object_id: "<task-a>", object_type: "Task", title: "TK 试点", relations: [{ field: "parent_ref", relation: "belongs_to", value: ref("<mission-1>") }],
          blocks: [{ id: "definition", value: { components: [] }, components: [{ type: "outcome", text: "给 TK 交付" }, { type: "acceptance_criterion", text: "FDD 确认" }] }] } },
        "<task-b>": new Error("取不到"),
        "<task-c>": { business: { object_id: "<task-c>", object_type: "Task", title: "没有父引用", relations: [{ field: "depends_on", relation: "depends_on", value: [] }], blocks: [] } },
        "<task-d>": taskObject("<task-d>", "照常列出", ref("<mission-1>"), []),
      });
      expect(await createWorldPlanTaskSource(world)([{ id: "execution-one", code: "execution-one" }])).toEqual([
        { taskId: "<task-a>", missionId: "execution-one", name: "词元云集 试点", doneDefinition: "给 词元云集 交付", criteria: ["房懂懂 确认"] },
        { taskId: "<task-d>", missionId: "execution-one", name: "照常列出", doneDefinition: null, criteria: [] },
      ]);
      const lines = logs.mock.calls.map(([line]) => String(line));
      expect(lines.some((line) => line.includes("plan_tasks.object") && line.includes("world:<task-b>") && line.includes("\"failed\""))).toBe(true);
      expect(lines.some((line) => line.includes("world:<task-c>") && line.includes("TASK_PARENT_MISSING"))).toBe(true);
    } finally { logs.mockRestore(); }
  });

  it("负责人：identity.responsible 第一个主体优先，没有再看 attributes.responsible；按 personOf 换成天枢的人，对不上为 null，没登记不带", async () => {
    const withResponsible = (id: string, extra: Record<string, unknown>, attributes: Record<string, unknown> = {}) => {
      const object = taskObject(id, id, ref("<mission-1>"), []) as { business: Record<string, unknown> } & Record<string, unknown>;
      return { ...object, ...extra, business: { ...object.business, attributes } };
    };
    const { world } = stubWorld({
      "<task-a>": withResponsible("<task-a>", { identity: { responsible: { principals: [{ principal_id: "principal-sun" }, { principal_id: "principal-li" }] } } }, { responsible: "principal-li" }),
      "<task-b>": withResponsible("<task-b>", {}, { responsible: "principal-li" }),
      "<task-c>": withResponsible("<task-c>", { identity: { responsible: { principals: [{ principal_id: "principal-unknown" }] } } }),
      "<task-d>": withResponsible("<task-d>", {}),
    });
    const people = new Map([["principal-sun", "sun-mingze"], ["principal-li", "li-si"]]);
    const tasks = await createWorldPlanTaskSource(world, { personOf: (principal) => people.get(principal) ?? null })([{ id: "execution-one", code: "execution-one" }]);
    expect(tasks.map((task) => [task.taskId, task.responsibleId])).toEqual([["<task-a>", "sun-mingze"], ["<task-b>", "li-si"], ["<task-c>", null], ["<task-d>", undefined]]);
  });

  it("列 Task 失败：整次作废，不再去取对象", async () => {
    const { world, calls } = stubWorld({ "<task-a>": taskObject("<task-a>", "回流方案定稿", ref("<mission-1>"), []) }, { listFails: true });
    await expect(createWorldPlanTaskSource(world)([{ id: "execution-one", code: "execution-one" }])).rejects.toThrow("列表读失败");
    expect(calls.get).toEqual([]);
  });

  it("按 Mission 组合记 60 秒：期内不再读本体；过期先给旧的、后台重读，读完下一次给新的；读失败沿用旧的", async () => {
    let now = 0;
    const objects: Record<string, unknown> = { "<task-a>": taskObject("<task-a>", "旧名字", ref("<mission-1>"), []) };
    const options = { listFails: false };
    const { world, calls } = stubWorld(objects, options);
    const source = createWorldPlanTaskSource(world, { clock: () => now });
    const missions = [{ id: "execution-one", code: "execution-one" }];
    const names = async () => (await source(missions)).map((task) => task.name);
    expect(await names()).toEqual(["旧名字"]);
    now = 59_000;
    expect(await names()).toEqual(["旧名字"]);
    expect(calls.list).toHaveLength(1);
    // 另一组 Mission 单独记。
    expect(await source([{ id: "execution-two", code: "execution-two" }])).toEqual([]);
    objects["<task-a>"] = taskObject("<task-a>", "新名字", ref("<mission-1>"), []);
    now = 60_000;
    expect(await names()).toEqual(["旧名字"]);
    await vi.waitFor(() => expect(calls.list).toHaveLength(2));
    await vi.waitFor(async () => expect(await names()).toEqual(["新名字"]));
    options.listFails = true;
    const logs = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      now = 200_000;
      expect(await names()).toEqual(["新名字"]);
      const failures = () => logs.mock.calls.filter(([line]) => String(line).includes("background_refresh")).length;
      await vi.waitFor(() => expect(failures()).toBe(1));
      expect(await names()).toEqual(["新名字"]);
      await vi.waitFor(() => expect(failures()).toBe(2));
    } finally { logs.mockRestore(); }
  });

  it("限时读：来源一直不回就按时给空的；来源出错也给空的", async () => {
    const logs = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const started = Date.now();
      expect(await readPlanTasks(() => new Promise(() => undefined), [{ id: "m", code: "m" }], 50)).toEqual([]);
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(await readPlanTasks(async () => { throw new Error("本体读不到"); }, [{ id: "m", code: "m" }])).toEqual([]);
      expect(logs.mock.calls.map(([line]) => String(line)).filter((line) => line.includes("plan_tasks.read"))).toHaveLength(2);
    } finally { logs.mockRestore(); }
  });

  it("按 id 读一件 Task（跨月找 Task）：主实例没有就换各 scope 的读身份，带父引用；不是 Task 当没有；按 id 记 60 秒；限时、出错都给 null", async () => {
    let now = 0;
    const main = stubWorld({ "<task-tk>": new WorldError(404, "NOT_FOUND", "没有"), "<mission-x>": { business: { object_id: "<mission-x>", object_type: "Mission",
      title: "一个 Mission", relations: [], blocks: [] } }, "<broken>": new Error("网络断了") });
    const tk = stubWorld({ "<task-tk>": taskObject("<task-tk>", "十月的 Task", ref("<mission-tk>"), [{ type: "outcome", text: "写进本体" }]) });
    const source = createWorldPlanTaskSource(main.world, { scopes: new Map([["scope-tk", tk.world]]), clock: () => now });
    const found = { parents: ["<mission-tk>"], task: { taskId: "<task-tk>", name: "十月的 Task", doneDefinition: "写进本体", criteria: [] } };
    expect(await readPlanTaskById(source, "<task-tk>")).toEqual(found);
    now = 59_000;
    expect(await readPlanTaskById(source, "<task-tk>")).toEqual(found);
    expect([main.calls.get, tk.calls.get]).toEqual([["<task-tk>"], ["<task-tk>"]]);
    expect(await readPlanTaskById(source, "<mission-x>")).toBeNull();
    const logs = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      expect(await readPlanTaskById(source, "<broken>")).toBeNull();
      const started = Date.now();
      expect(await readPlanTaskById(Object.assign(async () => [], { byId: () => new Promise<never>(() => undefined) }), "<slow>", 50)).toBeNull();
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(logs.mock.calls.map(([line]) => String(line)).filter((line) => line.includes("plan_tasks.read_one"))).toHaveLength(2);
    } finally { logs.mockRestore(); }
    // 只会按 Mission 列的来源（测试的假来源）：没有这一步。
    expect(await readPlanTaskById(async () => [], "<task-tk>")).toBeNull();
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
