import { afterEach, describe, expect, it, vi } from "vitest";
import type { TMeetingCardFrozenPayload } from "@warmap/contracts";
import { getScopeObject } from "../src/conversations.js";
import { getMeeting } from "../src/mcpCeoReads.js";
import { payloadHash } from "../src/meetingCardHash.js";
import { listConfirmedMeetings, readConfirmedMeeting } from "../src/meetingCardRead.js";
import type { Query } from "../src/meetingStore.js";
import type { PostMeetingAgent } from "../src/outcome.js";
import type { TestApp } from "./helpers.js";
import { CEO, confirm, edit, HOST, OCCURRED, OWNER, ready, setup } from "./meetingCardFixture.js";
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
/** 再复制 n 场已确认的会（目录上限、检索排序用），返回新会的 id。 */
async function cloneConfirmed(t: TestApp, meetingId: string, n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = crypto.randomUUID();
    ids.push(id);
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
  return ids;
}
/** 改一场会的确认版正文，并重算确认时记下的摘要值（当作正常确认过的）。 */
async function rewriteConfirmed(t: TestApp, meetingId: string, change: (payload: TMeetingCardFrozenPayload) => void) {
  const [row] = await t.sql("SELECT payload FROM meeting_card_confirmations WHERE meeting_id = $1", [meetingId]);
  const payload = row.payload as TMeetingCardFrozenPayload;
  change(payload);
  await t.sql("UPDATE meeting_card_confirmations SET payload = $2::jsonb, confirmation = jsonb_set(confirmation, '{payloadHash}', to_jsonb($3::text)) WHERE meeting_id = $1",
    [meetingId, JSON.stringify(payload), payloadHash(payload)]);
}
/** 决定只写在段落正文里的会（10/23 诊断：「预发环境回收提前到 10/27」不在会议名、摘要和段落标题里）。 */
const teardownAgent: PostMeetingAgent = {
  async generate() {
    return { candidate: {
      summary: "接口统一切到 v2，渠道预算下周再定。",
      sections: [
        { heading: "预发环境", body: "已定：预发环境回收提前，由 10/28 前调整为 10/27 前停服务、删卷和站点。", turnIds: ["turn-002"] },
        { heading: "渠道预算", body: "未定：渠道预算下周看数据再定。", turnIds: ["turn-001"] },
      ],
      decisions: [{ text: "接口统一改成 v2", ownerPersonId: OWNER, basisSections: [1] }],
      objectChanges: [{ targetRef: "obj-po-1#target/acc-1", after: { text: "十月底前 4 家客户上线" }, basisSections: [1], decision: 1 }],
      actionItems: [{ text: "渠道看板接到 v2", ownerPersonId: OWNER, dueDate: "2026-06-30", basisSections: [2] }],
    } };
  },
};

afterEach(() => vi.unstubAllGlobals());

