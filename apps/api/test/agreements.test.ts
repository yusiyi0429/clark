import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { FeishuClient } from "../src/feishu/client.js";
import { FEISHU_NOTIFY_KIND, feishuNotifyJobs } from "../src/feishu/notify.js";
import type { DeliverableReviewAgent, ReviewAgentInput, TReviewCandidate } from "../src/deliverableReview.js";
import type { PlanTask } from "../src/planTasks.js";
import { hashSecret } from "../src/session.js";
import { createTestApp, TEST_CEO, TEST_MEMBER } from "./helpers.js";

const PEOPLE_SEED = fileURLToPath(new URL("./fixtures/company-people-candidate.json", import.meta.url));
const THIRD = { personId: "person-fixture-003", loginId: "ceshib", passcode: "3579" } as const;
const NOW = new Date("2026-10-22T02:00:00.000Z");
const TOKEN = "internal-chat-token-for-agreements";

const baseTasks = (): PlanTask[] => [
  { taskId: "t-plain", missionId: "mine", name: "对话质量达标", doneDefinition: "对话质量过 75 分", criteria: ["有题库打分结果", "有新人上手录屏"] },
  { taskId: "t-world", missionId: "mine", name: "方案定稿", doneDefinition: null, criteria: ["方案定稿", "评审通过"],
    agreement: { proofs: ["评审会纪要", null], acceptorIds: [THIRD.personId, null], exclusions: ["不含上线"] } },
  { taskId: "t-theirs", missionId: "mine", name: "别人负责的", doneDefinition: null, criteria: ["有方案"], responsibleId: THIRD.personId },
  { taskId: "t-definition", missionId: "mine", name: "只有完成定义", doneDefinition: "方案定稿", criteria: [] },
  { taskId: "t-bare", missionId: "mine", name: "什么都没写", doneDefinition: null, criteria: [] },
  { taskId: "t-other", missionId: "other", name: "别人 Mission 的", doneDefinition: null, criteria: ["有方案"] },
];

type Review = { headline: string; summary: string; gain: null; mismatch: null; beyondScope?: string[];
  criteria: { index: number; verdict: "met" | "partial" | "unmet"; reason: string; evidence: string | null; fix: string | null; dissent: { reason: string; upheld: boolean | null } | null }[] };
const met = (index: number, evidence = "方案.md 第 2 段") => ({ index, verdict: "met" as const, reason: "材料里有", evidence, fix: null, dissent: null });
const gap = (index: number, reason = "只有陈述", fix = "补一段录屏") => ({ index, verdict: "partial" as const, reason, evidence: null, fix, dissent: null });

