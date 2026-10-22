/**
 * 会后确认演示（给人豪看「主持人确认 → 影响卡 → 代判 → 更正卡」）：一次性库 → 迁移 → 账号 → Mission/Task → 一场会、逐字稿、分层。
 * 模型输出用脱敏样例 S001 在真实模型上跑出来的结果回放（replay-S001.json），确定、可复现；不连飞书，什么都不往外写。
 * 本体换成本机 127.0.0.1:4830 的假本体（两个 Mission、Agents 单元、公司），写进来的事件只记在内存里，控制口 /events 能看；不连 world-02。
 * 后台任务（分层同步、往下推影响卡、提醒与代判）照常跑：在页面上点「对 / 改一下 / 其实没定」会真的推卡。
 * 另开 127.0.0.1:4829 的本机控制口，演示时把某条推到「满一个工作日没确认 → Agent 代判」：GET /judge?ordinal=2
 *   cd apps/api && node node_modules/tsx/dist/cli.mjs ../../.scratch/meeting-confirm-demo/server.mts
 */
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { buildApp, type AppEnv } from "../../apps/api/src/app.js";
import { migrate } from "../../apps/api/src/migrate.js";
import { hashSecret } from "../../apps/api/src/session.js";
import { createJobWorker } from "../../apps/api/src/jobs.js";
import { parseFeishuTranscriptText } from "../../apps/api/src/transcriptMarkdown.js";
import { preflightCandidate } from "../../apps/api/test/helpers.js";
import type { ImpactAgent } from "../../apps/api/src/impactAgent.js";

const require = createRequire(new URL("../../apps/api/package.json", import.meta.url));
const { Pool } = require("pg") as typeof import("pg");
const ADMIN = process.env.DEMO_PG_ADMIN_URL ?? "postgres://postgres:postgres@localhost:55432/postgres";
const DB = "tianshu_meeting_confirm_demo";
const PORT = 4828;
const CONTROL_PORT = 4829;
const ORIGIN = "http://localhost:3828";
export const PASSCODE = "2580";
const fixture = (path: string) => fileURLToPath(new URL(`../../apps/api/scripts/fixtures/meeting-impact-smoke/${path}`, import.meta.url));
const run = JSON.parse(readFileSync(fileURLToPath(new URL("./replay-S001.json", import.meta.url)), "utf8"));
const candidates = JSON.parse(readFileSync(fixture("candidates.json"), "utf8")) as {
  personId: string;
  missions: { id: string; code: string; title: string; outcome: string; timeBoundary: string }[];
  tasks: { id: string; title: string; status: string; dueDate: string | null; missionCode: string | null; acceptance: string[] }[];
}[];

const admin = new Pool({ connectionString: ADMIN, max: 1 });
await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
await admin.query(`CREATE DATABASE ${DB}`);
await admin.end();
const pool = new Pool({ connectionString: ADMIN.replace(/\/postgres$/, `/${DB}`), max: 8 });
const client = await pool.connect();
await migrate(client);
client.release();

const LOGINS: Record<string, string> = { "smoke-ceo": "zhou", "smoke-pm": "lin", "smoke-fe": "chen", "smoke-be": "wu", "smoke-pilot": "xu", "smoke-ops": "zheng" };
for (const [personId, loginId] of Object.entries(LOGINS)) {
  await pool.query("INSERT INTO member_access (person_id, login_id, passcode_hash, must_change) VALUES ($1, $2, $3, FALSE)", [personId, loginId, hashSecret(PASSCODE)]);
  await pool.query("INSERT INTO person_onboarding (person_id, completed_at) VALUES ($1, now())", [personId]);
}

