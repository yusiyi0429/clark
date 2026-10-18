import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorldMissionLookup, linkWorldMissions, WORLD_MISSION_LINKS } from "../src/worldMissions.js";
import { examples, instance, stubWorld, withWorld } from "./worldFixture.js";

afterEach(() => vi.unstubAllGlobals());

function missionStub(options: { wrongOwner?: boolean; duplicate?: boolean; occupied?: boolean; reject?: boolean; contractVersion?: string } = {}) {
  const objects = WORLD_MISSION_LINKS.map((link, i) => {
    const object = structuredClone(examples[1][2]);
    if (options.contractVersion) object.protocol.contract_version = options.contractVersion;
    Object.assign(object.business, { object_id: `<mission-${i + 1}>`, title: link.title });
    object.business.attributes = { responsible: options.wrongOwner ? "someone-else" : instance.people[link.owner], external_refs: [{ system: "other", id: `old-${i}` }] };
    return object;
  });
  const receipts = new Map<string, unknown>();
  const calls = stubWorld(({ url, body }) => {
    if (url.pathname === "/v1/world/objects") {
      if (url.searchParams.has("external_id")) {
        const id = url.searchParams.get("external_id");
        if (options.occupied) return { items: [{ object_id: "wrong-object" }], next_cursor: null };
        return { items: objects.filter((object) => object.business.attributes.external_refs.some((ref: any) => ref.system === "tianshu" && ref.id === id)).map((object) => object.business), next_cursor: null };
      }
      return { items: options.duplicate ? [...objects, objects[0]].map((object) => object.business) : objects.map((object) => object.business), next_cursor: null };
    }
    if (url.pathname.startsWith("/v1/world/objects/")) {
      if (url.pathname.endsWith("wrong-object")) return { ...objects[0], business: { ...objects[0].business, object_id: "wrong-object" } };
      return objects.find((object) => object.business.object_id === decodeURIComponent(url.pathname.split("/").at(-1)!));
    }
    if (url.pathname.endsWith("/prepare")) {
      if (options.reject) return Response.json(examples[11][9], { status: 409 });
      return examples[2][1];
    }
    if (!receipts.has(body.idempotency_key)) {
      const object = objects.find((entry) => entry.business.object_id === body.target.object_id)!;
      object.business.attributes.external_refs = body.params.payload.external_refs;
      object.business.version++;
      object.business.object_version++;
      receipts.set(body.idempotency_key, { ...examples[2][3], result: { ...examples[2][3].result, object_id: object.business.object_id } });
    }
    return receipts.get(body.idempotency_key);
  });
  return { calls, objects };
}

describe("Mission 外部引用", () => {
  it("三个标题+负责人逐一核对，§2 活动属性信封，写后查回；重跑同键同体无新效果", async () => {
    await withWorld(async (client) => {
      const { calls, objects } = missionStub();
      expect(await linkWorldMissions(client)).toHaveLength(3);
      const commits = calls.filter((call) => call.url.pathname === "/v1/actions");
      expect(commits).toHaveLength(3);
      expect(calls[0].url.searchParams.get("domain_id")).toBe("<domain:eo>");
      expect(calls[0].url.searchParams.get("type")).toBe("Mission");
      for (const [i, call] of commits.entries()) {
        expect(call.body).toMatchObject({
          action_type: examples[2][2].action_type, contract_version: examples[2][2].contract_version,
          target: { object_id: `<mission-${i + 1}>`, revision_id: "<revision-9>", expected_version: 2 },
          params: { payload: { external_refs: [{ system: "other", id: `old-${i}` }, { system: "tianshu", id: `mission:${WORLD_MISSION_LINKS[i].code}` }] },
            declaration: { scene: `<mission-${i + 1}>@2`, trigger: "天枢 Mission 关联本体", human_acceptance: { required: false } } },
        });
      }
      expect(await linkWorldMissions(client)).toHaveLength(3);
      expect(calls.filter((call) => call.url.pathname === "/v1/actions").slice(3).map((call) => call.body)).toEqual(commits.map((call) => call.body));
      expect(objects.map((object) => object.business.version)).toEqual([3, 3, 3]);
      const lookup = createWorldMissionLookup(client);
      await lookup("renhao-202610-b");
      const length = calls.length;
      expect((await lookup("renhao-202610-b"))?.title).toBe(WORLD_MISSION_LINKS[0].title);
      expect(calls).toHaveLength(length);
      await lookup("renhao-202610-b", true);
      expect(calls.length).toBeGreaterThan(length);
    });
  });
  it.each(["wrongOwner", "duplicate", "occupied"] as const)("%s 不猜测、不挪用引用、不写入", async (option) => {
    await withWorld(async (client) => {
      const { calls } = missionStub({ [option]: true });
      await expect(linkWorldMissions(client)).rejects.toMatchObject({ status: 409, code: "INVALID_STATE" });
      expect(calls.every((call) => call.method === "GET")).toBe(true);
    });
  });
  it("Mission 已绑定 0.3：修订信封声明对象当前契约", async () => {
    await withWorld(async (client) => {
      const { calls } = missionStub({ contractVersion: "tkos.world/0.3" });
      expect(await linkWorldMissions(client)).toHaveLength(3);
      expect(calls.filter((call) => call.method === "POST").map((call) => call.body.contract_version)).toEqual(Array(6).fill("tkos.world/0.3"));
    });
  });
  it("服务端引用占用 409 如实报错，不重试", async () => {
    await withWorld(async (client) => {
      const { calls } = missionStub({ reject: true });
      await expect(linkWorldMissions(client)).rejects.toMatchObject({ status: 409, ...examples[11][9].error });
      expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
    });
  });
});
