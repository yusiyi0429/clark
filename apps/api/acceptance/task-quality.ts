import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { Client, Pool } from "pg";
import type { FastifyInstance } from "fastify";
import { createTestApp } from "../test/helpers.js";

const config = JSON.parse(await readFile(process.argv[2], "utf8")) as {
  worldUrl: string; readerToken: string; humanToken: string; taskId: string; scopeId: string; python: string; chatCheckout: string; isolatedPort: string;
};
const adminUrl = new URL(process.env.TEST_PG_URL!);
assert.equal(adminUrl.port, config.isolatedPort);
assert.equal(adminUrl.username, "tkos_acceptance_admin");
assert.ok(["127.0.0.1", "localhost"].includes(adminUrl.hostname));
assert.equal(new URL(config.worldUrl).hostname, "127.0.0.1");
const identityResponse = await fetch(config.worldUrl + "/v1/whoami", { redirect: "error", headers: { authorization: `Bearer ${config.readerToken}` } });
assert.equal(identityResponse.status, 200);
const identity = await identityResponse.json();
assert.equal(identity.scope.scope_id, config.scopeId);
assert.ok(identity.scope.tenant_id.startsWith("runtime-acceptance-"));
assert.equal(identity.credential.access_level, "read");
const root = await mkdtemp(join(tmpdir(), "task-quality-integration-"));
const database = `chat_quality_${randomUUID().replaceAll("-", "")}`;
const admin = new Client({ connectionString: adminUrl.href });
await admin.connect();
await admin.query(`CREATE DATABASE ${database}`);
const databaseUrl = new URL(adminUrl); databaseUrl.pathname = `/${database}`;
const pool = new Pool({ connectionString: databaseUrl.href });
const token = `synthetic-chat-${randomUUID()}`;
const chatModule = await import(pathToFileURL(resolve(config.chatCheckout, "dist/app.js")).href) as {
  createApp: (options: Record<string, unknown>) => Promise<FastifyInstance>;
};
const db = { query: (sql: string, args?: unknown[]) => pool.query(sql, args) };
for (const migration of ["001-baseline.sql", "002-user-sessions.sql", "003-task-quality.sql"])
  await pool.query(await readFile(resolve(config.chatCheckout, "migrations", migration), "utf8"));
const chat = await chatModule.createApp({ internalToken: token, db, worldUrl: config.worldUrl, worldToken: config.readerToken });
const chatUrl = await chat.listen({ host: "127.0.0.1", port: 0 });
const tianshu = await createTestApp({ internalChatToken: token, chatServiceUrl: chatUrl });
try {
  const url = await tianshu.app.listen({ host: "127.0.0.1", port: 0 });
  const cookie = await tianshu.loginCookie();
  const request = async (path: string, body?: unknown) => {
    const response = await fetch(url + path, { method: body === undefined ? "GET" : "POST", headers: { cookie, origin: tianshu.publicOrigin, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json();
    assert.equal(response.status, 200, JSON.stringify(value));
    return value;
  };
  const catalog = await request("/api/task-quality/catalog");
  assert.ok(catalog.items.some((item: { taskId: string }) => item.taskId === config.taskId));
  const initial = await request(`/api/task-quality/tasks/${config.taskId}/check`, { maxAgeHours: 24 });
  assert.ok(initial.report.quality.findings.some((item: { code: string }) => item.code === "missing_outcome"));
  const proposal = await request(`/api/task-quality/tasks/${config.taskId}/proposals`, { clientRequestId: "synthetic-output", fieldKey: "new:definition/outcome",
    value: "Synthetic readable integration receipt", classification: "decision", quote: "Synthetic readable integration receipt", occurredAt: new Date(Date.now() - 1000).toISOString() });
  const handoff = await request(`/api/task-quality/proposals/${proposal.id}/handoff`);
  assert.equal(handoff.stage, "source");
  const sourceResponse = await fetch(config.worldUrl + "/v1/actions", { method: "POST", headers: { authorization: `Bearer ${config.humanToken}`, "content-type": "application/json" }, body: JSON.stringify(handoff.request) });
  const source = await sourceResponse.json();
  assert.equal(sourceResponse.status, 200, JSON.stringify(source));
  const personal = await request("/api/me/tokens", { name: "synthetic quality integration", client: "codex", expiresInDays: 30 });
  let rpcId = 1;
  const rpc = async (name: string, args: Record<string, unknown>) => {
    const response = await fetch(url + "/mcp/me", { method: "POST", headers: { authorization: `Bearer ${personal.token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method: "tools/call", params: { name, arguments: { viewerRole: "ceo", ...args } } }) });
    const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value));
    assert.equal(value.result.isError, false, JSON.stringify(value));
    return JSON.parse(value.result.content[0].text);
  };
  const acknowledged = await rpc("report_task_repair_receipt", { proposalId: proposal.id, receipt: { stage: "source", receiptId: source.receipt_id } });
  assert.equal(acknowledged.state, "ready");
  const change = await rpc("get_task_repair_handoff", { proposalId: proposal.id });
  assert.equal(change.stage, "change");
  const packet = join(root, "handoff.json"), plan = join(root, "plan.json");
  await writeFile(packet, JSON.stringify(change.package), { mode: 0o600 });
  const cliEnv = { ...process.env, TKOS_WORLD_API_URL: config.worldUrl, TKOS_WORLD_TOKEN: config.humanToken };
  execFileSync(config.python, ["-m", "tkos_world_cli.task_writeback", "import", packet, "--save", plan], { env: cliEnv, stdio: "pipe" });
  const digest = change.package.card.command.approval_digest;
  const args = ["-m", "tkos_world_cli.task_writeback", "apply", plan, "--approve", digest, "--confirmed", "Approve this one synthetic outcome."];
  const written = JSON.parse(execFileSync(config.python, args, { env: cliEnv, encoding: "utf8" }));
  const retried = JSON.parse(execFileSync(config.python, args, { env: cliEnv, encoding: "utf8" }));
  assert.equal(written.receipt.receipt_id, retried.receipt.receipt_id);
  const verified = await rpc("report_task_repair_receipt", { proposalId: proposal.id, receipt: { stage: "change" } });
  assert.equal(verified.receiptId, written.receipt.receipt_id);
  assert.equal(verified.state, "verified");
  const current = await request(`/api/task-quality/tasks/${config.taskId}/check`, {});
  assert.equal(current.report.quality.findings.some((item: { code: string }) => item.code === "missing_outcome"), false);
  assert.ok(current.report.quality.fields.some((item: { value: unknown }) => item.value === "Synthetic readable integration receipt"));
  console.log("TASK_QUALITY_INTEGRATION_OK: three HTTP services, private MCP, personal CLI import/apply/retry, readonly receipt recovery, current quality read");
} finally {
  await tianshu.close(); await chat.close(); await pool.end();
  await admin.query(`DROP DATABASE ${database} WITH (FORCE)`); await admin.end(); await rm(root, { recursive: true, force: true });
}
