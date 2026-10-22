import { afterEach, describe, expect, it, vi } from "vitest";
import { getScopeObject } from "../src/conversations.js";
import { getMeeting } from "../src/mcpCeoReads.js";
import { listConfirmedMeetings, readConfirmedMeeting } from "../src/meetingCardRead.js";
import type { Query } from "../src/meetingStore.js";
import type { TestApp } from "./helpers.js";
import { CEO, confirm, edit, HOST, OWNER, ready, setup } from "./meetingCardFixture.js";
import { projection, stubWorld } from "./worldFixture.js";

// 给独立 Chat 的只读接口（拍板 12）和现有读会议的地方：只读当前确认版，草稿不算事实；旧会议照旧格式。
const TOKEN = "internal-chat-test";
const DRAFT_ONLY = "草稿新改的议题";

/** 假本体：挂点 PO（版本 5），只读。 */
function ontology() {
  const po = {
    object_id: "obj-po-1", object_type: "PeriodGoal", title: "十月交付", revision_id: "obj-po-1-r5", object_version: 5, version: 5,
    lifecycle: { status: "active" }, contract_version: "tkos.world/0.3", external_refs: [],
    blocks: [{ id: "target", components: [{ id: "acc-1", type: "acceptance_criterion", text: "十月底前 3 家客户上线" }] }],
  };
  stubWorld((call) => call.url.pathname === `/v1/world/objects/${po.object_id}` ? projection(po) : { items: [], next_cursor: null });
}

const ceo = { personId: CEO, isCeo: true };
const member = { personId: OWNER, isCeo: false };
const queryOf = (t: TestApp): Query => t.pool.query.bind(t.pool);
/** 确认 v1（只留天枢），再改一笔草稿。 */
async function confirmThenEditDraft(t: TestApp, host: string, meetingId: string) {
  const draftVersion = await ready(t, host, meetingId);
  expect((await confirm(t, host, meetingId, { draftVersion, writeToWorld: false })).statusCode).toBe(200);
  await edit(t, host, meetingId, (draft) => { draft.sections[0].heading = DRAFT_ONLY; draft.summary = "草稿新改的摘要"; });
}
const internal = (t: TestApp, url: string, headers: Record<string, string>) => t.app.inject({ method: "GET", url, headers });
/** 本轮视角（10/22 起必填）：CEO 用公司视角，其他人用成员视角。 */
const asOwner = (personId: string) => ({ authorization: `Bearer ${TOKEN}`, "x-owner-id": personId, "x-viewer-role": personId === CEO ? "ceo" : "member" });
/** 再复制 n 场已确认的会（目录上限用）。 */
async function cloneConfirmed(t: TestApp, meetingId: string, n: number) {
  for (let i = 0; i < n; i++) {
    const id = crypto.randomUUID();
    await t.sql("CREATE TEMP TABLE m_copy AS SELECT * FROM meetings WHERE id = $1", [meetingId]);
    await t.sql("UPDATE m_copy SET id = $1", [id]);
    await t.sql("INSERT INTO meetings SELECT * FROM m_copy");
    await t.sql("DROP TABLE m_copy");
    for (const table of ["meeting_cards", "meeting_card_confirmations", "meeting_card_syncs"]) {
      await t.sql(`CREATE TEMP TABLE c_copy AS SELECT * FROM ${table} WHERE meeting_id = $1`, [meetingId]);
      await t.sql("UPDATE c_copy SET meeting_id = $1", [id]);
      await t.sql(`INSERT INTO ${table} SELECT * FROM c_copy`);
      await t.sql("DROP TABLE c_copy");
    }
  }
}

afterEach(() => vi.unstubAllGlobals());