// 本月 Mission 与各人手上的 Task（脱敏样例）：影响卡要落到「哪个 Mission / 哪个 Task 的哪条验收」。
const period = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 7);
// 林晓负责 Agents 单元（会议对不上 Mission 时挂这里）。
await pool.query("INSERT INTO capability_config(id,version,code,name,six_month_outcome,owner_id) VALUES ('agents',1,'07','Agents','co-agent 成为团队每天在用的工作方式','smoke-pm') ON CONFLICT DO NOTHING");
const missionIds = new Map<string, string>();
for (const person of candidates) for (const mission of person.missions) {
  missionIds.set(mission.code, mission.id);
  await pool.query(`INSERT INTO missions (id, version, code, period, title, owner_id, capability_id, battlefield_ids, outcome, milestones, source_ref, source_document_id, source_revision, source_title)
    VALUES ($1, 1, $2, $3, $4, $5, 'agents', '["growth"]', $6, '[]', 'demo://meeting-confirm', 'meeting-confirm-demo', 1, '会后确认演示')`,
  [mission.id, mission.code, period, mission.title, person.personId, mission.outcome]);
}
const taskIds = new Map<string, string>();
for (const person of candidates) for (const [index, task] of person.tasks.entries()) {
  const id = randomUUID();
  taskIds.set(task.id, id);
  const missionId = task.missionCode ? missionIds.get(task.missionCode) ?? null : null;
  await pool.query(`INSERT INTO tasks (id, title, due_date, status, owner_id, created_by, done_definition, mission_id, step_order) VALUES ($1, $2, $3, $4, $5, 'self', $6, $7, $8)`,
    [id, task.title, task.dueDate, task.status, person.personId, task.acceptance.join("\n"), missionId, missionId ? index + 1 : null]);
  await pool.query("INSERT INTO task_members (task_id, person_id, role, added_by) VALUES ($1, $2, 'owner', $2)", [id, person.personId]);
}

// 影响分析回放：按决定的说法找 S001 里那一版的卡；主持人改过说法也认得出（前 8 个字）。
const impact: ImpactAgent = {
  async analyze(input) {
    const said = input.decision.statement.replace(/^CEO 同意：/, "");
    const found = run.impacts.find((item: { statement: string }) => {
      const replayed = item.statement.replace(/^CEO 同意：/, "");
      return said.includes(replayed.slice(0, 8)) || replayed.includes(said.slice(0, 8));
    });
    return { cards: (found?.cards ?? []).map((card: { targets: { type: string; id: string; index?: number }[] }) => ({
      ...card, targets: card.targets.map((target) => ({ ...target, id: taskIds.get(target.id) ?? target.id })),
    })) };
  },
  async answer(input) {
    if (/验收|月底/.test(input.question)) return "月底验收按新接口验：纪要区要按说话人显示，旧接口 10 月 31 日后不能再调用。吴桐 28 日交付后你有三天联调；赶不上可以先问林晓能否把验收顺延。";
    return "这条是会上按林晓的总结、到点没确认由 Agent 代判生效的；林晓确认或改判后，这张卡会跟着更新。";
  },
};

// 假本体：按外部引用（tianshu）和类型列对象，prepare / commit 一律成功，事件记在内存里。
const WORLD_PORT = 4830;
const head = (id: string, type: string, title: string, ref?: string) => ({ object_id: id, object_type: type, title, revision_id: `${id}-r3`, object_version: 3, version: 3,
  domain_id: "demo", external_refs: ref ? [{ system: "tianshu", id: ref }] : [], lifecycle: { status: "active" }, contract_version: "tkos.world/0.3" });
