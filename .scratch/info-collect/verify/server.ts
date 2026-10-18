/**
 * ③ 信息收集的本地自查环境：API 4891 + 网页 3891（只连 55432 的一次性测试库，进程退出即删库）。
 * 不读任何凭据、不调模型和飞书：起草用脚本化的假 Agent，对话里「收…」这类话直接走 start_collection，多维表格是进程内 mock。
 * 预置：一轮已发出的「灯塔项目每周开销」（两人已填、一人已确认），一份已提交的周复盘。
 * 账号：ceshij / 2468（CEO 陈思远）、ceshiy / 1357（成员王雨桐）。
 * 启动：node apps/api/node_modules/tsx/dist/cli.mjs .scratch/info-collect/verify/server.ts
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

process.env.TEST_PG_URL ??= "postgres://postgres:postgres@localhost:55432/postgres";
const { createTestApp, TEST_CEO, TEST_MEMBER } = await import("../../../apps/api/test/helpers.js");
const { createMockBitable } = await import("../../../apps/api/src/feishu/bitable.js");
const { hashSecret } = await import("../../../apps/api/src/session.js");

const root = fileURLToPath(new URL("../../../", import.meta.url));
const API_PORT = 4891, WEB_PORT = 3891;
const people = [
  { personId: TEST_CEO.personId, displayName: "陈思远", roles: ["ceo"] },
  { personId: TEST_MEMBER.personId, displayName: "王雨桐", roles: ["dri", "participant"] },
  { personId: "person-fixture-003", displayName: "李嘉禾", roles: ["dri", "participant"] },
  { personId: "person-fixture-004", displayName: "赵一鸣", roles: ["dri", "participant"] },
  { personId: "person-fixture-005", displayName: "孙晓棠", roles: ["dri", "participant"] },
  { personId: "person-fixture-006", displayName: "周子墨", roles: ["dri", "participant"] },
];
const dir = await mkdtemp(join(tmpdir(), "warmap-info-collect-"));
await writeFile(join(dir, "people.json"), JSON.stringify({ schemaVersion: "company-people.v1", people }));

const all = people.slice(1).map((person) => person.personId);
const agent = {
  async draft(input: { prompt: string }) {
    const scenario = /开销|花了|费用/.test(input.prompt) ? "expense" as const : /进展/.test(input.prompt) ? "method_progress" as const : "unsupported" as const;
    return { scenario, title: scenario === "expense" ? "灯塔项目每周开销" : "方法部周进展", recipientIds: scenario === "expense" ? all : all.slice(0, 4),
      deadline: null, weekly: /每周|每个礼拜|固定/.test(input.prompt) };
  },
};
const runtime = {
  async run(input: { message: string; entries?: { startCollection(args: { prompt: string }): Promise<Record<string, unknown>> }; emit: (event: { type: "message"; delta: string }) => void; runtimeEntries: unknown[] }) {
    let text = "好的。";
    if (/收/.test(input.message) && input.entries) {
      const result = await input.entries.startCollection({ prompt: input.message });
      text = result.drafted
        ? `起草好了：向 ${(result.suggestedRecipients as string[]).join("、")} 收「${String(result.title)}」，${String(result.deadline)} 截止${result.weekly ? "，每周固定" : ""}。`
        : "这类收集天枢里还不支持，只做每周开销和每周进展两类。";
    }
    input.emit({ type: "message", delta: text });
    return { assistantMessage: text, runtimeEntries: input.runtimeEntries };
  },
};

const t = await createTestApp({ companyPeopleSeed: join(dir, "people.json"), publicOrigin: `http://localhost:${WEB_PORT}`, extraOrigins: [`http://127.0.0.1:${WEB_PORT}`] },
  runtime as never, { collectionAgent: agent as never, bitable: createMockBitable() });
for (const [index, person] of people.slice(2).entries()) {
  await t.sql("INSERT INTO member_access (person_id, login_id, passcode_hash, must_change) VALUES ($1, $2, $3, FALSE)", [person.personId, `ceshi${"cdef"[index]}`, hashSecret("1111")]);
}
for (const person of people) await t.sql("INSERT INTO person_onboarding (person_id, completed_at) VALUES ($1, now()) ON CONFLICT (person_id) DO NOTHING", [person.personId]);

// 预置一轮：CEO 发出的每周开销，赵一鸣已确认，李嘉禾已填未确认。
const origin = `http://localhost:${WEB_PORT}`;
const login = async (loginId: string, passcode: string) => ((await t.app.inject({ method: "POST", url: "/api/auth/login", headers: { origin }, payload: { loginId, passcode } }))
  .headers["set-cookie"] as string).split(";")[0];
const call = async (cookie: string, url: string, payload?: unknown) => (await t.app.inject({ method: payload === undefined ? "GET" : "POST", url, headers: { cookie, origin },
  ...(payload === undefined ? {} : { payload: payload as object }) })).json() as { collection: { id: string; deadlineAt: string; weekly: boolean; round: { requestId: string } | null; actions: { actionType: string; actionId: string }[] } };
const ceo = await login("ceshij", "2468");
const drafted = await call(ceo, "/api/collections/draft", { prompt: "每周五下班前收一下大家在灯塔项目上的开销" });
const send = drafted.collection.actions.find((action) => action.actionType === "collection.send")!;
const sent = await call(ceo, "/api/collections/actions/execute", { actionId: send.actionId, input: { recipientIds: all, deadlineAt: drafted.collection.deadlineAt, weekly: true } });
const requestId = sent.collection.round!.requestId;
const fill = async (loginId: string, values: Record<string, string>, confirm: boolean) => {
  const cookie = await login(loginId, "1111");
  let view = await call(cookie, `/api/requests/${requestId}/collection`);
  view = await call(cookie, "/api/collections/actions/execute", { actionId: view.collection.actions.find((action) => action.actionType === "collection.save")!.actionId, input: { values } });
  if (confirm) await call(cookie, "/api/collections/actions/execute", { actionId: view.collection.actions.find((action) => action.actionType === "collection.confirm")!.actionId });
};
await fill("ceshid", { amount: "2380", purpose: "客户现场差旅（高铁 + 两晚住宿）", project: "灯塔 · 华东试点", receipt: "https://example.com/receipts/zhao-1019.pdf" }, true);
await fill("ceshic", { amount: "640", purpose: "模型调用费", project: "灯塔 · 评测", receipt: "https://example.com/receipts/li-1019.pdf" }, false);
await fill("ceshie", { amount: "120", purpose: "打车" }, false);
// 王雨桐这周的周复盘已提交（方法部门的表会用它起草）。
await t.sql(`INSERT INTO weekly_reviews (id, person_id, week_start, status, body, submitted_at, created_at, updated_at) VALUES ($1, $2, date_trunc('week', now() AT TIME ZONE 'Asia/Shanghai')::date, 'submitted', $3::jsonb, now(), now(), now())`,
  [randomUUID(), TEST_MEMBER.personId, JSON.stringify({
    overall: { text: "评测集第一版跑通，覆盖率到 82%。", sources: [] }, progress: { text: "完成 3 个客户场景的拆解，补齐评测脚本。", sources: [] },
    issues: { text: "标注人手不够，长尾样本缺口约 200 条。", sources: [] }, implications: { text: "", sources: [] },
    actions: { text: "和李嘉禾对齐标注排期。", sources: [] }, nextWeek: { text: "评测覆盖率到 90%，出第一版报告。", sources: [] },
  })]);

await t.app.listen({ port: API_PORT, host: "127.0.0.1" });
const tick = setInterval(() => { void t.app.collectionJobs.handlers["collection.tick"]({}, { id: "0", kind: "collection.tick", dedupe_key: randomUUID(), attempts: 1, payload: {} }).catch(() => undefined); }, 60_000);
const web = spawn(process.execPath, [join(root, "apps/web/node_modules/next/dist/bin/next"), "dev", "-p", String(WEB_PORT)],
  { cwd: join(root, "apps/web"), stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, API_SERVER_URL: `http://127.0.0.1:${API_PORT}`, NEXT_TELEMETRY_DISABLED: "1" } });
console.log(`info-collect verify: web http://localhost:${WEB_PORT}  api ${API_PORT}  round /requests/${requestId}`);
const stop = async () => { clearInterval(tick); if (web.exitCode === null) web.kill(); await t.close(); process.exit(0); };
web.on("exit", () => void stop());
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => void stop());