async function fixture(options: { feishu?: boolean } = {}) {
  const storage = await mkdtemp(join(tmpdir(), "agreements-"));
  let now = NOW;
  const tasks = baseTasks();
  const reviews: ReviewAgentInput[] = [];
  let candidate: (input: ReviewAgentInput) => TReviewCandidate = (input) => ({ headline: "都达到了", summary: "看过", gain: null,
    beyondScope: ["下次可以附上评测脚本"], criteria: input.criteria.map(({ index }) => met(index)) });
  const review: DeliverableReviewAgent = { review: async (input) => { reviews.push(input); return candidate(input); } };
  const sent: { type: string; id: string; msgType: string; content: object }[] = [];
  const client = { sendMessage: async (type: string, id: string, msgType: string, content: object) => { sent.push({ type, id, msgType, content }); return { messageId: "om_test" }; } } as unknown as FeishuClient;
  const feishu = options.feishu === false ? {} : { feishu: { appId: "cli_test", appSecret: "test-secret", tokenKey: randomBytes(32), tokenKeyVersion: 1 } };
  const t = await createTestApp({ companyPeopleSeed: PEOPLE_SEED, materialStorageDir: storage, internalChatToken: TOKEN, ...feishu }, undefined, {
    monthlyNow: () => now,
    planTasks: async (missions) => tasks.filter((task) => missions.some((mission) => mission.id === task.missionId)),
    deliverableAgents: { review, note: { write: async () => ({ achieved: "达成", gain: "多了", why: null, lesson: null }) } },
    deliverableFetcher: async () => null,
    feishuClient: client,
  });
  const mission = (id: string, owner: string) => t.sql(`INSERT INTO missions(id,version,code,period,title,owner_id,capability_id,battlefield_ids,outcome,milestones,
    source_ref,source_document_id,source_revision,source_title) VALUES($1,1,$1,'2026-10',$1,$2,'method','["growth"]','目标','[]','fixture://a','fixture',1,'fixture')`, [id, owner]);
  await mission("mine", TEST_MEMBER.personId);
  await mission("other", THIRD.personId);
  await t.sql("INSERT INTO member_access (person_id, login_id, passcode_hash, must_change) VALUES ($1, $2, $3, FALSE)", [THIRD.personId, THIRD.loginId, hashSecret(THIRD.passcode)]);
  const member = await t.memberCookie();
  const ceo = await t.loginCookie();
  const login = await t.app.inject({ method: "POST", url: "/api/auth/login", headers: { origin: t.publicOrigin }, payload: { loginId: THIRD.loginId, passcode: THIRD.passcode } });
  const third = (login.headers["set-cookie"] as string).split(";")[0];
  const call = (method: "GET" | "PUT" | "POST", url: string, payload?: unknown, cookie = member) =>
    t.app.inject({ method, url, headers: { cookie, origin: t.publicOrigin }, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });
  const put = (taskId: string, body: unknown, cookie = member) => call("PUT", `/api/plan-tasks/${taskId}/agreement`, body, cookie);
  const check = async (taskId: string, cookie = member) => { const res = await call("GET", `/api/plan-tasks/${taskId}/check`, undefined, cookie); expect(res.statusCode).toBe(200); return res.json(); };
  /** 直接落一版交付物和它的评审（对表不调模型，只看库里的报告）。 */
  const seedVersion = async (taskId: string, number: number, status: "queued" | "running" | "done" | "failed", criteria: string[], review: Review | null,
    items: [string, "file" | "link"][] = [["方案.md", "file"]]) => {
    const id = randomUUID();
    await t.sql(`INSERT INTO deliverable_versions(id,task_id,mission_id,author_id,number,task_name,basis,criteria,review_status,review,review_run_token,review_started_at)
      VALUES($1,$2,'mine',$3,$4,'x','acceptance',$5::jsonb,$6,$7::jsonb,$8,$9)`,
    [id, taskId, TEST_MEMBER.personId, number, JSON.stringify(criteria), status, review ? JSON.stringify(review) : null, status === "running" ? randomUUID() : null, now]);
    for (const [position, [name, kind]] of items.entries())
      await t.sql(`INSERT INTO deliverable_items(id,version_id,position,kind,name,storage_key,url,read) VALUES($1,$2,$3,$4,$5,$6,$7,'read')`,
        [randomUUID(), id, position, kind, name, kind === "file" ? `deliverables/${id}/x` : null, kind === "link" ? name : null]);
    return id;
  };
  return { t, call, put, check, seedVersion, member, ceo, third, tasks, reviews, sent, client, setCandidate: (impl: typeof candidate) => { candidate = impl; },
    setNow: (value: Date) => { now = value; }, close: async () => { await t.close(); await rm(storage, { recursive: true, force: true }); } };
}