describe("给独立 Chat 的确认会议只读接口", () => {
  it("草稿不进 Chat：有确认版 v1 又改了草稿，读到的是 v1；会议作为当前对象时、MCP 读会议也只有 v1", async () => {
    ontology();
    const { t, host, meetingId } = await setup();
    try {
      await confirmThenEditDraft(t, host, meetingId);
      const read = await readConfirmedMeeting(queryOf(t), ceo, meetingId);
      expect(read).toMatchObject({ status: "confirmed", confirmation: { revision: 1, confirmedBy: HOST }, syncReceipt: { revision: 1, writeToWorld: false } });
      if (read?.status !== "confirmed") throw new Error("unreachable");
      expect(read.payload.sections.map((section) => section.heading)).toEqual(["接口切换", "渠道预算"]);

      const chat = await getScopeObject(queryOf(t), `meeting:${meetingId}`, t.env.sessionSecret,
        { person: { personId: CEO, role: "ceo" }, people: [], now: new Date() });
      const text = JSON.stringify(chat.snapshot);
      expect(text).toContain("接口切换");
      expect(text).not.toContain(DRAFT_ONLY);
      expect(chat.snapshot!.payload).toMatchObject({ meetingCard: { status: "confirmed", revision: 1, summary: "接口统一切到 v2，渠道预算下周再定。" } });
      expect(chat.snapshot!.payload).not.toHaveProperty("outcome");

      const mcp = await getMeeting({ q: queryOf(t), secret: t.env.sessionSecret, now: new Date(), names: new Map(), people: [], personId: CEO }, meetingId);
      expect(mcp).toMatchObject({ outcome: null, meetingCard: { status: "confirmed", summary: "接口统一切到 v2，渠道预算下周再定。",
        sections: [{ heading: "接口切换" }, { heading: "渠道预算" }] } });
      expect(JSON.stringify(mcp)).not.toContain(DRAFT_ONLY);
    } finally {
      await t.close();
    }
  });

  it("只有草稿时没有确认版：未确认、目录里没有、Chat 不读草稿；没配服务凭据时内部接口 404", async () => {
    ontology();
    const { t, meetingId } = await setup();
    try {
      expect(await readConfirmedMeeting(queryOf(t), ceo, meetingId)).toEqual({ status: "unconfirmed" });
      expect(await listConfirmedMeetings(queryOf(t), ceo, {})).toEqual([]);
      const chat = await getScopeObject(queryOf(t), `meeting:${meetingId}`, t.env.sessionSecret,
        { person: { personId: CEO, role: "ceo" }, people: [], now: new Date() });
      expect(chat.snapshot!.payload).toMatchObject({ meetingCard: { status: "unconfirmed" } });
      expect(JSON.stringify(chat.snapshot)).not.toContain("接口统一切到 v2");
      // 没配 INTERNAL_CHAT_TOKEN：谁来都 404。
      expect((await internal(t, "/internal/confirmed-meetings", asOwner(CEO))).statusCode).toBe(404);
      expect((await internal(t, `/internal/confirmed-meetings/${meetingId}`, asOwner(CEO))).statusCode).toBe(404);
    } finally {
      await t.close();
    }
  });

  it("旧会议照旧格式：没有会议卡、已有逐条结论的会 → legacy", async () => {
    ontology();
    const { t, meetingId } = await setup();
    try {
      await t.sql("DELETE FROM meeting_cards WHERE meeting_id = $1", [meetingId]);
      await t.sql(`UPDATE meetings SET outcome = outcome || $2::jsonb WHERE id = $1`, [meetingId, JSON.stringify({ status: "ready", summary: "旧摘要",
        items: [{ id: "item-1", kind: "decision", text: "旧决定", review: { status: "confirmed" } }, { id: "item-2", kind: "todo", text: "旧待办", review: null }] })]);
      expect(await readConfirmedMeeting(queryOf(t), ceo, meetingId)).toEqual({ status: "legacy", summary: "旧摘要",
        items: [{ kind: "decision", text: "旧决定", status: "confirmed" }, { kind: "todo", text: "旧待办", status: "open" }] });
    } finally {
      await t.close();
    }
  });

  it("目录按可读范围，内部接口要服务凭据，正文被改过就不返回", async () => {
    ontology();
    const { t, host, meetingId } = await setup(undefined, { internalChatToken: TOKEN });
    try {
      await confirmThenEditDraft(t, host, meetingId);
      // 实际参会只有主持人和 CEO：测试丙是受邀成员但没参会。
      await t.sql("UPDATE meetings SET attendees_actual = $2::jsonb WHERE id = $1", [meetingId, JSON.stringify([HOST, CEO])]);
      expect(await listConfirmedMeetings(queryOf(t), member, {})).toEqual([]);
      expect(await readConfirmedMeeting(queryOf(t), member, meetingId)).toBeNull();
      const listed = await listConfirmedMeetings(queryOf(t), ceo, {});
      expect(listed).toEqual([{ meetingId, title: "接口切换会", occurredAt: "2026-06-01T10:02:00+08:00",
        participants: expect.any(Array), currentConfirmedVersion: 1 }]);
      expect(await listConfirmedMeetings(queryOf(t), ceo, { query: "渠道" })).toHaveLength(1);
      expect(await listConfirmedMeetings(queryOf(t), ceo, { query: DRAFT_ONLY })).toEqual([]);
      expect(await listConfirmedMeetings(queryOf(t), ceo, { from: "2026-06-02T00:00:00Z" })).toEqual([]);
      expect(await listConfirmedMeetings(queryOf(t), ceo, { to: "2026-06-02T00:00:00Z", participantId: HOST })).toHaveLength(1);
      expect(await listConfirmedMeetings(queryOf(t), ceo, { participantId: OWNER })).toEqual([]);
      await cloneConfirmed(t, meetingId, 6);
      expect(await listConfirmedMeetings(queryOf(t), ceo, { limit: 50 })).toHaveLength(5);

      // 服务凭据：不带、带错 → 401。
      expect((await internal(t, "/internal/confirmed-meetings", { "x-owner-id": CEO })).statusCode).toBe(401);
      expect((await internal(t, "/internal/confirmed-meetings", { authorization: "Bearer wrong", "x-owner-id": CEO })).statusCode).toBe(401);
      expect((await internal(t, `/internal/confirmed-meetings/${meetingId}`, { authorization: "Bearer wrong", "x-owner-id": CEO })).statusCode).toBe(401);
      // 没带视角 → 400（10/22 起必填）。
      const noView = await internal(t, "/internal/confirmed-meetings", { authorization: `Bearer ${TOKEN}`, "x-owner-id": CEO });
      expect([noView.statusCode, noView.json().code]).toEqual([400, "VIEW_REQUIRED"]);
      // 带对凭据，没参会的成员 → 404；目录为空。
      expect((await internal(t, `/internal/confirmed-meetings/${meetingId}`, asOwner(OWNER))).statusCode).toBe(404);
      const memberList = await internal(t, "/internal/confirmed-meetings", asOwner(OWNER));
      expect(memberList.statusCode).toBe(200);
      expect(memberList.json()).toEqual({ meetings: [] });
      // CEO：目录最多 5 条，详情是确认版。
      const ceoList = await internal(t, "/internal/confirmed-meetings?limit=50", asOwner(CEO));
      expect(ceoList.statusCode).toBe(200);
      expect(ceoList.json().meetings).toHaveLength(5);
      const detail = await internal(t, `/internal/confirmed-meetings/${meetingId}`, asOwner(CEO));
      expect(detail.statusCode).toBe(200);
      expect(detail.json()).toMatchObject({ status: "confirmed", payload: { revision: 1, summary: "接口统一切到 v2，渠道预算下周再定。" },
        confirmation: { revision: 1 }, syncReceipt: { revision: 1 } });

      // 直接改库里冻结的 payload 一个字 → 500，不返回内容。
      await t.sql(`UPDATE meeting_card_confirmations SET payload = jsonb_set(payload, '{summary}', to_jsonb((payload->>'summary') || '。')) WHERE meeting_id = $1`, [meetingId]);
      const tampered = await internal(t, `/internal/confirmed-meetings/${meetingId}`, asOwner(CEO));
      expect(tampered.statusCode).toBe(500);
      expect(tampered.json().code).toBe("PAYLOAD_HASH_MISMATCH");
      expect(tampered.body).not.toContain("接口切换");
    } finally {
      await t.close();
    }
  });
});
