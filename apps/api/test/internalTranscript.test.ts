import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FeishuApiError } from "../src/feishu/client.js";
import type { FeishuMinutesApi } from "../src/feishu/minutes.js";
import { saveAuthorizedToken } from "../src/feishu/tokens.js";
import { transcriptContentHash } from "../src/transcriptHash.js";
import type { TestApp } from "./helpers.js";
import { CEO, confirm, HOST, OWNER, ready, setup } from "./meetingCardFixture.js";
import { projection, stubWorld } from "./worldFixture.js";

// 给独立 Chat 代读逐字稿（10/21 与人豪约定）：用提问人本人的飞书授权读妙记全文；读不到就说读不到，不退回天枢存的逐字稿。
const TOKEN = "internal-chat-test";
const MINUTE = "obcn_minute_1";
const feishuEnv = { tokenKey: randomBytes(32), tokenKeyVersion: 1 };
const TEXT = "2026-06-01 10:02:10 CST|58min 3s\r\n\r\n测试乙 00:00:05.120 \r\n接口统一改成 v2。\r\n";
const STORED = { format: "feishu_minutes", fileName: "接口切换会.txt", sizeBytes: 10, sha256: "a".repeat(64), parserVersion: "feishu-txt.v1", timeAnchor: null,
  url: "https://example.feishu.cn/minutes/obcn_minute_1", title: "妙记标题", contentHash: "b".repeat(64), capturedAt: "2026-06-01T11:00:00+08:00" };

function fakeApi(): FeishuMinutesApi & { calls: string[]; artifactsError: Error | null; exportError: Error | null } {
  const api = {
    calls: [] as string[],
    artifactsError: null as Error | null,
    exportError: null as Error | null,
    async getMinute(): Promise<never> { throw new Error("不该调用"); },
    async artifactTranscript(token: string, minuteToken: string) {
      api.calls.push(`artifacts:${token}:${minuteToken}`);
      if (api.artifactsError) throw api.artifactsError;
      return TEXT;
    },
    async exportTranscript(token: string, minuteToken: string) {
      api.calls.push(`export:${token}:${minuteToken}`);
      if (api.exportError) throw api.exportError;
      return TEXT;
    },
    async listMinutes(): Promise<never> { throw new Error("不该调用"); },
    async meetingParticipants(): Promise<never> { throw new Error("不该调用"); },
  };
  return api;
}

const read = (t: TestApp, meetingId: string, headers: Record<string, string>) =>
  t.app.inject({ method: "GET", url: `/internal/confirmed-meetings/${meetingId}/transcript`, headers });
/** 本轮视角（10/22 起必填）：CEO 用公司视角，其他人用成员视角。 */
const asOwner = (personId: string) => ({ authorization: `Bearer ${TOKEN}`, "x-owner-id": personId, "x-viewer-role": personId === CEO ? "ceo" : "member" });
async function authorize(t: TestApp, personId: string) {
  await t.sql("INSERT INTO feishu_identities (person_id, open_id, name) VALUES ($1, $2, $3)", [personId, `ou_${personId}`, personId]);
  await saveAuthorizedToken(t.pool.query.bind(t.pool), feishuEnv, personId, { accessToken: `u-${personId}`, expiresIn: 7200, scope: "offline_access" }, new Date());
}

/** 假本体：挂点 PO，只读。 */
function ontology() {
  const po = {
    object_id: "obj-po-1", object_type: "PeriodGoal", title: "十月交付", revision_id: "obj-po-1-r5", object_version: 5, version: 5,
    lifecycle: { status: "active" }, contract_version: "tkos.world/0.3", external_refs: [],
    blocks: [{ id: "target", components: [{ id: "acc-1", type: "acceptance_criterion", text: "十月底前 3 家客户上线" }] }],
  };
  stubWorld((call) => call.url.pathname === `/v1/world/objects/${po.object_id}` ? projection(po) : { items: [], next_cursor: null });
}

afterEach(() => vi.unstubAllGlobals());