describe("约定：读的顺序", () => {
  it("两样都没有只给标准原文；存了 11 月补充以后来自天枢、留修改记录；本体里有约定就用本体的；没有标准时为空", async () => {
    const f = await fixture();
    try {
      const empty = (await f.call("GET", "/api/plan-tasks/t-plain/agreement")).json();
      expect(empty).toEqual({ taskId: "t-plain", taskName: "对话质量达标", missionId: "mine", basis: "acceptance", source: "none",
        criteria: [{ index: 1, text: "有题库打分结果", proof: null, acceptor: null }, { index: 2, text: "有新人上手录屏", proof: null, acceptor: null }],
        exclusions: [], complete: false, basisChanged: false, canEdit: true, updatedBy: null, updatedAt: null });

      const saved = await f.put("t-plain", { criteria: [{ index: 1, proof: "  题库评测报告  ", acceptorId: THIRD.personId }, { index: 2, proof: "3 分钟录屏", acceptorId: null }],
        exclusions: ["不含线上 A/B", " 不含线上 A/B ", "不改题库"] });
      expect(saved.statusCode).toBe(200);
      expect(saved.json()).toMatchObject({ source: "tianshu", complete: true, basisChanged: false, canEdit: true, exclusions: ["不含线上 A/B", "不改题库"],
        criteria: [{ index: 1, proof: "题库评测报告", acceptor: { personId: THIRD.personId } }, { index: 2, proof: "3 分钟录屏", acceptor: null }],
        updatedBy: { personId: TEST_MEMBER.personId }, updatedAt: NOW.toISOString() });
      // 只写了第 1 条：第 2 条算没写，约定没补全；每存一次留一份修改记录。
      expect((await f.put("t-plain", { criteria: [{ index: 1, proof: "题库评测报告", acceptorId: null }], exclusions: [] })).json())
        .toMatchObject({ complete: false, criteria: [{ proof: "题库评测报告", acceptor: null }, { proof: null, acceptor: null }] });
      expect(await f.t.sql("SELECT revision, updated_by FROM task_agreement_note_revisions WHERE task_id='t-plain' ORDER BY revision")).toEqual([
        { revision: 1, updated_by: TEST_MEMBER.personId }, { revision: 2, updated_by: TEST_MEMBER.personId }]);
      expect((await f.t.sql("SELECT revision FROM task_agreement_notes WHERE task_id='t-plain'"))[0].revision).toBe(2);

      // 本体 definition 块里有约定：用本体的，天枢的补充不再读，也不能在天枢里改。
      const world = (await f.call("GET", "/api/plan-tasks/t-world/agreement")).json();
      expect(world).toMatchObject({ source: "world", canEdit: false, complete: false, exclusions: ["不含上线"],
        criteria: [{ index: 1, text: "方案定稿", proof: "评审会纪要", acceptor: { personId: THIRD.personId } }, { index: 2, text: "评审通过", proof: null, acceptor: null }] });
      const blocked = await f.put("t-world", { criteria: [], exclusions: [] });
      expect([blocked.statusCode, blocked.json().code]).toEqual([409, "AGREEMENT_FROM_WORLD"]);

      // 没有验收标准按完成定义算一条；两样都没有就没有约定可写。
      expect((await f.call("GET", "/api/plan-tasks/t-definition/agreement")).json()).toMatchObject({ basis: "definition", criteria: [{ index: 1, text: "方案定稿" }] });
      expect((await f.call("GET", "/api/plan-tasks/t-bare/agreement")).json()).toMatchObject({ basis: "none", source: "none", criteria: [], canEdit: false });
      const bare = await f.put("t-bare", { criteria: [], exclusions: [] });
      expect([bare.statusCode, bare.json().code]).toEqual([409, "NO_CRITERIA"]);
    } finally { await f.close(); }
  });

  it("本体里的标准改了：约定标「标准改过」，补充按原文对回去；序号越界、认可人不在名单被拦下", async () => {
    const f = await fixture();
    try {
      await f.put("t-plain", { criteria: [{ index: 1, proof: "题库评测报告", acceptorId: null }, { index: 2, proof: "录屏", acceptorId: null }], exclusions: [] });
      // 前面插了一条新的、原来第 1 条补了几个字：原文一样的、补了字的都对回去，新插的那条算没写。
      f.tasks[0].criteria = ["新加的一条", "有新人上手录屏", "有题库打分结果（总分 75）"];
      const changed = (await f.call("GET", "/api/plan-tasks/t-plain/agreement")).json();
      expect(changed).toMatchObject({ source: "tianshu", basisChanged: true, complete: false });
      expect(changed.criteria.map((item: { proof: string | null }) => item.proof)).toEqual([null, "录屏", "题库评测报告"]);
      // 同一个序号上整条改写了：按序号认回去，仍标「标准改过」。
      f.tasks[0].criteria = ["题库总分 75 且无否决项", "有新人上手录屏"];
      expect((await f.call("GET", "/api/plan-tasks/t-plain/agreement")).json()).toMatchObject({ basisChanged: true,
        criteria: [{ proof: "题库评测报告" }, { proof: "录屏" }] });

      const outOfRange = await f.put("t-plain", { criteria: [{ index: 3, proof: "x", acceptorId: null }], exclusions: [] });
      expect([outOfRange.statusCode, outOfRange.json().code]).toEqual([400, "INVALID_INPUT"]);
      const twice = await f.put("t-plain", { criteria: [{ index: 1, proof: "x", acceptorId: null }, { index: 1, proof: "y", acceptorId: null }], exclusions: [] });
      expect(twice.statusCode).toBe(400);
      const stranger = await f.put("t-plain", { criteria: [{ index: 1, proof: "x", acceptorId: "nobody" }], exclusions: [] });
      expect([stranger.statusCode, stranger.json().code]).toEqual([400, "UNKNOWN_PERSON"]);
      // 存一次以后摘要对上了，不再提示。
      expect((await f.put("t-plain", { criteria: [{ index: 1, proof: "x", acceptorId: null }], exclusions: [] })).json().basisChanged).toBe(false);
    } finally { await f.close(); }
  });
});

