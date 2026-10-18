import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { DocChangeView, ImpactCardView } from "@warmap/contracts";
import { createTestApp, type TestApp } from "./helpers.js";
import { docLinks } from "../src/docChanges.js";
import type { DocChangeAgent, DocChangeAgentInput, TDocCandidatesCandidate } from "../src/docChangeAgent.js";
import type { FeishuClient } from "../src/feishu/client.js";
import { saveAuthorizedToken } from "../src/feishu/tokens.js";
import { hashSecret } from "../src/session.js";

// ⑧ 文档变更：群里 @机器人 贴链接即发布 → Agent 找候选 → 作者确认（或改问负责人）→ 依据旧版的人收影响卡 → 卡上选择更新工作依据清单。
const PEOPLE_SEED = fileURLToPath(new URL("./fixtures/company-people-candidate.json", import.meta.url));
const CEO = "person-fixture-001"; // 测试甲
const AUTHOR = "person-fixture-002"; // 测试乙
const OWNER = "person-fixture-003"; // 测试丙
const NEW_URL = "https://tokenking.feishu.cn/docx/NewDoc04";
const OLD_URL = "https://tokenking.feishu.cn/docx/OldDocV6";
const MESSAGE_EVENT = "im.message.receive_v1";

function fakeAgent(result: TDocCandidatesCandidate["candidates"]): DocChangeAgent & { inputs: DocChangeAgentInput[] } {
  const agent = {
    inputs: [] as DocChangeAgentInput[],
    async findCandidates(input: DocChangeAgentInput) { agent.inputs.push(input); return { candidates: result }; },
  };
  return agent;
}