describe("给独立 Chat 代读逐字稿", () => {
  it("用提问人本人的授权读飞书妙记全文；没授权、没妙记、读不了这场会、飞书不给读各有错误码", async () => {
    ontology();
    const api = fakeApi();
    const { t, host, meetingId } = await setup(undefined, { internalChatToken: TOKEN, feishu: { appId: "cli_test", appSecret: "test-secret", ...feishuEnv } },
      { meetingFollowThroughAgents: { minutesApi: api } });
    try {
      const draftVersion = await ready(t, host, meetingId);
      expect((await confirm(t, host, meetingId, { draftVersion, writeToWorld: false })).statusCode).toBe(200);
      // 实际参会只有主持人和 CEO：测试丙读不了这场会。
      await t.sql("UPDATE meetings SET attendees_actual = $2::jsonb, minute_token = $3, transcript = jsonb_set(transcript, '{source}', $4::jsonb) WHERE id = $1",
        [meetingId, JSON.stringify([HOST, CEO]), MINUTE, JSON.stringify(STORED)]);
      await authorize(t, HOST);
      await authorize(t, OWNER);

      // 服务凭据：不带、带错 → 401。
      expect((await read(t, meetingId, { "x-owner-id": HOST })).statusCode).toBe(401);
      expect((await read(t, meetingId, { authorization: "Bearer wrong", "x-owner-id": HOST })).statusCode).toBe(401);
      // 没带视角 → 400（10/22 起必填），不去飞书读。
      const noView = await read(t, meetingId, { authorization: `Bearer ${TOKEN}`, "x-owner-id": HOST });
      expect([noView.statusCode, noView.json().code]).toEqual([400, "VIEW_REQUIRED"]);

      // 主持人：用他自己的 token 读，原样返回全文和两个摘要值。
      const ok = await read(t, meetingId, asOwner(HOST));
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toEqual({ meetingId, source: { url: STORED.url, title: STORED.title }, text: TEXT,
        contentHash: transcriptContentHash(TEXT), confirmedContentHash: STORED.contentHash });
      expect(api.calls).toEqual([`artifacts:u-${HOST}:${MINUTE}`]);

      // 读不了这场会（有授权也一样）→ 404，不去飞书读。
      api.calls.length = 0;
      const hidden = await read(t, meetingId, asOwner(OWNER));
      expect([hidden.statusCode, hidden.json().code]).toEqual([404, "MEETING_NOT_FOUND"]);
      expect(api.calls).toEqual([]);

      // CEO 能读这场会但没连飞书 → 403。
      const notConnected = await read(t, meetingId, asOwner(CEO));
      expect([notConnected.statusCode, notConnected.json().code]).toEqual([403, "FEISHU_NOT_CONNECTED"]);
      expect(api.calls).toEqual([]);

      // 产物接口不给读退回导出接口；两个都没权限 → 403 FEISHU_NO_PERMISSION，不带逐字稿。
      api.artifactsError = new FeishuApiError(99991679, "Unauthorized");
      expect((await read(t, meetingId, asOwner(HOST))).statusCode).toBe(200);
      expect(api.calls).toEqual([`artifacts:u-${HOST}:${MINUTE}`, `export:u-${HOST}:${MINUTE}`]);
      api.exportError = new FeishuApiError(2091005, "no permission");
      const denied = await read(t, meetingId, asOwner(HOST));
      expect([denied.statusCode, denied.json().code]).toEqual([403, "FEISHU_NO_PERMISSION"]);
      expect(denied.body).not.toContain("接口统一");
      api.exportError = new FeishuApiError(2091003, "not ready");
      expect((await read(t, meetingId, asOwner(HOST))).json().code).toBe("MINUTES_NOT_READY");
      api.artifactsError = api.exportError = null;

      // 存的来源没有地址和摘要值、也没配 FEISHU_WEB_ORIGIN：地址 null，标题用会议名。
      await t.sql("UPDATE meetings SET transcript = transcript - 'source' WHERE id = $1", [meetingId]);
      expect((await read(t, meetingId, asOwner(HOST))).json()).toMatchObject({ source: { url: null, title: "接口切换会" }, confirmedContentHash: null });

      // 没有飞书妙记（手动上传的逐字稿）→ 404 NO_FEISHU_MINUTES。
      await t.sql("UPDATE meetings SET minute_token = NULL WHERE id = $1", [meetingId]);
      const noMinutes = await read(t, meetingId, asOwner(HOST));
      expect([noMinutes.statusCode, noMinutes.json().code]).toEqual([404, "NO_FEISHU_MINUTES"]);
    } finally {
      await t.close();
    }
  });
});