describe("约定和交付物的权限", () => {
  it("负责人、Mission 负责人能改；CEO、战场负责人、认可人只读；无关的人找不到；交付物只有负责人能传", async () => {
    const f = await fixture();
    try {
      // 别人负责的 Task：负责人（测试丙）和 Mission 负责人（测试乙）都能改约定，只有负责人能传版本。
      expect((await f.put("t-theirs", { criteria: [{ index: 1, proof: "方案文档", acceptorId: null }], exclusions: [] }, f.third)).statusCode).toBe(200);
      expect((await f.put("t-theirs", { criteria: [{ index: 1, proof: "方案文档 v2", acceptorId: null }], exclusions: [] })).statusCode).toBe(200);
      const uploadAs = (cookie: string, taskId = "t-theirs") => f.t.app.inject({ method: "POST", url: `/api/plan-tasks/${taskId}/deliverable/versions`,
        headers: { cookie, origin: f.t.publicOrigin, "content-type": "multipart/form-data; boundary=b" },
        payload: Buffer.from(`--b\r\nContent-Disposition: form-data; name="statement"\r\n\r\n交一版\r\n--b--\r\n`) });
      expect((await uploadAs(f.third)).statusCode).toBe(201);
      expect((await uploadAs(f.member)).statusCode).toBe(403);
      await f.t.app.deliverables.idle();

      // CEO：约定、对表、交付物都能读，不能改、不能请人看。
      expect((await f.call("GET", "/api/plan-tasks/t-plain/agreement", undefined, f.ceo)).json()).toMatchObject({ canEdit: false });
      expect((await f.put("t-plain", { criteria: [], exclusions: [] }, f.ceo)).statusCode).toBe(403);
      expect((await f.check("t-plain", f.ceo)).canNotify).toBe(false);
      expect((await f.call("GET", "/api/plan-tasks/t-theirs/deliverable", undefined, f.ceo)).json()).toMatchObject({ canEdit: false, versions: [{ number: 1 }] });

      // 测试丙和测试乙的 Mission 无关：t-plain 找不到；成了约定里的认可人以后能读约定、对表和交付物，仍不能改、不能传。
      expect((await f.call("GET", "/api/plan-tasks/t-plain/agreement", undefined, f.third)).statusCode).toBe(404);
      expect((await f.call("GET", "/api/plan-tasks/t-plain/check", undefined, f.third)).statusCode).toBe(404);
      expect((await f.call("GET", "/api/plan-tasks/t-plain/deliverable", undefined, f.third)).statusCode).toBe(404);
      await f.put("t-plain", { criteria: [{ index: 1, proof: "题库评测报告", acceptorId: THIRD.personId }], exclusions: [] });
      const versionId = await f.seedVersion("t-plain", 1, "done", ["有题库打分结果", "有新人上手录屏"], { headline: "h", summary: "s", gain: null, mismatch: null, criteria: [met(1), gap(2)] });
      expect((await f.call("GET", "/api/plan-tasks/t-plain/agreement", undefined, f.third)).json()).toMatchObject({ canEdit: false });
      expect((await f.check("t-plain", f.third)).canNotify).toBe(false);
      const readable = await f.call("GET", "/api/plan-tasks/t-plain/deliverable", undefined, f.third);
      expect(readable.json()).toMatchObject({ canEdit: false, versions: [{ id: versionId }] });
      expect((await f.put("t-plain", { criteria: [], exclusions: [] }, f.third)).statusCode).toBe(403);
      expect((await uploadAs(f.third, "t-plain")).statusCode).toBe(403);

      // 战场负责人：Mission 挂的战场由他负责，能读不能改。
      expect((await f.call("GET", "/api/plan-tasks/t-definition/agreement", undefined, f.third)).statusCode).toBe(404);
      await f.t.sql("UPDATE battlefield_config SET owner_id=$1 WHERE id='growth'", [THIRD.personId]);
      expect((await f.call("GET", "/api/plan-tasks/t-definition/agreement", undefined, f.third)).json()).toMatchObject({ canEdit: false });
      expect((await f.put("t-definition", { criteria: [], exclusions: [] }, f.third)).statusCode).toBe(403);
      expect((await f.call("GET", "/api/plan-tasks/t-definition/deliverable", undefined, f.third)).json()).toMatchObject({ canEdit: false });
    } finally { await f.close(); }
  });
});