const groupMessage = (messageId: string, text: string, openId = "ou_author", extra: Record<string, unknown> = {}) => ({
  schema: "2.0", event_id: `ev-${messageId}`, event_type: MESSAGE_EVENT,
  sender: { sender_id: { open_id: openId }, sender_type: "user" },
  message: { message_id: messageId, chat_id: "oc_method", chat_type: "group", message_type: "text", content: JSON.stringify({ text }),
    mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" }, name: "天枢" }], ...extra },
});

async function cookieOf(t: TestApp, personId: string, loginId: string): Promise<string> {
  await t.pool.query("INSERT INTO member_access (person_id, login_id, passcode_hash, must_change) VALUES ($1, $2, $3, FALSE) ON CONFLICT (person_id) DO NOTHING",
    [personId, loginId, hashSecret("3579")]);
  const login = await t.app.inject({ method: "POST", url: "/api/auth/login", headers: { origin: t.publicOrigin }, payload: { loginId, passcode: "3579" } });
  return String(login.headers["set-cookie"]).split(";")[0];
}

async function basis(t: TestApp, personId: string, url: string, title: string, revisedAt: string | null = null) {
  await t.sql(`INSERT INTO work_basis (id, person_id, doc_kind, doc_ref, title, url, revision, revised_at, revised_by, confirmed_at)
    VALUES ($1, $2, 'feishu_doc', $3, $4, $3, NULL, $5, NULL, now())`, [randomUUID(), personId, url, title, revisedAt]);
}

async function identities(t: TestApp) {
  await t.sql("INSERT INTO feishu_identities (person_id, open_id, name) VALUES ($1, 'ou_ceo', '测试甲'), ($2, 'ou_author', '测试乙'), ($3, 'ou_owner', '测试丙')", [CEO, AUTHOR, OWNER]);
}

/** 群消息进来 → 落 doc_changes 并排找候选 → 跑找候选。 */
async function publish(t: TestApp, messageId: string, text: string): Promise<string> {
  const jobs = t.app.docChanges.jobs();
  await jobs.feishuEvents[MESSAGE_EVENT](groupMessage(messageId, text));
  const id = (await t.sql("SELECT id::text FROM doc_changes WHERE message_id = $1", [messageId]))[0].id as string;
  expect((await t.sql("SELECT payload FROM jobs WHERE kind = 'doc_change.analyze' AND dedupe_key = $1", [`doc_change.analyze:${id}`]))).toEqual([{ payload: { docChangeId: id } }]);
  await jobs.handlers["doc_change.analyze"]({ docChangeId: id }, { id: "1", kind: "doc_change.analyze", dedupe_key: "", attempts: 1, payload: {} });
  return id;
}

const get = (t: TestApp, cookie: string, url: string) => t.app.inject({ method: "GET", url, headers: { cookie } });
const post = (t: TestApp, cookie: string, url: string, payload: unknown = {}) => t.app.inject({ method: "POST", url, headers: { cookie, origin: t.publicOrigin }, payload: payload as object });
const inbox = async (t: TestApp, cookie: string) => (await get(t, cookie, "/api/me/requests?box=inbox")).json().items as { id: string; kind: string; title: string; myStatus: string }[];

describe("文档变更", () => {
  it("消息里的飞书文档链接规范成 域名/类型/token，同一份只留一个", () => {
    expect(docLinks(JSON.stringify({ text: `@_user_1 新版 ${NEW_URL}?from=im 和 ${NEW_URL} 还有 https://x.larksuite.com/wiki/WikiTok1 https://example.com/a` })))
      .toEqual([NEW_URL, "https://x.larksuite.com/wiki/WikiTok1"]);
  });

  it("作者确认取代 → 依据旧版的人收卡；继续用旧版到某天、切换到新版都写进各自的工作依据清单；旧文档在清单里标为已被取代", async () => {
    const feishu = { appId: "cli_test", appSecret: "test-secret", tokenKey: randomBytes(32), tokenKeyVersion: 1 };
    const metas = [
      { token: "NewDoc04", type: "docx" as const, title: "M2 战略解码 v0.4", modifiedAt: new Date("2026-10-19T02:00:00.000Z"), modifiedBy: "ou_author", ownerId: "ou_author" },
      { token: "OldDocV6", type: "docx" as const, title: "M1-B L3 v6", modifiedAt: new Date("2026-09-20T02:00:00.000Z"), modifiedBy: "ou_owner", ownerId: "ou_owner" },
    ];
    const asked: { token: string; docs: { token: string }[] }[] = [];
    const client = {
      getDocMetas: async (token: string, docs: { token: string }[]) => { asked.push({ token, docs }); return metas.filter((meta) => docs.some((doc) => doc.token === meta.token)); },
      sendMessage: async () => ({ messageId: "om_sent" }),
    } as unknown as FeishuClient;
    // 别人依据清单里、作者打不开的文档（元数据读不到）不列给作者。
    const agent = fakeAgent([{ key: "feishu:OldDocV6", relation: "supersede", reason: "同一编号的方法，测试丙 9/20 写的" },
      { key: "feishu:Hidden01", relation: "supersede", reason: "标题相近" }, { key: "feishu:NotInPool", relation: "revision", reason: "编的" }]);
    const t = await createTestApp({ companyPeopleSeed: PEOPLE_SEED, feishu }, undefined, { feishuClient: client, docChangeAgent: agent });
    try {
      await identities(t);
      await saveAuthorizedToken(async (sql, params) => ({ rows: await t.sql(sql, params) }) as never, feishu, AUTHOR,
        { accessToken: "u-author", refreshToken: "ur-author", expiresIn: 7200, refreshExpiresIn: 604800, scope: "drive:drive.metadata:readonly" }, new Date());
      await basis(t, OWNER, OLD_URL, "M1-B L3 v6", "2026-09-20T02:00:00.000Z");
      await basis(t, CEO, `${OLD_URL}?from=wiki`, "M1-B L3 v6");
      await basis(t, AUTHOR, OLD_URL, "M1-B L3 v6");
      await basis(t, CEO, "https://tokenking.feishu.cn/docx/Hidden01", "别人的方案");

      // 私聊、没 @、不认识的人发的都不算发布。
      const jobs = t.app.docChanges.jobs();
      await jobs.feishuEvents[MESSAGE_EVENT](groupMessage("om_p2p", NEW_URL, "ou_author", { chat_type: "p2p" }));
      await jobs.feishuEvents[MESSAGE_EVENT](groupMessage("om_nomention", NEW_URL, "ou_author", { mentions: [] }));
      await jobs.feishuEvents[MESSAGE_EVENT](groupMessage("om_stranger", NEW_URL, "ou_stranger"));
      expect(await t.sql("SELECT count(*)::int AS n FROM doc_changes")).toEqual([{ n: 0 }]);

      const id = await publish(t, "om_1", `@_user_1 方法已更新 ${NEW_URL}`);
      // 按作者身份只读元数据；候选池里同一份文档换了参数也认得出，依据人数按人去重。
      expect(asked[0]).toEqual({ token: "u-author", docs: [{ token: "NewDoc04", type: "docx" }] });
      expect(agent.inputs[0].newDoc).toEqual({ title: "M2 战略解码 v0.4", author: "测试乙", revisedAt: "2026-10-19T02:00:00.000Z" });
      expect(agent.inputs[0].pool.find((doc) => doc.key === "feishu:OldDocV6")).toMatchObject({ title: "M1-B L3 v6", dependents: 3 });
      const candidates = await t.sql("SELECT key, title, owner_id, suggested FROM doc_change_candidates ORDER BY position");
      expect(candidates).toEqual([{ key: "feishu:OldDocV6", title: "M1-B L3 v6", owner_id: OWNER, suggested: "supersede" }]);

      const author = await t.memberCookie();
      const [request] = await inbox(t, author);
      expect(request).toMatchObject({ kind: "doc_change", title: "《M2 战略解码 v0.4》修订或取代了哪份", myStatus: "pending" });
      expect((await get(t, author, "/api/me/requests?box=sent")).json().items).toEqual([]);
      const read = await get(t, author, `/api/requests/${request.id}/doc-change`);
      expect(read.statusCode).toBe(200);
      const view = read.json().docChange;
      expect(Value.Check(DocChangeView, view)).toBe(true);
      expect(view).toMatchObject({ status: "awaiting_author", newDoc: { title: "M2 战略解码 v0.4", url: NEW_URL }, authorName: "测试乙",
        viewer: { role: "author", canDecide: true, canAskOwners: true, ownerKeys: [] } });
      expect(view.candidates).toEqual([expect.objectContaining({ key: "feishu:OldDocV6", ownerName: "测试丙", dependents: 3, suggested: "supersede", relation: null })]);
      expect(view.steps.map((step: { label: string; status: string }) => [step.label, step.status])).toEqual([
        ["读文档信息", "done"], ["找相关文档", "done"], ["确认关系", "current"], ["推送影响卡", "pending"]]);
      // 只有作者看得到。
      const ceo = await t.loginCookie();
      expect((await get(t, ceo, `/api/requests/${request.id}/doc-change`)).statusCode).toBe(404);
      expect((await post(t, ceo, `/api/doc-changes/${id}/confirm`, { links: [] })).statusCode).toBe(404);
      // 不在候选里的不收；过渡期不能早于生效日期。
      expect((await post(t, author, `/api/doc-changes/${id}/confirm`, { links: [{ key: "feishu:Hidden01", relation: "supersede" }] })).statusCode).toBe(400);
      expect((await post(t, author, `/api/doc-changes/${id}/confirm`, { links: [{ key: "feishu:OldDocV6", relation: "supersede" }], effectiveOn: "2026-11-01", transitionUntil: "2026-10-30" })).statusCode).toBe(400);

      const confirmed = await post(t, author, `/api/doc-changes/${id}/confirm`, {
        links: [{ key: "feishu:OldDocV6", relation: "supersede" }], effectiveOn: "2026-10-20", transitionUntil: "2026-11-15", keepExisting: true });
      expect(confirmed.statusCode).toBe(200);
      expect(confirmed.json().docChange).toMatchObject({ status: "confirmed", pushed: 2, decidedByName: "测试乙", effectiveOn: "2026-10-20", transitionUntil: "2026-11-15", keepExisting: true,
        viewer: { canDecide: false } });
      expect(confirmed.json().docChange.steps.at(-1)).toEqual({ label: "推送影响卡", status: "done", result: "推给 2 人" });
      expect((await post(t, author, `/api/doc-changes/${id}/confirm`, { links: [] })).statusCode).toBe(409);
      expect((await inbox(t, author))[0].myStatus).toBe("done");
      // 作者自己不收卡；飞书通知：作者的确认卡一张、两张影响卡。
      expect(await t.sql("SELECT person_id FROM impact_cards ORDER BY person_id")).toEqual([{ person_id: CEO }, { person_id: OWNER }]);
      expect((await t.sql("SELECT count(*)::int AS n FROM jobs WHERE kind = 'feishu.notify'"))[0].n).toBe(3);

      const owner = await cookieOf(t, OWNER, "ceshib");
      const [impact] = await inbox(t, owner);
      expect(impact).toMatchObject({ kind: "impact", title: "《M1-B L3 v6》已被《M2 战略解码 v0.4》取代", myStatus: "pending" });
      const notes = (await get(t, owner, "/api/me/notifications")).json();
      expect(JSON.stringify(notes)).toContain("文档变更影响你：《M1-B L3 v6》已被《M2 战略解码 v0.4》取代");
      const card = (await get(t, owner, `/api/requests/${impact.id}/impact`)).json().card;
      expect(Value.Check(ImpactCardView, card)).toBe(true);
      expect(card).toMatchObject({
        impact: "你依据的《M1-B L3 v6》已被《M2 战略解码 v0.4》取代，10/20 起生效，过渡期到 11/15。已经在做的工作可以按旧版做完。",
        action: { kind: "do", due: "2026-11-15" }, askWho: [{ personId: AUTHOR, displayName: "测试乙", role: "author" }], basisChoice: null,
        trigger: { kind: "doc_change", relation: "supersede", newDoc: { title: "M2 战略解码 v0.4", url: NEW_URL },
          oldDoc: { title: "M1-B L3 v6", revisedAt: "2026-09-20T02:00:00.000Z" }, authorName: "测试乙", decidedByName: "测试乙", effectiveOn: "2026-10-20" },
      });

      // 测试丙：继续用旧版到 11/10，写一句理由。
      expect((await post(t, owner, `/api/impact-cards/${card.id}/basis`, { choice: "keep", until: "2026-11-10" })).statusCode).toBe(400);
      const kept = await post(t, owner, `/api/impact-cards/${card.id}/basis`, { choice: "keep", until: "2026-11-10", reason: "这个月的验收按旧方法定的" });
      expect(kept.statusCode).toBe(200);
      expect(kept.json().card.basisChoice).toMatchObject({ choice: "keep", until: "2026-11-10", reason: "这个月的验收按旧方法定的" });
      expect((await post(t, owner, `/api/impact-cards/${card.id}/basis`, { choice: "switch" })).statusCode).toBe(409);
      expect((await inbox(t, owner))[0].myStatus).toBe("done");
      const ownerBasis = (await get(t, owner, "/api/me/work-basis")).json().candidates;
      expect(ownerBasis).toEqual([expect.objectContaining({ title: "M1-B L3 v6", supersededBy: { title: "M2 战略解码 v0.4", url: NEW_URL }, keepUntil: "2026-11-10" })]);

      // 测试甲：切换到新版——依据换成新文档，带上新文档的修订时间。
      const ceoCard = (await get(t, ceo, `/api/requests/${(await inbox(t, ceo))[0].id}/impact`)).json().card;
      expect((await post(t, ceo, `/api/impact-cards/${ceoCard.id}/basis`, { choice: "switch" })).json().card.basisChoice).toMatchObject({ choice: "switch", until: null });
      expect(await t.sql("SELECT doc_ref, title, revised_at, revised_by FROM work_basis WHERE person_id = $1 ORDER BY doc_ref", [CEO])).toEqual([
        { doc_ref: "https://tokenking.feishu.cn/docx/Hidden01", title: "别人的方案", revised_at: null, revised_by: null },
        { doc_ref: NEW_URL, title: "M2 战略解码 v0.4", revised_at: new Date("2026-10-19T02:00:00.000Z"), revised_by: "测试乙" },
      ]);
      // 别人的卡选不了。
      expect((await post(t, author, `/api/impact-cards/${ceoCard.id}/basis`, { choice: "switch" })).statusCode).toBe(404);
    } finally { await t.close(); }
  }, 30_000);

  it("作者确认不了 → 改问旧文档负责人；负责人答已被取代才推卡，答完这次变更收尾", async () => {
    const agent = fakeAgent([{ key: "feishu:OldDocV6", relation: "supersede", reason: "测试丙在群里发过的同类方法" }]);
    const t = await createTestApp({ companyPeopleSeed: PEOPLE_SEED }, undefined, { docChangeAgent: agent });
    try {
      await identities(t);
      // 测试丙以前在群里发过旧文档：没有飞书元数据时按发它的人当负责人。
      await t.sql(`INSERT INTO doc_changes (id, author_id, doc_ref, title, message_id, status, created_at) VALUES ($1, $2, $3, 'M1-B L3 v6', 'om_old', 'unrelated', '2026-09-20T02:00:00Z')`,
        [randomUUID(), OWNER, OLD_URL]);
      await basis(t, CEO, OLD_URL, "M1-B L3 v6");
      await basis(t, CEO, NEW_URL, "飞书文档 · NewDoc04");
      const id = await publish(t, "om_2", `@_user_1 ${NEW_URL}`);
      // 同一个链接有人依据旧版本：直接列为修订候选；没有元数据时标题用兜底标题。
      expect(await t.sql("SELECT key, same_doc, suggested, owner_id FROM doc_change_candidates ORDER BY position")).toEqual([
        { key: "feishu:NewDoc04", same_doc: true, suggested: "revision", owner_id: null },
        { key: "feishu:OldDocV6", same_doc: false, suggested: "supersede", owner_id: OWNER },
      ]);
      expect(agent.inputs[0].pool.map((doc) => doc.key)).toEqual(["feishu:OldDocV6"]);
      expect(agent.inputs[0].pool[0]).toMatchObject({ sharedBy: "测试丙", sharedAt: "2026-09-20" });

      const author = await t.memberCookie();
      const asked = await post(t, author, `/api/doc-changes/${id}/ask-owners`);
      expect(asked.statusCode).toBe(200);
      expect(asked.json().docChange).toMatchObject({ status: "asking_owner", viewer: { canDecide: false, canAskOwners: false } });
      expect(asked.json().docChange.steps.slice(2)).toEqual([
        { label: "确认关系", status: "done", result: "转给负责人" }, { label: "问负责人", status: "current", result: "0/1 已回答" }, { label: "推送影响卡", status: "pending", result: null }]);
      expect((await post(t, author, `/api/doc-changes/${id}/ask-owners`)).statusCode).toBe(409);

      const owner = await cookieOf(t, OWNER, "ceshib");
      const [question] = await inbox(t, owner);
      expect(question).toMatchObject({ kind: "doc_change", title: "你的《M1-B L3 v6》还有效吗", myStatus: "pending" });
      const ownerView = (await get(t, owner, `/api/requests/${question.id}/doc-change`)).json().docChange;
      expect(ownerView).toMatchObject({ viewer: { role: "owner", canDecide: false, ownerKeys: ["feishu:OldDocV6"] } });
      expect(ownerView.candidates.map((item: { key: string }) => item.key)).toEqual(["feishu:OldDocV6"]);
      // 作者不能替负责人答。
      expect((await post(t, author, `/api/doc-changes/${id}/owner-answer`, { key: "feishu:OldDocV6", answer: "superseded" })).statusCode).toBe(404);

      const answered = await post(t, owner, `/api/doc-changes/${id}/owner-answer`, { key: "feishu:OldDocV6", answer: "superseded", effectiveOn: "2026-10-21" });
      expect(answered.statusCode).toBe(200);
      expect(answered.json().docChange).toMatchObject({ status: "confirmed", effectiveOn: "2026-10-21", decidedByName: "测试丙", viewer: { ownerKeys: [] } });
      expect((await post(t, owner, `/api/doc-changes/${id}/owner-answer`, { key: "feishu:OldDocV6", answer: "valid" })).statusCode).toBe(409);
      expect((await inbox(t, owner))[0].myStatus).toBe("done");
      // 依据旧文档的测试甲收到取代卡，写明是负责人确认的。
      const ceo = await t.loginCookie();
      const card = (await get(t, ceo, `/api/requests/${(await inbox(t, ceo))[0].id}/impact`)).json().card;
      expect(card.trigger).toMatchObject({ relation: "supersede", decidedByName: "测试丙", effectiveOn: "2026-10-21" });
      expect(card.why).toContain("旧文档负责人 测试丙确认它取代了《M1-B L3 v6》");
    } finally { await t.close(); }
  }, 30_000);

  it("修订：同一个链接的新版本，卡上「知道了」把依据更新到这一版；都不是的不推送，流程停在确认那一步", async () => {
    const agent = fakeAgent([]);
    const t = await createTestApp({ companyPeopleSeed: PEOPLE_SEED }, undefined, { docChangeAgent: agent });
    try {
      await identities(t);
      await basis(t, CEO, `${NEW_URL}?from=wiki`, "M2 战略解码 v0.3", "2026-10-01T02:00:00.000Z");
      const author = await t.memberCookie();
      const ceo = await t.loginCookie();

      const first = await publish(t, "om_3", `@_user_1 ${NEW_URL}`);
      const none = await post(t, author, `/api/doc-changes/${first}/confirm`, { links: [] });
      expect(none.json().docChange).toMatchObject({ status: "unrelated", pushed: 0 });
      expect(none.json().docChange.steps.slice(2)).toEqual([{ label: "确认关系", status: "done", result: "都不是" }]);
      expect(await inbox(t, ceo)).toEqual([]);

      const second = await publish(t, "om_4", `@_user_1 又改了 ${NEW_URL}`);
      expect((await post(t, author, `/api/doc-changes/${second}/confirm`, { links: [{ key: "feishu:NewDoc04", relation: "revision" }] })).json().docChange.pushed).toBe(1);
      const card = (await get(t, ceo, `/api/requests/${(await inbox(t, ceo))[0].id}/impact`)).json().card;
      expect(card).toMatchObject({ title: "《M2 战略解码 v0.3》出了新版本", trigger: { relation: "revision" },
        impact: expect.stringContaining("你依据的《M2 战略解码 v0.3》有了新版本，测试乙 ") });
      expect(card.impact).toContain("你确认依据时是 10/1 的版本。");
      expect((await post(t, ceo, `/api/impact-cards/${card.id}/basis`, { choice: "keep", until: "2026-11-01", reason: "先不换" })).statusCode).toBe(400);
      expect((await post(t, ceo, `/api/impact-cards/${card.id}/basis`, { choice: "switch" })).statusCode).toBe(200);
      // 同一个链接：依据还是这一行；读不到新文档元数据时标题和修订时间保留，确认时刻更新。
      expect(await t.sql("SELECT doc_ref, title, revised_at, confirmed_at > now() - interval '1 minute' AS fresh FROM work_basis WHERE person_id = $1", [CEO])).toEqual([
        { doc_ref: `${NEW_URL}?from=wiki`, title: "M2 战略解码 v0.3", revised_at: new Date("2026-10-01T02:00:00.000Z"), fresh: true }]);
      // 「和我无关」照常可用（已处理的卡也幂等）。
      expect((await post(t, ceo, `/api/impact-cards/${card.id}/irrelevant`, {})).statusCode).toBe(200);
    } finally { await t.close(); }
  }, 30_000);
});