describe("给独立 Chat 的确认会议只读接口", () => {
  it("草稿不进 Chat：有确认版 v1 又改了草稿，读到的是 v1；会议作为当前对象时、MCP 读会议也只有 v1", async () => {
    ontology();
    const { t, host, meetingId } = await setup();
    try {
      await confirmThenEditDraft(t, host, meetingId);
      const read = await readConfirmedMeeting(queryOf(t), ceo, meetingId);
      expect(read).toMatchObject({ status: "confirmed", kind: "first", confirmation: { revision: 1, confirmedBy: HOST }, syncReceipt: { revision: 1, writeToWorld: false } });
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

  it("检索确认版正文：按词切分，命中正文段落、对象修改和行动项，带段落引用和片段；命中词多的会在前；可读范围和摘要值核对同详情", async () => {
    ontology();
    const { t, host, meetingId } = await setup(teardownAgent, { internalChatToken: TOKEN });
    try {
      const draftVersion = await ready(t, host, meetingId);
      expect((await confirm(t, host, meetingId, { draftVersion, writeToWorld: false })).statusCode).toBe(200);
      const search = async (personId: string, query: string) => {
        const res = await internal(t, `/internal/confirmed-meetings?${new URLSearchParams({ query })}`, asOwner(personId));
        expect(res.statusCode).toBe(200);
        return res.json().meetings as { meetingId: string; matches: { ref: string; snippet: string }[] }[];
      };

      // 「预发 回收」两个词都只在正文里：按词切分后能找到，片段就是那段正文。
      expect(await search(CEO, "预发 回收")).toEqual([{ meetingId, title: "接口切换会", occurredAt: OCCURRED, participants: expect.any(Array), currentConfirmedVersion: 1,
        matches: [{ ref: "sec-1", kind: "section", heading: "预发环境", snippet: "已定：预发环境回收提前，由 10/28 前调整为 10/27 前停服务、删卷和站点。" }] }]);
      // 段落按命中词数排：sec-1 两个，摘要、sec-2、行动项各一个，最多 3 段。
      expect((await search(CEO, "预发 回收 渠道"))[0].matches.map((match) => match.ref)).toEqual(["sec-1", "summary", "sec-2"]);
      // 对象修改后的文字、行动项也能搜到。
      expect((await search(CEO, "客户上线"))[0].matches).toEqual([{ ref: "chg-1", kind: "objectChange", heading: "十月交付 · 验收标准", snippet: "十月底前 4 家客户上线" }]);
      expect((await search(CEO, "看板"))[0].matches).toEqual([{ ref: "act-1", kind: "actionItem", heading: "行动项 · 截止 2026-06-30", snippet: "渠道看板接到 v2" }]);
      expect(await search(CEO, "不存在的词")).toEqual([]);
      // 汉字按二元组切：连写的「预发回收」、整句问法都能命中那段。
      for (const query of ["预发回收", "我需要在几号前完成预发环境回收"]) {
        expect((await search(CEO, query))[0].matches[0]).toMatchObject({ ref: "sec-1", snippet: expect.stringContaining("10/27 前") });
      }
      // 只有空白和标点：和不带 query 一样；query 超过 200 字 → 400。
      const plain = await internal(t, "/internal/confirmed-meetings", asOwner(CEO));
      expect((await internal(t, `/internal/confirmed-meetings?${new URLSearchParams({ query: " ，。！ ?" })}`, asOwner(CEO))).json()).toEqual(plain.json());
      expect(plain.json().meetings[0]).not.toHaveProperty("matches");
      const tooLong = await internal(t, `/internal/confirmed-meetings?${new URLSearchParams({ query: "预".repeat(201) })}`, asOwner(CEO));
      expect([tooLong.statusCode, tooLong.json().code]).toEqual([400, "INVALID_INPUT"]);

      // 另一场更晚的会只命中「预发」：排在两个词都命中的这场后面；长段落只给命中词附近。
      const [other] = await cloneConfirmed(t, meetingId, 1);
      await rewriteConfirmed(t, other, (payload) => {
        payload.occurredAt = "2026-06-08T10:00:00+08:00";
        payload.sections[0].body = `${"背景".repeat(150)}预发环境下周再看。`;
      });
      const ranked = await search(CEO, "预发 回收");
      expect(ranked.map((meeting) => meeting.meetingId)).toEqual([meetingId, other]);
      expect(ranked[1].matches[0].snippet).toMatch(/^…(背景){30}预发环境下周再看。$/);

      // 可读范围同详情：测试丙在参会人里能搜到；实际参会只有主持人和 CEO 时搜不到。
      expect((await search(OWNER, "预发 回收")).map((meeting) => meeting.meetingId)).toContain(meetingId);
      await t.sql("UPDATE meetings SET attendees_actual = $2::jsonb WHERE id = ANY($1::uuid[])", [[meetingId, other], JSON.stringify([HOST, CEO])]);
      expect(await search(OWNER, "预发 回收")).toEqual([]);

      // 正文被改过、和确认时的摘要值对不上：不进检索结果。
      await t.sql(`UPDATE meeting_card_confirmations SET payload = jsonb_set(payload, '{summary}', to_jsonb((payload->>'summary') || '。')) WHERE meeting_id = $1`, [meetingId]);
      expect((await search(CEO, "预发 回收")).map((meeting) => meeting.meetingId)).toEqual([other]);
    } finally {
      await t.close();
    }
  });
});