describe("对表", () => {
  const CRITERIA = ["有题库打分结果", "有新人上手录屏"];
  const review = (criteria: Review["criteria"], beyondScope: string[] = []): Review => ({ headline: "h", summary: "s", gain: null, mismatch: null, beyondScope, criteria });
  type Case = { name: string; agreement?: { proof: string | null; acceptorId: string | null }[]; version?: { status: "running" | "done" | "failed"; review: Review | null; criteria?: string[];
    items?: [string, "file" | "link"][] }; statuses: string[]; verdict: "ready" | "not_ready"; conclusion: string; notices: string[] };
  const proofs = [{ proof: "题库评测报告", acceptorId: null }, { proof: "录屏", acceptorId: null }];
  const cases: Case[] = [
    { name: "一版都没交", agreement: proofs, statuses: ["no_deliverable", "no_deliverable"], verdict: "not_ready", conclusion: "还不能交：还没交付物。", notices: [] },
    { name: "最新一版在评", agreement: proofs, version: { status: "running", review: null }, statuses: ["reviewing", "reviewing"], verdict: "not_ready",
      conclusion: "还不能交：第 1 版还在评审，评完再对表。", notices: [] },
    { name: "评审失败：都标评审中", agreement: proofs, version: { status: "failed", review: null }, statuses: ["reviewing", "reviewing"], verdict: "not_ready",
      conclusion: "还不能交：第 1 版的评审没做完，重评以后再对表。", notices: [] },
    { name: "一条差", agreement: proofs, version: { status: "done", review: review([met(1), gap(2, "只有陈述", "补一段 3 分钟录屏")]) }, statuses: ["evidenced", "gap"],
      verdict: "not_ready", conclusion: "还不能交：差第 2 条（只有陈述）。", notices: [] },
    { name: "都有证据、没写认可人", agreement: proofs, version: { status: "done", review: review([met(1), met(2)]) }, statuses: ["evidenced", "evidenced"],
      verdict: "ready", conclusion: "约定的 2 条都有证据了，可以交。再改要重新谈范围。", notices: [] },
    { name: "都有证据、认可人是负责人本人：不用别人确认", agreement: [{ proof: "题库评测报告", acceptorId: TEST_MEMBER.personId }, proofs[1]],
      version: { status: "done", review: review([met(1), met(2)]) }, statuses: ["evidenced", "evidenced"], verdict: "ready", conclusion: "约定的 2 条都有证据了，可以交。再改要重新谈范围。", notices: [] },
    { name: "都有证据、第 1 条由别人认", agreement: [{ proof: "题库评测报告", acceptorId: THIRD.personId }, proofs[1]],
      version: { status: "done", review: review([met(1), met(2)]) }, statuses: ["needs_acceptor", "evidenced"], verdict: "ready",
      conclusion: "约定的 2 条都有证据了，可以交。交之前请测试丙确认第 1 条。再改要重新谈范围。", notices: [] },
    { name: "约定没补全：照常对表，前面提示一句", agreement: [proofs[0]], version: { status: "done", review: review([met(1), met(2)]) }, statuses: ["evidenced", "evidenced"],
      verdict: "ready", conclusion: "约定的 2 条都有证据了，可以交。再改要重新谈范围。", notices: ["agreement_incomplete"] },
    { name: "一条在重评：其余照报告", agreement: proofs, version: { status: "running", review: review([met(1), { ...gap(2), dissent: { reason: "见附件", upheld: null } }]) },
      statuses: ["evidenced", "reviewing"], verdict: "not_ready", conclusion: "还不能交：差第 2 条（评审中）。", notices: [] },
    { name: "最新一版按改之前的标准评的：改了字的那条算差", agreement: proofs,
      version: { status: "done", review: review([met(1), met(2)]), criteria: ["有题库打分结果", "有新人上手录屏（旧）"] }, statuses: ["evidenced", "gap"], verdict: "not_ready",
      conclusion: "还不能交：差第 2 条（标准改过，没按它评）。", notices: ["basis_changed"] },
  ];
  it.each(cases)("$name", async (c) => {
    const f = await fixture();
    try {
      if (c.agreement) await f.put("t-plain", { criteria: c.agreement.map((item, index) => ({ index: index + 1, ...item })), exclusions: [] });
      if (c.version) await f.seedVersion("t-plain", 1, c.version.status, c.version.criteria ?? CRITERIA, c.version.review, c.version.items);
      const result = await f.check("t-plain");
      expect(result.criteria.map((item: { status: string }) => item.status)).toEqual(c.statuses);
      expect(result.verdict).toBe(c.verdict);
      expect(result.conclusion).toBe(c.conclusion);
      expect(result.notices.map((item: { code: string }) => item.code)).toEqual(c.notices);
      expect(result.source).toBe("tianshu");
      expect(result.canNotify).toBe(true);
    } finally { await f.close(); }
  });

  it("带出来的东西：有证据的第几版、哪份材料、定位；差的写 fix；评审的「下次可以做」单独附在后面；标准改过和没补约定的提示原话", async () => {
    const f = await fixture();
    try {
      const none = await f.check("t-plain");
      expect(none).toMatchObject({ source: "none", version: null, beyondScope: [], notices: [{ code: "agreement_incomplete", text: "约定还没补：每条用什么证明都还没写。" }] });
      await f.put("t-plain", { criteria: [{ index: 1, proof: "题库评测报告", acceptorId: null }], exclusions: [] });
      const versionId = await f.seedVersion("t-plain", 2, "done", ["有题库打分结果", "有新人上手录屏"],
        review([met(1, "评测报告.pdf 第 3 页"), gap(2, "只有陈述", "补一段 3 分钟录屏")], ["下次附上评测脚本"]), [["方案.md", "file"], ["评测报告.pdf", "file"], ["https://example.com/x", "link"]]);
      const result = await f.check("t-plain");
      expect(result.version).toEqual({ id: versionId, number: 2, reviewStatus: "done", deliveredAt: null });
      expect(result.criteria[0]).toMatchObject({ status: "evidenced", proof: "题库评测报告", gap: null, notifiedToday: false,
        evidence: { versionId, versionNumber: 2, locator: "评测报告.pdf 第 3 页", items: [{ kind: "file", name: "评测报告.pdf", url: null }] } });
      expect(result.criteria[1]).toMatchObject({ status: "gap", evidence: null, gap: "补一段 3 分钟录屏" });
      expect(result.beyondScope).toEqual(["下次附上评测脚本"]);
      expect(result.notices).toEqual([{ code: "agreement_incomplete", text: "约定还没补全：第 2 条没写用什么证明。" }]);
      f.tasks[0].criteria = ["有题库打分结果", "有新人上手录屏", "第三条"];
      expect((await f.check("t-plain")).notices[0]).toEqual({ code: "basis_changed", text: "标准改过：约定和最新一版的评审都是按改之前的标准来的。" });
      // 只有一份材料时，评审没点名也认它。
      await f.seedVersion("t-plain", 3, "done", ["有题库打分结果", "有新人上手录屏", "第三条"], review([met(1, "第 3 页"), met(2), met(3)]), [["报告.pdf", "file"]]);
      expect((await f.check("t-plain")).criteria[0].evidence.items).toMatchObject([{ name: "报告.pdf" }]);
      expect((await f.check("t-bare"))).toMatchObject({ verdict: "not_ready", conclusion: "还不能交：这个 Task 没有可对照的标准。", criteria: [] });
    } finally { await f.close(); }
  });
});

