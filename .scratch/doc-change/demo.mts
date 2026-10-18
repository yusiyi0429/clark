/** ⑧ 文档变更的本地演示：一次性测试库 + 假的找候选 Agent（不连模型、不连飞书），API 4880，网页另起 3880（API_SERVER_URL=http://127.0.0.1:4880）。
 * 用法（worktree 根目录）：set TEST_PG_URL=postgres://postgres:postgres@localhost:55432/postgres && node apps/api/node_modules/tsx/dist/cli.mjs .scratch/doc-change/demo.mts
 * 账号（只在这个一次性库里）：lium 刘明华（CEO）/ sunm 孙铭泽 / tangj 唐巨杰 / chenx 陈溪南，口令 8742。
 * 场景：孙铭泽在群里发了《M2 战略解码 v0.4》待他确认；《方法总表 v2》已确认取代《五 Method 总表》，唐巨杰、陈溪南收到取代卡；
 *       《渠道复盘模板 v3》作者确认不了，在问唐巨杰。 */
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestApp, testEnv } from "../../apps/api/test/helpers.js";
import { setMemberAccess } from "../../apps/api/src/memberAccess.js";
import type { DocChangeAgent } from "../../apps/api/src/docChangeAgent.js";

const API_PORT = 4880, WEB_PORT = 3880;
testEnv.publicOrigin = `http://localhost:${WEB_PORT}`;
testEnv.extraOrigins = [`http://127.0.0.1:${WEB_PORT}`];
const CEO = "liu-minghua", SUN = "sun-mingze", TANG = "tang-jujie", CHEN = "chen-xinan";
const dir = await mkdtemp(join(tmpdir(), "doc-change-demo-"));
const peopleFile = join(dir, "people.json");
await writeFile(peopleFile, JSON.stringify({ schemaVersion: "company-people.v1", people: [
  { personId: CEO, displayName: "刘明华", roles: ["ceo"] }, { personId: SUN, displayName: "孙铭泽", roles: ["dri", "participant"] },
  { personId: TANG, displayName: "唐巨杰", roles: ["dri", "participant"] }, { personId: CHEN, displayName: "陈溪南", roles: ["dri", "participant"] },
] }));

const doc = (token: string) => `https://tokenking.feishu.cn/docx/${token}`;
// 假 Agent：按标题挑候选、写理由（演示用，真实环境走快模型）。
const REASONS: Record<string, Record<string, [string, "revision" | "supersede"]>> = {
  "M2 战略解码 v0.4": {
    "M1-B L3 v6": ["唐巨杰 9/20 写的同一编号方法，10/9 已并入 M2", "supersede"],
    "M2 战略解码 v0.3": ["同一份方案的上一版，标题只差版本号", "revision"],
    "M1-B 访谈提纲": ["M1-B 的配套提纲，跟着方法一起失效", "supersede"],
  },
  "方法总表 v2": { "五 Method 总表": ["表头还是「五 Method」，新总表收成四套", "supersede"] },
  "渠道复盘模板 v3": { "渠道复盘模板 v2": ["唐巨杰 10/2 在群里发过的上一版模板", "supersede"] },
};
const agent: DocChangeAgent = {
  async findCandidates(input) {
    const reasons = REASONS[input.newDoc.title] ?? {};
    return { candidates: input.pool.flatMap((item) => reasons[item.title] ? [{ key: item.key, relation: reasons[item.title][1], reason: reasons[item.title][0] }] : []) };
  },
};

const t = await createTestApp({ companyPeopleSeed: peopleFile, companyName: "天枢（文档变更演示）" }, undefined, { docChangeAgent: agent });
for (const [personId, loginId] of [[CEO, "lium"], [SUN, "sunm"], [TANG, "tangj"], [CHEN, "chenx"]]) {
  await setMemberAccess(t.sql as never, { personId, loginId, passcode: "8742", mustChange: false });
  await t.sql("INSERT INTO person_onboarding (person_id, completed_at) VALUES ($1, now()) ON CONFLICT DO NOTHING", [personId]);
  await t.sql("INSERT INTO feishu_identities (person_id, open_id, name) VALUES ($1, $2, $3)", [personId, `ou_${loginId}`, loginId]);
}
const basis = (personId: string, token: string, title: string, revisedAt: string | null = null) =>
  t.sql(`INSERT INTO work_basis (id, person_id, doc_kind, doc_ref, title, url, revision, revised_at, revised_by, confirmed_at)
    VALUES ($1, $2, 'feishu_doc', $3, $4, $3, NULL, $5, NULL, now())`, [randomUUID(), personId, doc(token), title, revisedAt]);
