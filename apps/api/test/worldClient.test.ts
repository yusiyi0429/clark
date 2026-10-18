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
      expect(head).toMatchObject({ object_id: "<mission-1>", revision_id: "<revision-9>", object_version: 2, version: 2, lifecycle: { status: "draft" }, contract_version: "tkos.world/0.2" });
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

  // world-02 于 2026-10-15 原地升到 0.3；没切的信封在 prepare/commit 被拒且服务端不留记录。
  const upgradedWorld = (code: string, versions: { reads: number }) => stubWorld(({ url, body }) => {
    if (url.pathname.startsWith("/v1/world/objects/")) {
      const object = structuredClone(examples[1][2]);
      object.protocol.contract_version = ++versions.reads === 1 ? "tkos.world/0.2" : "tkos.world/0.3";
      return object;
    }
    if (body.contract_version !== "tkos.world/0.3") return Response.json({ error: { code, message: "protocol" } }, { status: 409 });
    return url.pathname.endsWith("/prepare") ? examples[2][1] : examples[2][3];
  });
  const buildFromHead = (client: WorldClient) => async () => {
    const head = await client.getHead("<mission-1>");
    return { ...examples[2][0], contract_version: head.contract_version, target: worldTarget(head) };
  };

  it.each(["PROTOCOL_WRITE_DISABLED", "PROTOCOL_BINDING_CONFLICT"])("scope 升级后 409 %s：按对象当前契约重建一次", async (code) => {
    await withWorld(async (client, { pool }) => {
      const versions = { reads: 0 };
      const calls = upgradedWorld(code, versions);
      expect(await client.write(examples[2][0].idempotency_key, buildFromHead(client))).toEqual(examples[2][3]);
      expect(versions.reads).toBe(2);
      expect(calls.filter((call) => call.method === "POST").map((call) => [call.url.pathname, call.body.contract_version])).toEqual([
        ["/v1/actions/prepare", "tkos.world/0.2"], ["/v1/actions/prepare", "tkos.world/0.3"], ["/v1/actions", "tkos.world/0.3"],
      ]);
      expect((await pool.query("SELECT status,error_code FROM world_sync_ledger ORDER BY id")).rows).toEqual([{ status: "failed", error_code: code }, { status: "committed", error_code: null }]);
    });
  });

  it("升级前 prepare 过、commit 回包丢失的旧信封：升级后重放被拒即按新契约重建", async () => {
    await withWorld(async (client, { pool }) => {
      const versions = { reads: 0 };
      let lost = true;
      stubWorld(({ url }) => {
        if (url.pathname.startsWith("/v1/world/objects/")) { versions.reads++; return examples[1][2]; }
        if (url.pathname.endsWith("/prepare")) return examples[2][1];
        if (lost) { lost = false; throw new Error("fetch failed"); }
        return examples[2][3];
      });
      await expect(client.write(examples[2][0].idempotency_key, buildFromHead(client))).rejects.toMatchObject({ code: "NETWORK_ERROR" });
      const calls = upgradedWorld("PROTOCOL_WRITE_DISABLED", versions);
      const restarted = new WorldClient(pool.query.bind(pool), worldEnv, instance);
      expect(await restarted.write(examples[2][0].idempotency_key, buildFromHead(restarted))).toEqual(examples[2][3]);
      expect(calls.filter((call) => call.method === "POST").map((call) => [call.url.pathname, call.body.contract_version])).toEqual([
        ["/v1/actions", "tkos.world/0.2"], ["/v1/actions/prepare", "tkos.world/0.3"], ["/v1/actions", "tkos.world/0.3"],
      ]);
      expect((await pool.query("SELECT status,error_code FROM world_sync_ledger ORDER BY id")).rows.map((row) => row.error_code)).toEqual(["NETWORK_ERROR", "PROTOCOL_WRITE_DISABLED", null]);
    });
  });

  it("上次以协议拒绝失败的请求不再原样重发，直接按当前对象重建", async () => {
    await withWorld(async (client, { pool }) => {
      stubWorld(() => Response.json({ error: { code: "PROTOCOL_WRITE_DISABLED", message: "protocol" } }, { status: 409 }));
      await expect(client.write(examples[2][0].idempotency_key, async () => examples[2][0])).rejects.toMatchObject({ code: "PROTOCOL_WRITE_DISABLED" });
      const calls = upgradedWorld("PROTOCOL_WRITE_DISABLED", { reads: 1 });
      expect(await client.write(examples[2][0].idempotency_key, buildFromHead(client))).toEqual(examples[2][3]);
      expect(calls.filter((call) => call.method === "POST").map((call) => call.body.contract_version)).toEqual(["tkos.world/0.3", "tkos.world/0.3"]);
      expect((await pool.query("SELECT status FROM world_sync_ledger ORDER BY id")).rows.at(-1)).toEqual({ status: "committed" });
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