describe("请 X 看", () => {
  it("推飞书私聊（打桩，不发真消息）：同一条一天一次，第二天能再推；只有负责人能推；人不对、还没证据、飞书没接都拦下", async () => {
    const f = await fixture();
    try {
      await f.put("t-plain", { criteria: [{ index: 1, proof: "题库评测报告", acceptorId: THIRD.personId }, { index: 2, proof: "录屏", acceptorId: THIRD.personId }], exclusions: [] });
      await f.seedVersion("t-plain", 4, "done", ["有题库打分结果", "有新人上手录屏"], { headline: "h", summary: "s", gain: null, mismatch: null,
        criteria: [met(1, "评测报告.pdf 第 3 页"), gap(2)] });
      const notify = (body: unknown, cookie = f.member) => f.call("POST", "/api/plan-tasks/t-plain/check/notify", body, cookie);
      const unlinked = await notify({ index: 1, personId: THIRD.personId });
      expect([unlinked.statusCode, unlinked.json()]).toMatchObject([409, { code: "ACCEPTOR_NOT_ON_FEISHU", message: "测试丙还没关联飞书，推不了" }]);
      await f.t.sql("INSERT INTO feishu_identities (person_id, open_id, name) VALUES ($1, 'ou_third', '测试丙')", [THIRD.personId]);
      const first = await notify({ index: 1, personId: THIRD.personId });
      expect(first.json()).toEqual({ status: "sent" });
      expect((await notify({ index: 1, personId: THIRD.personId })).json()).toEqual({ status: "already_sent" });
      expect((await f.check("t-plain")).criteria[0].notifiedToday).toBe(true);
      const jobs = await f.t.sql("SELECT kind, dedupe_key, payload FROM jobs WHERE kind=$1", [FEISHU_NOTIFY_KIND]);
      expect(jobs).toHaveLength(1);
      expect(jobs[0].dedupe_key).toBe(`${FEISHU_NOTIFY_KIND}:task-check:t-plain:1:${THIRD.personId}:2026-10-22`);
      expect(jobs[0].payload).toEqual({ personId: THIRD.personId, title: "请看「对话质量达标」第 1 条",
        body: "测试乙的 Task「对话质量达标」第 1 条约定由你来认：有题库打分结果\n交付物第 4 版，证据在 评测报告.pdf 第 3 页。",
        links: [{ label: "打开 Task", path: "/me?planTask=t-plain" }] });
      // 队列里那一条由 feishu/notify.ts 发出：这里用打桩的飞书客户端跑一遍，看收件人和跳回 Task 的链接。
      await feishuNotifyJobs({ pool: f.t.pool, client: f.client, publicOrigin: f.t.publicOrigin })[FEISHU_NOTIFY_KIND](jobs[0].payload, jobs[0] as never);
      expect(f.sent).toHaveLength(1);
      expect(f.sent[0]).toMatchObject({ type: "open_id", id: "ou_third", msgType: "interactive" });
      expect(JSON.stringify(f.sent[0].content)).toContain(encodeURIComponent("/me?planTask=t-plain"));

      f.setNow(new Date("2026-10-23T02:00:00.000Z"));
      expect((await f.check("t-plain")).criteria[0].notifiedToday).toBe(false);
      expect((await notify({ index: 1, personId: THIRD.personId })).json()).toEqual({ status: "sent" });

      const codeOf = async (body: unknown, cookie = f.member) => { const res = await notify(body, cookie); return [res.statusCode, res.json().code]; };
      expect(await codeOf({ index: 1, personId: TEST_CEO.personId })).toEqual([400, "NOT_ACCEPTOR"]);
      expect(await codeOf({ index: 2, personId: THIRD.personId })).toEqual([409, "NOT_AWAITING_ACCEPTOR"]);
      expect(await codeOf({ index: 9, personId: THIRD.personId })).toEqual([404, "NOT_FOUND"]);
      expect(await codeOf({ index: 1, personId: THIRD.personId }, f.ceo)).toEqual([403, "FORBIDDEN"]);
      expect(await codeOf({ index: 1, personId: THIRD.personId }, f.third)).toEqual([403, "FORBIDDEN"]);
    } finally { await f.close(); }
    const off = await fixture({ feishu: false });
    try {
      await off.put("t-plain", { criteria: [{ index: 1, proof: "题库评测报告", acceptorId: THIRD.personId }], exclusions: [] });
      await off.seedVersion("t-plain", 1, "done", ["有题库打分结果", "有新人上手录屏"], { headline: "h", summary: "s", gain: null, mismatch: null, criteria: [met(1), met(2)] });
      const res = await off.call("POST", "/api/plan-tasks/t-plain/check/notify", { index: 1, personId: THIRD.personId });
      expect([res.statusCode, res.json().code]).toEqual([503, "FEISHU_NOT_CONFIGURED"]);
      expect(await off.t.sql("SELECT 1 FROM jobs WHERE kind=$1", [FEISHU_NOTIFY_KIND])).toEqual([]);
    } finally { await off.close(); }
  });
});

