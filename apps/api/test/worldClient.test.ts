import { afterEach, describe, expect, it, vi } from "vitest";
import { WorldClient, worldConfigured, worldRef, worldTarget } from "../src/worldClient.js";
import { examples, instance, projection, stubWorld, withWorld, worldEnv } from "./worldFixture.js";

afterEach(() => vi.unstubAllGlobals());

describe("world 0.2 client / ledger", () => {
  it("按 §1 外部引用查回、从 business/records 取头，分页保留原游标及过滤器", async () => {
    await withWorld(async (client) => {
      const calls = stubWorld(({ url }) => {
        if (url.pathname.endsWith("/<mission-1>")) return examples[1][2];
        if (url.pathname.endsWith("/%3Cmission-1%3E")) return examples[1][2];
        if (url.searchParams.has("external_id")) return examples[2][4];
        return url.searchParams.has("cursor") ? examples[1][1] : { items: [], next_cursor: "opaque:+/=" };
      });
      const head = await client.byExternalRef("mission:demo-<run>");
      expect(head).toMatchObject({ object_id: "<mission-1>", revision_id: "<revision-9>", object_version: 2, version: 2, lifecycle: { status: "draft" } });
      const listed = await client.listObjects({ domain_id: "<domain:eo>", type: "Mission", limit: 5 });
      expect(listed).toEqual(examples[1][1].items);
      expect(calls.at(-1)!.url.searchParams.get("cursor")).toBe("opaque:+/=");
      expect(calls.at(-1)!.url.searchParams.get("domain_id")).toBe("<domain:eo>");
      expect(calls[0].url.searchParams.get("external_system")).toBe("tianshu");
      expect(calls[0].headers.get("authorization")).toBe("Bearer stub-world-token");
      const unit = { ...examples[1][0].items[0] };
      stubWorld(({ url }) => url.searchParams.has("external_id") ? examples[1][0] : projection(unit));
      const unitHead = await client.byExternalRef("capability:05");
      expect(worldRef(unitHead!)).toBe("<unit:eo>@2");
      expect(worldTarget(unitHead!).expected_version).toBe(3);
    });
  });

  it("§2 prepare/commit 原信封及 expected_versions 原样传递，同键重放旧请求", async () => {
    await withWorld(async (client, { pool }) => {
      const request = structuredClone(examples[2][0]);
      const versions = [{ object_id: "<period-goal-1>", object_version: 3, revision_id: "<revision-7>" }];
      const calls = stubWorld(({ url }) => url.pathname.endsWith("/prepare") ? { ...examples[2][1], expected_versions: versions } : examples[2][3]);
      const build = vi.fn(async () => request);
      expect(await client.write(request.idempotency_key, build)).toEqual(examples[2][3]);
      expect(calls[0].body).toEqual(request);
      expect(calls[1].body).toEqual({ ...request, expected_versions: versions });
      const restarted = new WorldClient(pool.query.bind(pool), worldEnv, instance);
      expect(await restarted.write(request.idempotency_key, build)).toEqual(examples[2][3]);
      expect(build).toHaveBeenCalledTimes(1);
      expect(calls[2].url.pathname).toBe("/v1/actions");
      expect(calls[2].body).toEqual(calls[1].body);
      const ledger = (await pool.query("SELECT * FROM world_sync_ledger ORDER BY id")).rows;
      expect(ledger).toHaveLength(2);
      expect(ledger.map((row) => row.status)).toEqual(["committed", "committed"]);
      expect(ledger[0]).toMatchObject({ instance: "https://world.test#<scope>", receipt_id: "<receipt-9>", error_code: null });
      expect(ledger[0].request_digest).toBe(ledger[1].request_digest);
      expect(JSON.stringify(ledger)).not.toContain(worldEnv.worldAgentToken);
    });
  });

  it.each(["VERSION_CONFLICT", "STALE_DEPENDENCY"])("409 %s 只重取一次再写", async (code) => {
    await withWorld(async (client, { pool }) => {
      let reads = 0;
      let writes = 0;
      const calls = stubWorld(({ url }) => {
        if (url.pathname.startsWith("/v1/world/objects/")) {
          reads++;
          const object = structuredClone(examples[1][2]);
          object.business.object_version = reads;
          object.business.version = reads;
          object.business.revision_id = `<revision-${reads}>`;
          return object;
        }
        if (url.pathname.endsWith("/prepare")) return examples[2][1];
        if (++writes === 1) return Response.json({ error: { code, message: "stale" } }, { status: 409 });
        return examples[2][3];
      });
      const key = examples[2][0].idempotency_key;
      await client.write(key, async () => {
        const head = await client.getHead("<mission-1>");
        return { ...examples[2][0], target: worldTarget(head) };
      });
      expect(reads).toBe(2);
      expect(calls.filter((call) => call.url.pathname === "/v1/actions").map((call) => call.body.target.expected_version)).toEqual([1, 2]);
      expect((await pool.query("SELECT status,error_code FROM world_sync_ledger ORDER BY id")).rows).toEqual([{ status: "failed", error_code: code }, { status: "committed", error_code: null }]);
    });
  });

  it("第二次冲突向调用方报错，不无限重试", async () => {
    await withWorld(async (client) => {
      const calls = stubWorld(() => Response.json({ error: { code: "VERSION_CONFLICT", message: "stale" } }, { status: 409 }));
      await expect(client.write(examples[2][0].idempotency_key, async () => examples[2][0])).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
      expect(calls).toHaveLength(2);
    });
  });

  it.each([[0, 422], [2, 403], [4, 403], [6, 403], [8, 409]])("§11 示例 %s 错误原样暴露且不重试", async (index, status) => {
    await withWorld(async (client, { pool }) => {
      const request = examples[11][index];
      const error = examples[11][index + 1].error;
      const calls = stubWorld(() => Response.json({ error }, { status }));
      await expect(client.write(request.idempotency_key, async () => request)).rejects.toMatchObject({ status, ...error });
      expect(calls).toHaveLength(1);
      expect(calls[0].body).toEqual(request);
      expect((await pool.query("SELECT status,error_code FROM world_sync_ledger")).rows).toEqual([{ status: "failed", error_code: error.code }]);
    });
  });

  it("IDEMPOTENCY_CONFLICT 不重试；缺配置禁用，幂等键长度校验", async () => {
    expect(worldConfigured({})).toBe(false);
    expect(worldConfigured({ worldApiUrl: worldEnv.worldApiUrl })).toBe(false);
    expect(worldConfigured({ worldAgentToken: worldEnv.worldAgentToken })).toBe(false);
    await withWorld(async (client) => {
      const calls = stubWorld(() => Response.json({ error: { code: "IDEMPOTENCY_CONFLICT", message: "different request" } }, { status: 409 }));
      await expect(client.write("short", async () => examples[2][0])).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      await expect(client.write("a".repeat(129), async () => examples[2][0])).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      await expect(client.write(examples[2][0].idempotency_key, async () => examples[2][0])).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
      expect(calls).toHaveLength(1);
    });
  });

  it("commit 网络失败后跨客户端仍保留键和信封；scope 改变后重新 prepare", async () => {
    await withWorld(async (client, { pool }) => {
      const request = structuredClone(examples[2][0]);
      request.params.on_behalf_of = examples[11][6].params.on_behalf_of;
      let fail = true;
      const calls = stubWorld(({ url }) => {
        if (url.pathname.endsWith("/prepare")) return examples[2][1];
        if (fail) { fail = false; throw new Error("fetch failed"); }
        return examples[2][3];
      });
      await expect(client.write(request.idempotency_key, async () => request)).rejects.toMatchObject({ code: "NETWORK_ERROR" });
      const replay = new WorldClient(pool.query.bind(pool), worldEnv, instance);
      await replay.write(request.idempotency_key, async () => { throw new Error("must use persisted body"); });
      expect(calls[2].body).toEqual(calls[1].body);
      expect(calls[2].body.params.on_behalf_of).toEqual(request.params.on_behalf_of);
      const rebuilt = new WorldClient(pool.query.bind(pool), worldEnv, { ...instance, scope_id: "new-scope" });
      await rebuilt.write(request.idempotency_key, async () => request);
      expect(calls[3].url.pathname).toBe("/v1/actions/prepare");
      expect((await pool.query("SELECT DISTINCT instance FROM world_sync_ledger")).rowCount).toBe(2);
    });
  });
});
