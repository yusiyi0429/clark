import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NEXUS_DRI_REQUESTS_PATH, NEXUS_DRI_CONFIRMATIONS_PATH, nexusDriIdempotencyKey, type TNexusDriRequest } from "@warmap/contracts";
import { callbackSignature, createNexusDri, fingerprintOf, NEXUS_DRI_CALLBACK_KIND, requestFingerprint, resolveNexusDriEnv } from "../src/nexusDri.js";
import { createTestApp, TEST_MEMBER, type TestApp } from "./helpers.js";

// Nexus → DRI 确认的接收端（nexus-dri-confirmation/0.1）。样例原样取自溪南 11/10 接口包的公开合成样例（密钥是样例密钥，不是真凭据）；
// 回调打到本机 127.0.0.1 上的假接收端，不调模型、不发飞书、不写本体。
const examples = JSON.parse(readFileSync(new URL("./fixtures/nexus-dri-contract-examples.json", import.meta.url), "utf8"));
const SAMPLE: TNexusDriRequest = examples.request;
const SECRET: string = examples.signingDemonstration.secret;
const TOKEN = "nexus-dri-test-token";
const CREATED = SAMPLE.createdAt;

/** 假的 Nexus 回调接收端：记下每次收到的原始正文和头，按给定的状态码依次回。 */
type Received = { body: Buffer; timestamp: string; signature: string; contentType: string };
async function fakeNexus(statuses: number[] = []) {
  const received: Received[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      received.push({ body: Buffer.concat(chunks), timestamp: String(req.headers["x-dri-timestamp"]), signature: String(req.headers["x-dri-signature"]), contentType: String(req.headers["content-type"]) });
      const status = statuses.shift() ?? 200;
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(status === 200 ? { ok: true, persisted: true, worldWritten: false } : { ok: false }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { received, statuses, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/callbacks/dri`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/** 换几个字段再重算指纹的请求。 */
function requestWith(overrides: Partial<TNexusDriRequest> & Record<string, unknown>): TNexusDriRequest {
  const request = { ...SAMPLE, ...overrides };
  return { ...request, fingerprint: requestFingerprint(request) };
}

let open: { t?: TestApp; nexus?: Awaited<ReturnType<typeof fakeNexus>> } = {};
afterEach(async () => {
  await open.t?.close();
  await open.nexus?.close();
  open = {};
});

/** 起一个接收端：租户和 agentId 用样例里的值；测试乙（成员）对到样例里的本体人员 synthetic-human。clock 是可以拨的「现在」。 */
async function setup(options: { callback?: boolean; statuses?: number[] } = {}) {
  const nexus = await fakeNexus(options.statuses);
  const localFile = join(mkdtempSync(join(tmpdir(), "nexus-dri-")), "people.json");
  writeFileSync(localFile, JSON.stringify({ people: { [TEST_MEMBER.personId]: "synthetic-human" } }));
  const clock = { at: CREATED + 60_000 };
  const env = { serviceToken: TOKEN, tenantId: SAMPLE.recipientTenant, agentId: SAMPLE.agentId, ...(options.callback === false ? {} : { callbackUrl: nexus.url, callbackSecret: SECRET }) };
  const t = await createTestApp({ nexusDri: env, worldInstanceLocalFile: localFile }, undefined, { monthlyNow: () => new Date(clock.at) });
  open = { t, nexus };
  const push = (request: TNexusDriRequest, headers: Record<string, string> = {}) => t.app.inject({
    method: "POST", url: NEXUS_DRI_REQUESTS_PATH, payload: JSON.stringify(request),
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", "idempotency-key": nexusDriIdempotencyKey(request.requestId, request.revision), ...headers },
  });
  const member = await t.memberCookie();
  const list = async (cookie = member) => (await t.app.inject({ method: "GET", url: "/api/me/nexus-confirmations", headers: { cookie } })).json().items as { id: string; question: string; value: string | null; quote: string | null }[];
  const decide = (id: string, payload: Record<string, unknown>, cookie = member) =>
    t.app.inject({ method: "POST", url: `/api/me/nexus-confirmations/${id}/decision`, headers: { cookie, origin: t.publicOrigin }, payload });
  const record = async (confirmationRef: string) =>
    (await t.app.inject({ method: "GET", url: `${NEXUS_DRI_CONFIRMATIONS_PATH}/${confirmationRef}`, headers: { authorization: `Bearer ${TOKEN}` } })).json();
  const callbackRow = async (confirmationRef: string) =>
    (await t.sql("SELECT callback_id, callback_status, callback_http_status, callback_attempts FROM nexus_dri_confirmations WHERE id = $1", [confirmationRef]))[0] as
      { callback_id: string; callback_status: string; callback_http_status: number | null; callback_attempts: number };
  return { t, nexus, clock, env, push, member, list, decide, record, callbackRow };
}

describe("Nexus → DRI 确认：指纹和签名的算法", () => {
  it("样例请求去掉 fingerprint 后规范化再 SHA-256，就是样例里的 fingerprint", () => {
    expect(requestFingerprint(SAMPLE)).toBe(SAMPLE.fingerprint);
    // 键的顺序不影响指纹。
    expect(requestFingerprint(Object.fromEntries(Object.entries(SAMPLE).reverse()))).toBe(SAMPLE.fingerprint);
  });

  it("用样例密钥签「时间戳.原始正文」，四条样例回调的签名都能算出来", () => {
    for (const callback of Object.values(examples.callbacks) as { rawBody: string; headers: Record<string, string> }[]) {
      expect(callbackSignature(SECRET, callback.headers["x-dri-timestamp"], Buffer.from(callback.rawBody, "utf8"))).toBe(callback.headers["x-dri-signature"]);
    }
  });

  it("环境变量：没设服务凭据就是关着；设了凭据没设租户、回调密钥不到 32 字节都报错", () => {
    expect(resolveNexusDriEnv({})).toBeUndefined();
    expect(() => resolveNexusDriEnv({ NEXUS_DRI_SERVICE_TOKEN: "x" })).toThrow(/NEXUS_DRI_TENANT_ID/);
    expect(() => resolveNexusDriEnv({ NEXUS_DRI_SERVICE_TOKEN: "x", NEXUS_DRI_TENANT_ID: "t", NEXUS_DRI_CALLBACK_SECRET: "short" })).toThrow(/32/);
    expect(resolveNexusDriEnv({ NEXUS_DRI_SERVICE_TOKEN: "x", NEXUS_DRI_TENANT_ID: "t" })).toEqual({ serviceToken: "x", tenantId: "t", agentId: "tianshu-dri", callbackUrl: undefined, callbackSecret: undefined });
  });
});

describe("Nexus → DRI 确认：接收和回执", () => {
  it("样例请求进来回执字段对得上；同一个 Idempotency-Key 重发回同一张回执；回执能只读查回", async () => {
    const { t, push } = await setup();
    const first = await push(SAMPLE);
    expect(first.statusCode).toBe(200);
    const receipt = first.json();
    expect(receipt).toEqual({ ...examples.deliveryReceipt, receiptId: expect.stringMatching(/^[0-9a-f-]{36}$/) });

    const again = await push(SAMPLE);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual(receipt);
    expect(await t.sql("SELECT count(*)::int AS n FROM nexus_dri_requests")).toEqual([{ n: 1 }]);

    const read = (query: string, token = TOKEN) => t.app.inject({ method: "GET", url: `${NEXUS_DRI_REQUESTS_PATH}/${encodeURIComponent(SAMPLE.requestId)}/receipt${query}`, headers: { authorization: `Bearer ${token}` } });
    expect((await read("?revision=1")).json()).toEqual(receipt);
    expect((await read("?revision=2")).statusCode).toBe(404);
    expect((await read("?revision=1", "wrong")).statusCode).toBe(401);
  }, 30_000);

  it("没带 Bearer、指纹不对、租户或 agentId 不对、正文超大、幂等键不对、同一个键正文不同，各自被拒", async () => {
    const { t, push } = await setup();
    const code = async (response: Awaited<ReturnType<typeof push>>) => [response.statusCode, response.json().code];

    expect(await code(await push(SAMPLE, { authorization: "" }))).toEqual([401, "UNAUTHORIZED"]);
    expect(await code(await push(SAMPLE, { authorization: "Bearer wrong" }))).toEqual([401, "UNAUTHORIZED"]);
    expect(await code(await push({ ...SAMPLE, question: "正文被改过" }))).toEqual([400, "FINGERPRINT_MISMATCH"]);
    expect(await code(await push(requestWith({ recipientTenant: "other-tenant" })))).toEqual([403, "TENANT_MISMATCH"]);
    expect(await code(await push(requestWith({ agentId: "other-agent" })))).toEqual([403, "AGENT_MISMATCH"]);
    expect(await code(await push(requestWith({ padding: "x".repeat(33_000) })))).toEqual([413, "PAYLOAD_TOO_LARGE"]);
    expect(await code(await push(SAMPLE, { "idempotency-key": "nexus-dri-delivery:other:1" }))).toEqual([400, "IDEMPOTENCY_KEY_MISMATCH"]);
    const { fingerprint: _fingerprint, ...missing } = SAMPLE;
    expect(await code(await push(missing as TNexusDriRequest))).toEqual([400, "INVALID_INPUT"]);
    expect(await t.sql("SELECT count(*)::int AS n FROM nexus_dri_requests")).toEqual([{ n: 0 }]);

    expect((await push(SAMPLE)).statusCode).toBe(200);
    expect(await code(await push(requestWith({ question: "同一版换了问题" })))).toEqual([409, "IDEMPOTENCY_CONFLICT"]);
  }, 30_000);

  it("新 revision 到了旧的作废，本人只看得到新的；比已收到的旧的 revision 被拒；requestId 换了事项被拒", async () => {
    const { push, list, decide } = await setup();
    expect((await push(SAMPLE)).statusCode).toBe(200);
    const [old] = await list();
    expect((await push(requestWith({ revision: 3, question: "第三版的问题" }))).statusCode).toBe(200);

    expect((await list()).map((item) => item.question)).toEqual(["第三版的问题"]);
    const stale = await decide(old.id, { decision: "confirmed" });
    expect([stale.statusCode, stale.json().code]).toEqual([409, "SUPERSEDED"]);
    const late = await push(requestWith({ revision: 2 }));
    expect([late.statusCode, late.json().code]).toEqual([409, "STALE_REVISION"]);
    const moved = await push(requestWith({ revision: 4, itemId: "another-item" }));
    expect([moved.statusCode, moved.json().code]).toEqual([409, "ITEM_MISMATCH"]);
  }, 30_000);
});

describe("Nexus → DRI 确认：本人确认、修改、拒绝和回调", () => {
  it("确认：确认记录字段齐，回调的正文和签名对得上，Nexus 回 200 记成已送达", async () => {
    const { t, nexus, clock, push, list, decide, record, callbackRow } = await setup();
    await push(SAMPLE);
    const [item] = await list();
    expect(item).toMatchObject({ question: SAMPLE.question, value: SAMPLE.content.value, quote: SAMPLE.source.quote });

    const response = await decide(item.id, { decision: "confirmed" });
    expect(response.statusCode).toBe(200);
    const { confirmationRef } = response.json();
    expect(await list()).toEqual([]);
    const confirmedAt = new Date(clock.at).toISOString();
    expect(await record(confirmationRef)).toEqual({
      confirmationRef, requestId: SAMPLE.requestId, itemId: SAMPLE.itemId, revision: 1, fingerprint: SAMPLE.fingerprint,
      decision: "confirmed", confirmedBy: "synthetic-human", confirmedAt, question: SAMPLE.question, content: SAMPLE.content,
    });

    // 内容里键的顺序照 Nexus 发来的原样。
    expect(Object.keys((await record(confirmationRef)).content)).toEqual(Object.keys(SAMPLE.content));

    // 确认时排了发送任务；跑一次。
    expect(await t.sql("SELECT payload FROM jobs WHERE kind = $1", [NEXUS_DRI_CALLBACK_KIND])).toEqual([{ payload: { confirmationRef } }]);
    await t.app.nexusDri.jobs[NEXUS_DRI_CALLBACK_KIND]({ confirmationRef }, { id: "1", kind: NEXUS_DRI_CALLBACK_KIND, dedupe_key: "k", attempts: 1, payload: {} });
    expect(nexus.received).toHaveLength(1);
    const [sent] = nexus.received;
    expect(sent.contentType).toBe("application/json");
    expect(sent.timestamp).toBe(String(clock.at));
    expect(sent.signature).toBe(callbackSignature(SECRET, sent.timestamp, sent.body));
    const body = JSON.parse(sent.body.toString("utf8"));
    expect(body).toEqual({
      callbackId: `tianshu-dri:${confirmationRef}`, requestId: SAMPLE.requestId, itemId: SAMPLE.itemId, revision: 1, fingerprint: SAMPLE.fingerprint,
      decision: "confirmed", confirmedBy: "synthetic-human", confirmedAt, confirmationRef,
    });
    // 字段顺序照溪南的样例。
    expect(Object.keys(body)).toEqual(Object.keys(examples.callbacks.confirmed.body));
    expect(await callbackRow(confirmationRef)).toEqual({ callback_id: body.callbackId, callback_status: "delivered", callback_http_status: 200, callback_attempts: 1 });

    const again = await decide(item.id, { decision: "rejected" });
    expect([again.statusCode, again.json().code]).toEqual([409, "ALREADY_DECIDED"]);
  }, 30_000);

  it("修改：只改 value、保留本人原文；原请求指纹还在，修改后的内容另有指纹；回调带完整的修改后内容", async () => {
    const { nexus, push, list, decide, record, t } = await setup();
    await push(SAMPLE);
    const [item] = await list();
    const value = "  本人修订：只承诺周五接口联调，\n正式上线另行确认。 ";

    const codeOf = async (payload: Record<string, unknown>) => { const response = await decide(item.id, payload); return [response.statusCode, response.json().code]; };
    expect(await codeOf({ decision: "amended" })).toEqual([400, "VALUE_REQUIRED"]);
    expect(await codeOf({ decision: "amended", value: SAMPLE.content.value })).toEqual([400, "VALUE_UNCHANGED"]);
    // 回调正文也不能超过 32768 字节。
    expect(await codeOf({ decision: "amended", value: "字".repeat(11_000) })).toEqual([400, "VALUE_TOO_LONG"]);

    const { confirmationRef } = (await decide(item.id, { decision: "amended", value })).json();
    const amendedContent = { ...SAMPLE.content, value };
    expect(await record(confirmationRef)).toMatchObject({
      decision: "amended", fingerprint: SAMPLE.fingerprint, content: SAMPLE.content,
      amendedContent, amendedFingerprint: fingerprintOf(amendedContent),
    });
    expect(fingerprintOf(amendedContent)).not.toBe(SAMPLE.fingerprint);
    // 原请求没有被改。
    expect(await t.sql("SELECT fingerprint, body->'content'->>'value' AS value FROM nexus_dri_requests")).toEqual([{ fingerprint: SAMPLE.fingerprint, value: SAMPLE.content.value }]);

    await t.app.nexusDri.deliver(confirmationRef);
    const body = JSON.parse(nexus.received[0].body.toString("utf8"));
    expect(body).toMatchObject({ decision: "amended", fingerprint: SAMPLE.fingerprint, content: amendedContent });
    expect(Object.keys(body)).toEqual(Object.keys(examples.callbacks.amended.body));
  }, 30_000);

  it("拒绝：记成 rejected 并回调；没有 value 的事项不能修改", async () => {
    const { nexus, push, list, decide, record, t } = await setup();
    const { value: _value, ...withoutValue } = SAMPLE.content;
    await push(requestWith({ content: { ...withoutValue, operation: "close" } }));
    const [item] = await list();
    expect(item.value).toBeNull();
    const amend = await decide(item.id, { decision: "amended", value: "改一下" });
    expect([amend.statusCode, amend.json().code]).toEqual([400, "NOT_AMENDABLE"]);

    const { confirmationRef } = (await decide(item.id, { decision: "rejected" })).json();
    expect(await record(confirmationRef)).toMatchObject({ decision: "rejected", confirmedBy: "synthetic-human", content: { ...withoutValue, operation: "close" } });
    await t.app.nexusDri.deliver(confirmationRef);
    expect(Object.keys(JSON.parse(nexus.received[0].body.toString("utf8")))).toEqual(Object.keys(examples.callbacks.rejected.body));
  }, 30_000);

  it("Nexus 回 503 时重试：同一个 callbackId、同一份正文、重新签；回 409 记成失败、不再发", async () => {
    const { t, nexus, clock, push, list, decide, callbackRow } = await setup({ statuses: [503, 200, 409] });
    await push(SAMPLE);
    const { confirmationRef } = (await decide((await list())[0].id, { decision: "confirmed" })).json();

    await expect(t.app.nexusDri.deliver(confirmationRef)).rejects.toThrow(/503/);
    expect(await callbackRow(confirmationRef)).toMatchObject({ callback_status: "pending", callback_http_status: 503, callback_attempts: 1 });
    clock.at += 60_000;
    await t.app.nexusDri.deliver(confirmationRef);
    expect(await callbackRow(confirmationRef)).toMatchObject({ callback_status: "delivered", callback_attempts: 2 });

    const [first, second] = nexus.received;
    expect(second.body.equals(first.body)).toBe(true);
    expect(second.timestamp).not.toBe(first.timestamp);
    for (const sent of [first, second]) expect(sent.signature).toBe(callbackSignature(SECRET, sent.timestamp, sent.body));
    // 已送达的不再发。
    await t.app.nexusDri.deliver(confirmationRef);
    expect(nexus.received).toHaveLength(2);

    await push(requestWith({ requestId: "dri:second", callbackCorrelation: "dri:second" }));
    const rejected = (await decide((await list())[0].id, { decision: "confirmed" })).json().confirmationRef;
    await t.app.nexusDri.deliver(rejected);
    expect(await callbackRow(rejected)).toMatchObject({ callback_status: "failed", callback_http_status: 409, callback_attempts: 1 });
    await t.app.nexusDri.deliver(rejected);
    expect(nexus.received).toHaveLength(3);
  }, 30_000);

  it("不是指定负责人去确认 403；过期后列表里没有、确认被拒；确认记录要服务凭据才能读", async () => {
    const { t, clock, push, list, decide } = await setup();
    await push(SAMPLE);
    const [item] = await list();
    const ceo = await t.loginCookie();
    expect(await list(ceo)).toEqual([]);
    const other = await decide(item.id, { decision: "confirmed" }, ceo);
    expect([other.statusCode, other.json().code]).toEqual([403, "NOT_CONFIRMER"]);

    clock.at = SAMPLE.expiresAt;
    expect(await list()).toEqual([]);
    const late = await decide(item.id, { decision: "confirmed" });
    expect([late.statusCode, late.json().code]).toEqual([409, "EXPIRED"]);
    expect(await t.sql("SELECT count(*)::int AS n FROM nexus_dri_confirmations")).toEqual([{ n: 0 }]);

    const read = (ref: string, token: string) => t.app.inject({ method: "GET", url: `${NEXUS_DRI_CONFIRMATIONS_PATH}/${ref}`, headers: { authorization: `Bearer ${token}` } });
    expect((await read("00000000-0000-4000-8000-000000000000", TOKEN)).statusCode).toBe(404);
    expect((await read("not-a-ref", TOKEN)).statusCode).toBe(404);
    expect((await read("00000000-0000-4000-8000-000000000000", "wrong")).statusCode).toBe(401);
  }, 30_000);

  it("负责人对不上记成找不到人；对应补上、重启后补认。没配回调时确认记录留在待发，配上、重启后排进任务", async () => {
    const { t, env, nexus, push, list, decide } = await setup({ callback: false });
    await push(requestWith({ proposedConfirmers: ["unknown-world-person", "synthetic-human"] }));
    expect(await t.sql("SELECT confirmer_world_id, confirmer_person_id FROM nexus_dri_requests")).toEqual([{ confirmer_world_id: "unknown-world-person", confirmer_person_id: null }]);
    expect(await list()).toEqual([]);

    const restarted = (people: Record<string, string>, callback = false) =>
      createNexusDri({ pool: t.pool, now: () => new Date(CREATED + 60_000), people, env: callback ? { ...env, callbackUrl: nexus.url, callbackSecret: SECRET } : env });
    await restarted({ [TEST_MEMBER.personId]: "unknown-world-person" }).resume();
    const [item] = await list();
    expect(item.question).toBe(SAMPLE.question);

    const { confirmationRef } = (await decide(item.id, { decision: "confirmed" })).json();
    expect(await t.sql("SELECT callback_status FROM nexus_dri_confirmations")).toEqual([{ callback_status: "pending" }]);
    expect(await t.sql("SELECT count(*)::int AS n FROM jobs WHERE kind = $1", [NEXUS_DRI_CALLBACK_KIND])).toEqual([{ n: 0 }]);
    await t.app.nexusDri.deliver(confirmationRef);
    expect(nexus.received).toHaveLength(0);

    const configured = restarted({}, true);
    await configured.resume();
    await configured.resume();
    expect(await t.sql("SELECT payload FROM jobs WHERE kind = $1", [NEXUS_DRI_CALLBACK_KIND])).toEqual([{ payload: { confirmationRef } }]);
    await configured.deliver(confirmationRef);
    expect(JSON.parse(nexus.received[0].body.toString("utf8"))).toMatchObject({ confirmationRef, confirmedBy: "unknown-world-person" });
  }, 30_000);

  it("没配服务凭据时 Nexus 调的接口不注册，本人这一侧列表为空", async () => {
    const t = await createTestApp();
    open = { t };
    const response = await t.app.inject({ method: "POST", url: NEXUS_DRI_REQUESTS_PATH, payload: JSON.stringify(SAMPLE), headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` } });
    expect(response.statusCode).toBe(404);
    expect((await t.app.inject({ method: "GET", url: "/api/me/nexus-confirmations", headers: { cookie: await t.memberCookie() } })).json()).toEqual({ items: [] });
  }, 30_000);
});