describe("参考评审按约定判", () => {
  it("传版本时存下约定快照：评审输入每条带用什么证明、这次不包括什么；输出的 beyondScope 存进报告、读回和对表都带着", async () => {
    const f = await fixture();
    try {
      await f.put("t-plain", { criteria: [{ index: 1, proof: "题库评测报告", acceptorId: null }], exclusions: ["不含线上 A/B"] });
      const upload = await f.t.app.inject({ method: "POST", url: "/api/plan-tasks/t-plain/deliverable/versions",
        headers: { cookie: f.member, origin: f.t.publicOrigin, "content-type": "multipart/form-data; boundary=b" },
        payload: Buffer.from(`--b\r\nContent-Disposition: form-data; name="statement"\r\n\r\n两条都做了\r\n--b--\r\n`) });
      expect(upload.statusCode).toBe(201);
      await f.t.app.deliverables.idle();
      expect(f.reviews[0].criteria).toEqual([{ index: 1, text: "有题库打分结果", proof: "题库评测报告" }, { index: 2, text: "有新人上手录屏" }]);
      expect(f.reviews[0].exclusions).toEqual(["不含线上 A/B"]);
      expect((await f.t.sql("SELECT agreement FROM deliverable_versions WHERE task_id='t-plain'"))[0].agreement).toEqual({ proofs: ["题库评测报告", null], exclusions: ["不含线上 A/B"] });
      const read = (await f.call("GET", "/api/plan-tasks/t-plain/deliverable")).json();
      expect(read.versions[0].review).toMatchObject({ status: "done", beyondScope: ["下次可以附上评测脚本"] });
      expect((await f.check("t-plain")).beyondScope).toEqual(["下次可以附上评测脚本"]);

      // 没写约定的 Task：评审照标准原文判，不带 proof、exclusions；版本上没有快照。
      await f.t.app.inject({ method: "POST", url: "/api/plan-tasks/t-definition/deliverable/versions",
        headers: { cookie: f.member, origin: f.t.publicOrigin, "content-type": "multipart/form-data; boundary=b" },
        payload: Buffer.from(`--b\r\nContent-Disposition: form-data; name="statement"\r\n\r\n定稿了\r\n--b--\r\n`) });
      await f.t.app.deliverables.idle();
      expect(f.reviews[1].criteria).toEqual([{ index: 1, text: "方案定稿" }]);
      expect(f.reviews[1]).not.toHaveProperty("exclusions");
      expect((await f.t.sql("SELECT agreement FROM deliverable_versions WHERE task_id='t-definition'"))[0].agreement).toBeNull();
      // 旧报告（没有 beyondScope）读成空的。
      await f.t.sql("UPDATE deliverable_versions SET review = review - 'beyondScope' WHERE task_id='t-definition'");
      expect((await f.call("GET", "/api/plan-tasks/t-definition/deliverable")).json().versions[0].review.beyondScope).toEqual([]);
    } finally { await f.close(); }
  });
});