const worldObjects = [
  head("w-mission-pm", "Mission", "Co-agent 第一版交互定稿", "mission:pm-202610"),
  head("w-mission-pilot", "Mission", "B 端试点上线", "mission:pilot-202610"),
  head("w-unit-agents", "ResponsibilityUnit", "Agents", "capability:07"),
  head("w-company", "Company", "词元云集"),
];
const worldEvents: unknown[] = [];
createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${WORLD_PORT}`);
  const send = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json; charset=utf-8" }).end(JSON.stringify(body));
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (url.pathname === "/v1/health") return send(200, { ok: true });
  if (url.pathname === "/v1/world/objects") {
    const ext = url.searchParams.get("external_id"), type = url.searchParams.get("type");
    return send(200, { items: worldObjects.filter((o) => (ext ? o.external_refs.some((r) => r.id === ext) : true) && (type ? o.object_type === type : true) && (ext || type)), next_cursor: null });
  }
  const one = url.pathname.match(/^\/v1\/world\/objects\/([^/]+)$/);
  if (one) {
    const found = worldObjects.find((o) => o.object_id === decodeURIComponent(one[1]));
    return found ? send(200, { business: { ...found, attributes: { external_refs: found.external_refs }, blocks: [] }, records: { lifecycle: found.lifecycle }, protocol: { contract_version: found.contract_version } })
      : send(404, { error: { code: "NOT_FOUND", message: "no object" } });
  }
  if (url.pathname === "/v1/actions/prepare") return send(200, { expected_versions: [] });
  if (url.pathname === "/v1/actions") {
    const body = JSON.parse(raw);
    worldEvents.push({ at: new Date().toISOString(), idempotency_key: body.idempotency_key, ...body.params });
    return send(200, { receipt_id: `r${worldEvents.length}`, status: "committed", result: { event_id: `ev-${worldEvents.length}` } });
  }
  return send(404, { error: { code: "NOT_FOUND", message: url.pathname } });
}).listen(WORLD_PORT, "127.0.0.1");

const env: AppEnv = {
  worldApiUrl: `http://127.0.0.1:${WORLD_PORT}`, worldAgentToken: "demo-stub-world-token",
  sessionSecret: "meeting-confirm-demo-session", sessionMaxAgeSeconds: 60 * 60 * 12, publicOrigin: ORIGIN, extraOrigins: ["http://127.0.0.1:3828"],
  driServiceToken: "meeting-confirm-demo-dri", mcpServiceToken: "meeting-confirm-demo-mcp",
  companyMemorySeedDir: fileURLToPath(new URL("../../apps/api/test/fixtures/company-memory", import.meta.url)),
  companyPeopleSeed: fixture("people.json"),
  piBaseUrl: "https://provider.invalid/v1/responses", piApiKey: "none", lightModel: "none", heavyModel: "none", compactionModel: "none", buildSha: "meeting-confirm-demo",
};
const app = await buildApp({
  pool, env, backgroundPreflight: false, personalMemoryRecall: null,
  preflightAgent: { async generate(input) { return { candidate: preflightCandidate(input.issues.map((issue) => `issue:${issue.id}`)) }; } },
  outcomeAgent: { async generate() { return { candidate: { summary: run.summary, items: run.items.map((item: Record<string, unknown>) => ({
    kind: item.kind, text: item.text, turnId: item.turnId, quote: item.quote,
    ...(item.ownerPersonId ? { ownerPersonId: item.ownerPersonId } : {}), ...(item.dueDate ? { dueDate: item.dueDate } : {}),
    ...(item.judgmentKind ? { judgmentKind: item.judgmentKind } : {}), ...(item.title ? { title: item.title, brief: item.brief } : {}),
    ...(item.parentItemId ? { parentIndex: run.items.findIndex((other: { id: string }) => other.id === item.parentItemId) } : {}),
  })) } }; } },
  threadIntroAgent: { async generate() { return { message: "加入会议群。" }; } },
  meetingFollowThroughAgents: { layering: { async layer() { return run.layered; } }, impact },
});
await app.listen({ port: PORT, host: "127.0.0.1" });

