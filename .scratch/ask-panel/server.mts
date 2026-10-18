/**
 * 「Agent 提问 → 弹窗作答 → 继续」的浏览器验收环境：API 4600（55432 上的一次性测试库）。网页另起：apps/web 的 next dev -p 3600，API_SERVER_URL=http://127.0.0.1:4600。
 * 对话运行时走真实网关：只从主仓库 apps/api/.env 读 PI_BASE_URL / PI_API_KEY / HEAVY_MODEL / COMPACTION_MODEL / CONVERSATION_MODEL（经环境变量，不打印）。
 * 身份：测试甲 ceshij / 2468（CEO），测试乙 ceshiy / 1357（成员，9 月个人复盘是草稿）。Ctrl+C 关掉时删库。
 */
import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";

process.env.TEST_PG_URL ??= "postgres://postgres:postgres@localhost:55432/postgres";
const GATEWAY = /^(PI_BASE_URL|PI_API_KEY|HEAVY_MODEL|LIGHT_MODEL|COMPACTION_MODEL|CONVERSATION_MODEL)$/;
const apiEnv = parseEnv(await readFile(new URL("../../../../../apps/api/.env", import.meta.url), "utf8"));
for (const [key, value] of Object.entries(apiEnv)) if (GATEWAY.test(key) && value) process.env[key] = value;
for (const key of ["PI_BASE_URL", "PI_API_KEY", "HEAVY_MODEL", "COMPACTION_MODEL"]) if (!process.env[key]) throw new Error(`缺少 ${key}`);

const { createTestApp, testEnv, TEST_CEO, TEST_MEMBER } = await import("../../apps/api/test/helpers.ts");
const { createPiConversationRuntime } = await import("../../apps/api/src/piConversationRuntime.ts");
const { conversationTierModels } = await import("../../apps/api/src/conversationModel.ts");
const { loadCompanyMemory } = await import("../../apps/api/src/companyMemory.ts");
const { recordsOf } = await import("../../apps/api/test/personalReviewFixtures.ts");

const WEB = Number(process.env.ASK_WEB_PORT ?? 3600), API = Number(process.env.ASK_API_PORT ?? 4600);
testEnv.publicOrigin = `http://localhost:${WEB}`;
testEnv.extraOrigins = [`http://127.0.0.1:${WEB}`];
const tierModels = conversationTierModels({ defaultModel: process.env.HEAVY_MODEL!, conversationModel: process.env.CONVERSATION_MODEL });
const runtime = await createPiConversationRuntime({ companyMemory: loadCompanyMemory(testEnv), baseUrl: process.env.PI_BASE_URL!, apiKey: process.env.PI_API_KEY!,
  modelId: tierModels.quick, tierModels, compactionModelId: process.env.COMPACTION_MODEL });
const NOW = new Date("2026-10-01T02:00:00Z");
const t = await createTestApp({}, runtime, {
  monthlyNow: () => NOW, monthlyReviewRetryDelayMs: 0,
  monthlyReviewAgents: {
    draft: { async generate() { throw new Error("不起草复盘项"); } },
    assess: { async generate() { return { candidate: { overall: "", deviations: [], questions: [] } }; } },
    summarize: { async generate() { return { candidate: {} }; } },
    // 9 月个人复盘的草稿（一次性库里的演示内容）：每句挂 Mission 卡的出处。
    personal: { async generate(input) {
      const first = recordsOf(input)[0];
      const cite = first ? `[${first.label}](${first.cite})` : "";
      const sources = first ? [first.cite.replace(/^cite:/, "")] : [];
      return { candidate: {
        overall: { text: `渠道试点签下 2 家，目标 3 家，差 1 家${cite}。试点客户的首月留存 82%，高于预期${cite}。${input.missingRecords.length ? `
缺少记录：这个月没有${input.missingRecords.join("、")}。` : ""}`, sources },
        judgments: { text: `第三家卡在法务审批，原因可能是合同模板，也可能是对方预算冻结，还没有确认${cite}。计划外做了一次老客户回访${cite}。`, sources },
        nextFocus: { text: `10 月先签下第三家，再把试点扩到 5 家${cite}。`, sources },
        escalations: { text: "无", sources: [] },
      } };
    } },
  },
});
await t.sql("UPDATE battlefield_config SET owner_id=$1 WHERE id='growth'", [TEST_MEMBER.personId]);
await t.sql("INSERT INTO capability_config(id,version,code,name,six_month_outcome) VALUES ('cap-channel',1,'01','渠道','渠道能力')");
await t.sql(`INSERT INTO missions(id,version,code,period,title,owner_id,capability_id,battlefield_ids,outcome,why,success_evidence,milestones,boundaries,
  source_ref,source_document_id,source_revision,source_title) VALUES ('mission-channel',1,'M1','2026-09','渠道试点签约',$1,'cap-channel','["growth"]',
  '9 月签下 3 家渠道试点客户','打开渠道收入','["3 份签约合同"]','["9/15 签首家","9/30 签满 3 家"]','只做华东','demo','demo',1,'demo')`, [TEST_MEMBER.personId]);
await t.monthlyReviews!.open("2026-09");
await t.monthlyReviews!.idle();
for (const person of [TEST_CEO.personId, TEST_MEMBER.personId]) await t.sql("INSERT INTO person_onboarding (person_id,completed_at) VALUES ($1,now()) ON CONFLICT DO NOTHING", [person]);
const [review] = await t.sql("SELECT id, status FROM personal_reviews WHERE person_id=$1", [TEST_MEMBER.personId]);
await t.app.listen({ port: API, host: "127.0.0.1" });
console.log(JSON.stringify({ ready: true, api: API, web: WEB, review, models: tierModels }));
const stop = () => { void t.close().finally(() => process.exit(0)); };
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