describe("给伙伴的内部接口", () => {
  it("/internal/plan-tasks/:taskId/agreement、/check：服务凭据加本人，和网页同一份；看不到的 404", async () => {
    const f = await fixture();
    try {
      await f.put("t-plain", { criteria: [{ index: 1, proof: "题库评测报告", acceptorId: null }], exclusions: [] });
      const internal = (path: string, owner: string, role: "member" | "ceo", token = TOKEN) => f.t.app.inject({ method: "GET", url: path,
        headers: { authorization: `Bearer ${token}`, "x-owner-id": owner, "x-viewer-role": role } });
      const agreement = await internal("/internal/plan-tasks/t-plain/agreement", TEST_MEMBER.personId, "member");
      expect(agreement.json()).toEqual((await f.call("GET", "/api/plan-tasks/t-plain/agreement")).json());
      const check = await internal("/internal/plan-tasks/t-plain/check", TEST_CEO.personId, "ceo");
      expect(check.json()).toMatchObject({ taskId: "t-plain", verdict: "not_ready", conclusion: "还不能交：还没交付物。", canNotify: false });
      const hidden = await internal("/internal/plan-tasks/t-plain/check", THIRD.personId, "member");
      expect([hidden.statusCode, hidden.json().code]).toEqual([404, "NOT_FOUND"]);
      expect((await internal("/internal/plan-tasks/t-plain/check", TEST_MEMBER.personId, "member", "wrong")).statusCode).toBe(401);
    } finally { await f.close(); }
  });
});

describe("MCP：get_task_agreement、check_task、add_deliverable_version", () => {
  it("读的两个和网页同一份；交版本沿用上一版材料再加链接、自动评审；只有负责人能交", async () => {
    const f = await fixture();
    try {
      const tokenOf = async (cookie: string) => (await f.call("POST", "/api/me/tokens", { name: "Claude", client: "claude", expiresInDays: 30 }, cookie)).json().token as string;
      const [member, ceo] = [await tokenOf(f.member), await tokenOf(f.ceo)];
      const invoke = async (token: string, name: string, args: Record<string, unknown>) => {
        const res = (await f.t.app.inject({ method: "POST", url: "/mcp/me", headers: { authorization: `Bearer ${token}`, accept: "application/json, text/event-stream" },
          payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } } })).json().result;
        return { isError: res.isError as boolean, value: JSON.parse(res.content[0].text) };
      };
      await f.put("t-plain", { criteria: [{ index: 1, proof: "题库评测报告", acceptorId: null }], exclusions: [] });
      expect((await invoke(member, "get_task_agreement", { taskId: "t-plain" })).value).toEqual((await f.call("GET", "/api/plan-tasks/t-plain/agreement")).json());
      expect((await invoke(ceo, "check_task", { taskId: "t-plain" })).value).toMatchObject({ verdict: "not_ready", conclusion: "还不能交：还没交付物。", canNotify: false });

      // 网页先传了一份文件；从 Claude Code 再交一版链接：文件沿用，链接加上，评审照约定判。
      const web = await f.t.app.inject({ method: "POST", url: "/api/plan-tasks/t-plain/deliverable/versions",
        headers: { cookie: f.member, origin: f.t.publicOrigin, "content-type": "multipart/form-data; boundary=b" },
        payload: Buffer.from(`--b\r\nContent-Disposition: form-data; name="files"; filename="方案.md"\r\nContent-Type: text/markdown\r\n\r\n# 方案\r\n--b--\r\n`) });
      expect(web.statusCode).toBe(201);
      await f.t.app.deliverables.idle();
      const added = await invoke(member, "add_deliverable_version", { taskId: "t-plain", links: ["https://example.com/pr/1"], note: "补上 PR" });
      expect(added.isError).toBe(false);
      expect(added.value).toMatchObject({ number: 2, review: "queued", items: [{ kind: "file", name: "方案.md" }, { kind: "link", url: "https://example.com/pr/1" }],
        href: `${f.t.publicOrigin}/me?planTask=t-plain` });
      await f.t.app.deliverables.idle();
      expect(f.reviews.at(-1)).toMatchObject({ criteria: [{ index: 1, proof: "题库评测报告" }, { index: 2 }], version: { statement: "补上 PR" } });
      // 同一个链接再交一次不重复放。
      const again = await invoke(member, "add_deliverable_version", { taskId: "t-plain", links: ["https://example.com/pr/1"] });
      expect(again.value.items.map((item: { kind: string }) => item.kind)).toEqual(["file", "link"]);
      await f.t.app.deliverables.idle();
      expect((await invoke(member, "check_task", { taskId: "t-plain" })).value).toMatchObject({ verdict: "ready", version: { number: 3 } });

      expect((await invoke(ceo, "add_deliverable_version", { taskId: "t-plain", links: ["https://example.com/a"] })).value).toMatchObject({ code: "FORBIDDEN" });
      expect((await invoke(member, "add_deliverable_version", { taskId: "t-other", links: ["https://example.com/a"] })).value).toMatchObject({ code: "NOT_FOUND" });
      expect((await invoke(member, "add_deliverable_version", { taskId: "t-plain", links: ["ftp://example.com/a"] })).value).toMatchObject({ code: "INVALID_INPUT" });
      expect((await invoke(member, "check_task", { taskId: "t-other" })).value).toMatchObject({ code: "NOT_FOUND" });
    } finally { await f.close(); }
  });
});