const dri = { authorization: "Bearer meeting-confirm-demo-dri" };
const login = async (loginId: string) => String((await app.inject({ method: "POST", url: "/api/auth/login", headers: { origin: ORIGIN }, payload: { loginId, passcode: PASSCODE } })).headers["set-cookie"]).split(";")[0];
const ceo = await login("zhou");
const issue = (await app.inject({ method: "POST", url: "/api/dri/issues", headers: dri, payload: {
  externalId: "demo-issue-1", submitterPersonId: "smoke-pm", title: "co-agent 交互与试点范围", whyNow: "月底前要给 3 家试点客户用起来", sourceRef: "dri://demo", location: { level: "battlefield", battlefieldId: "growth" },
} })).json().cards[0];
const create = issue.actions.find((action: { actionType: string }) => action.actionType === "issue.create_meeting");
const people = ["smoke-ceo", "smoke-pm", "smoke-fe", "smoke-be", "smoke-pilot", "smoke-ops"];
// 今天下午开的会（散会后几小时，主持人还没确认）。
const today = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);
const startedAt = Date.parse(`${today}T14:00:00+08:00`);
const meeting = (await app.inject({ method: "POST", url: "/api/actions/execute", headers: { cookie: ceo, origin: ORIGIN }, payload: { actionId: create.actionId, input: {
  title: "co-agent 交互评审", scheduledAt: new Date(startedAt).toISOString(), endsAt: new Date(startedAt + 50 * 60_000).toISOString(), leadDriId: "smoke-pm", ceoParticipantId: "smoke-ceo",
  participants: people.slice(1), issueIds: [issue.objectRef.id],
} } })).json().cards[0];
const meetingId = meeting.objectRef.id as string;
const parsed = parseFeishuTranscriptText(readFileSync(fixture("S001_2026-10-20_co-agent交互评审/transcript.md"), "utf8"));
if (!parsed.ok) throw new Error("transcript");
const byName = Object.fromEntries(Object.entries(run.speakers).map(([id, name]) => [name, id]));
const turns = parsed.transcript.turns.map((turn, index) => ({ id: `turn-${String(index + 1).padStart(4, "0")}`, speakerId: byName[turn.speakerName],
  startedAt: new Date(startedAt + 5_000 + turn.offsetSeconds * 1000).toISOString(), text: turn.text }));
const imported = await app.inject({ method: "POST", url: `/api/dri/meetings/${meetingId}/transcript`, headers: dri, payload: { schemaVersion: "warmap-transcript.v1", meetingId, turns } });
console.log("transcript", imported.statusCode, imported.json().cards?.[0]?.payload?.outcome?.status, imported.json().cards?.[0]?.payload?.outcome?.items?.length);
// 飞书实际参会名单：郑可没来（看不到原文和完整纪要）。
await pool.query("UPDATE meetings SET attendees_actual = $2::jsonb WHERE id = $1", [meetingId, JSON.stringify(people.slice(0, 5))]);

const decisions = app.meetingFollowThrough.decisions;
await decisions.sync(meetingId);
const rows = (await pool.query("SELECT id, tier, ordinal, statement, status FROM meeting_decisions WHERE meeting_id = $1 ORDER BY tier DESC, ordinal", [meetingId])).rows;
console.log(rows);

// 后台任务：往下推影响卡、提醒与代判（和 server.ts 同一套 handlers）。
const followThrough = app.meetingFollowThrough.jobs();
const worker = createJobWorker({ pool, handlers: followThrough.handlers, recurring: followThrough.recurring, intervalMs: 1_500 });
worker.start();

// 本机控制口：把主持人第 N 条推到「满一个工作日没确认」，立刻跑一次提醒与代判。
createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${CONTROL_PORT}`);
  try {
    if (url.pathname === "/events") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" }).end(JSON.stringify(worldEvents, null, 2));
      return;
    }
    if (url.pathname === "/judge") {
      const ordinal = Number(url.searchParams.get("ordinal"));
      await pool.query("UPDATE meeting_decisions SET due_at = now() - interval '1 minute' WHERE meeting_id = $1 AND tier = 'host' AND ordinal = $2 AND status = 'pending'", [meetingId, ordinal]);
      await decisions.tick();
    }
    const state = (await pool.query(`SELECT d.tier, d.ordinal, d.status, d.revision, d.impact_status, coalesce(d.final_statement, d.statement) AS statement,
      (SELECT json_agg(json_build_object('person', c.person_id, 'rev', c.trigger_revision, 'status', c.status, 'request', c.request_id, 'title', c.title) ORDER BY c.person_id, c.trigger_revision)
         FROM impact_cards c WHERE c.trigger_id = d.id) AS cards
      FROM meeting_decisions d WHERE d.meeting_id = $1 ORDER BY d.tier DESC, d.ordinal`, [meetingId])).rows;
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" }).end(JSON.stringify({ meetingId, decisions: state }, null, 2));
  } catch (error) {
    res.writeHead(500).end(String(error));
  }
}).listen(CONTROL_PORT, "127.0.0.1");
console.log(`ready api=:${PORT} control=:${CONTROL_PORT} meeting=${meetingId}`);