const shared = (personId: string, token: string, title: string, at: string) =>
  t.sql(`INSERT INTO doc_changes (id, author_id, doc_ref, title, message_id, status, created_at) VALUES ($1, $2, $3, $4, $5, 'unrelated', $6)`,
    [randomUUID(), personId, doc(token), title, `om_${token}`, at]);
const jobs = t.app.docChanges.jobs();
const publish = async (personId: string, loginId: string, token: string, title: string) => {
  const messageId = `om_${randomUUID()}`;
  await jobs.feishuEvents["im.message.receive_v1"]({ sender: { sender_id: { open_id: `ou_${loginId}` }, sender_type: "user" },
    message: { message_id: messageId, chat_id: "oc_method", chat_type: "group", message_type: "text", content: JSON.stringify({ text: `@_user_1 ${doc(token)}` }), mentions: [{ key: "@_user_1" }] } });
  const id = (await t.sql("SELECT id::text FROM doc_changes WHERE message_id = $1", [messageId]))[0].id as string;
  await t.sql("UPDATE doc_changes SET title = $2 WHERE id = $1", [id, title]);
  await jobs.handlers["doc_change.analyze"]({ docChangeId: id }, { id: "0", kind: "doc_change.analyze", dedupe_key: "", attempts: 1, payload: {} });
  return id;
};

// 依据清单：M1-B 有三人依据；五 Method 总表两人；渠道复盘模板 v2 一人。
await basis(TANG, "M1BL3v6", "M1-B L3 v6", "2026-09-20T02:00:00Z");
await basis(CHEN, "M1BL3v6", "M1-B L3 v6", "2026-09-20T02:00:00Z");
await basis(CEO, "M1BL3v6", "M1-B L3 v6");
await basis(TANG, "M2v03", "M2 战略解码 v0.3", "2026-10-08T02:00:00Z");
await basis(CHEN, "M1BInterview", "M1-B 访谈提纲");
await basis(TANG, "FiveMethod", "五 Method 总表", "2026-09-12T02:00:00Z");
await basis(CHEN, "FiveMethod", "五 Method 总表", "2026-09-12T02:00:00Z");
await basis(CHEN, "ChannelV2", "渠道复盘模板 v2");
await shared(TANG, "ChannelV2", "渠道复盘模板 v2", "2026-10-02T03:00:00Z");

// 1. 孙铭泽发《M2 战略解码 v0.4》：等他确认。
await publish(SUN, "sunm", "M2v04", "M2 战略解码 v0.4");
// 2. 孙铭泽发《方法总表 v2》，确认取代《五 Method 总表》：唐巨杰、陈溪南收到取代卡。
const table = await publish(SUN, "sunm", "MethodTable2", "方法总表 v2");
const tableCandidates = await t.sql("SELECT key FROM doc_change_candidates WHERE doc_change_id = $1", [table]);
await t.app.docChanges.confirm(table, SUN, { links: tableCandidates.map((row) => ({ key: row.key as string, relation: "supersede" as const })),
  effectiveOn: "2026-10-20", transitionUntil: "2026-10-31", keepExisting: true });
// 3. 刘明华发《渠道复盘模板 v3》，确认不了，改问唐巨杰。
const channel = await publish(CEO, "lium", "ChannelV3", "渠道复盘模板 v3");
await t.app.docChanges.askOwners(channel, CEO);

await t.app.listen({ port: API_PORT, host: "127.0.0.1" });
console.log(JSON.stringify({ ready: true, api: API_PORT, web: WEB_PORT }));
const stop = async () => { await t.close(); process.exit(0); };
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
