import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Client as PgClient, Pool } from "pg";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FastifyInstance } from "fastify";
import { createTestApp } from "../test/helpers.js";

const config = JSON.parse(await readFile(process.argv[2], "utf8")) as {
  worldUrl: string; worldMcpUrl: string; readerToken: string; humanToken: string; taskId: string; scopeId: string;
  chatCheckout: string; isolatedPort: string; mode: "plugin_direct" | "plugin_source";
};
const adminUrl = new URL(process.env.TEST_PG_URL!);
assert.equal(adminUrl.port, config.isolatedPort);
assert.equal(adminUrl.username, "tkos_acceptance_admin");
assert.ok(["127.0.0.1", "localhost"].includes(adminUrl.hostname));
assert.equal(new URL(config.worldUrl).hostname, "127.0.0.1");
assert.equal(new URL(config.worldMcpUrl).hostname, "127.0.0.1");
const identityResponse = await fetch(config.worldUrl + "/v1/whoami", { redirect: "error", headers: { authorization: `Bearer ${config.readerToken}` } });
assert.equal(identityResponse.status, 200);
const identity = await identityResponse.json();
assert.equal(identity.scope.scope_id, config.scopeId);
assert.ok(identity.scope.tenant_id.startsWith("runtime-acceptance-"));
assert.equal(identity.credential.access_level, "read");
const root = await mkdtemp(join(tmpdir(), "world-plugin-integration-"));
const database = `chat_plugin_${randomUUID().replaceAll("-", "")}`;
const admin = new PgClient({ connectionString: adminUrl.href });
await admin.connect();
await admin.query(`CREATE DATABASE ${database}`);
const databaseUrl = new URL(adminUrl); databaseUrl.pathname = `/${database}`;
const pool = new Pool({ connectionString: databaseUrl.href });
const token = `synthetic-chat-${randomUUID()}`;
const chatModule = await import(pathToFileURL(resolve(config.chatCheckout, "dist/app.js")).href) as {
  createApp: (options: Record<string, unknown>) => Promise<FastifyInstance>;
};
for (const migration of ["001-baseline.sql", "002-user-sessions.sql", "003-task-quality.sql"])
  await pool.query(await readFile(resolve(config.chatCheckout, "migrations", migration), "utf8"));
const chat = await chatModule.createApp({ internalToken: token, db: { query: (sql: string, args?: unknown[]) => pool.query(sql, args) },
  worldUrl: config.worldUrl, worldToken: config.readerToken });
const chatUrl = await chat.listen({ host: "127.0.0.1", port: 0 });
const tianshu = await createTestApp({ internalChatToken: token, chatServiceUrl: chatUrl });
const clients: Client[] = [];
let dropped = false;
const connect = async (dropReply: boolean) => {
  const client = new Client({ name: dropReply ? "synthetic-original-client" : "synthetic-recovery-client", version: "1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(config.worldMcpUrl), {
    requestInit: { headers: { authorization: `Bearer ${config.humanToken}` }, redirect: "error" },
    fetch: async (url, init) => {
      const response = await fetch(url, init);
      if (dropReply && !dropped && typeof init?.body === "string" && init.body.includes('"world_app_submit_task_change"') && init.body.includes('"confirmation"')) {
        assert.equal(response.status, 200);
        await response.text();
        dropped = true;
        throw new Error("Synthetic response lost after actual submission");
      }
      return response;
    },
  });
  clients.push(client);
  await client.connect(transport);
  return client;
};
const worldCall = async (client: Client, name: string, args: Record<string, unknown>) => {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, false, `Synthetic world MCP operation failed: ${name}`);
  const content = result.content as { type: string; text?: string }[];
  assert.ok(content[0]?.type === "text" && typeof content[0].text === "string");
  return JSON.parse(content[0].text);
};
try {
  const url = await tianshu.app.listen({ host: "127.0.0.1", port: 0 });
  const cookie = await tianshu.loginCookie();
  const request = async (path: string, body?: unknown) => {
    const response = await fetch(url + path, { method: body === undefined ? "GET" : "POST", redirect: "error",
      headers: { cookie, origin: tianshu.publicOrigin, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.equal(response.status, 200, "Synthetic Tianshu HTTP request failed");
    return response.json();
  };
  const initial = await request(`/api/task-quality/tasks/${config.taskId}/check`, { maxAgeHours: 24 });
  assert.ok(initial.report.quality.findings.some((item: { code: string }) => item.code === "missing_outcome"));
  const personal = await request("/api/me/tokens", { name: "synthetic plugin integration", client: "codex", expiresInDays: 30 });
  let rpcId = 1;
  const rpc = async (name: string, args: Record<string, unknown>) => {
    const response = await fetch(url + "/mcp/me", { method: "POST", redirect: "error", headers: {
      authorization: `Bearer ${personal.token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method: "tools/call", params: { name, arguments: { viewerRole: "ceo", ...args } } }) });
    assert.equal(response.status, 200);
    const value = await response.json();
    assert.equal(value.result.isError, false, "Synthetic Tianshu MCP operation failed");
    return JSON.parse(value.result.content[0].text);
  };
  const proposal = await request(`/api/task-quality/tasks/${config.taskId}/proposals`, { clientRequestId: "synthetic-plugin-output", fieldKey: "new:definition/outcome",
    value: "Synthetic readable plugin receipt", classification: "decision", quote: "Synthetic readable plugin receipt", occurredAt: new Date(Date.now() - 1000).toISOString() });
  const handoff = await rpc("get_task_repair_handoff", { proposalId: proposal.id });
  assert.equal(handoff.stage, "source");
  const sourceResponse = await fetch(config.worldUrl + "/v1/actions", { method: "POST", redirect: "error", headers: {
    authorization: `Bearer ${config.humanToken}`, "content-type": "application/json" }, body: JSON.stringify(handoff.request) });
  assert.equal(sourceResponse.status, 200);
  const source = await sourceResponse.json();
  assert.equal((await rpc("report_task_repair_receipt", { proposalId: proposal.id, receipt: { stage: "source", receiptId: source.receipt_id } })).state, "ready");
  const change = await rpc("get_task_repair_handoff", { proposalId: proposal.id });
  assert.equal(change.stage, "change");
  const world = await connect(true);
  assert.ok((await world.listTools()).tools.some(item => item.name === "world_app_submit_task_change"));
  const connection = await worldCall(world, "world_get_connection", {});
  assert.equal(connection.scope.scope_id, config.scopeId);
  assert.notEqual(connection.principal.principal_id, identity.principal.principal_id);
  let reviewed;
  if (config.mode === "plugin_source") {
    const choice = await worldCall(world, "world_app_sources_prepare", { choice: {
      source: { adapter: "chat-task-handoff/0.1", source_id: `chat-task:${proposal.id}`, locator: `chat-proposal:${proposal.id}` },
      version_scope: "selected_snapshot", selected_snapshot: "synthetic-snapshot-1", target_task_ids: [config.taskId], audience: "current_scope_members",
      read_evidence: { kind: "own_material", reference: "dialogue:synthetic-source-read" },
      transfer_evidence: { kind: "source_owner_approval", reference: "dialogue:synthetic-source-transfer" },
    } });
    const selected = await worldCall(world, "world_app_sources_select", { request: choice.request, confirmation: {
      mode: "current_dialogue", decision: "confirm", approved_digest: choice.request.digest,
      text: "Allow this exact synthetic source snapshot and target; this does not approve a Task field.", confirmed_at: new Date().toISOString() } });
    const imported = await worldCall(world, "world_app_sources_ingest", { selection_id: selected.selection.selection_id, selection_version: 1,
      increment: { source_id: `chat-task:${proposal.id}`, snapshot_version: "synthetic-snapshot-1", batch_id: `batch:${proposal.id}`, origin_scope_id: config.scopeId,
        items: [{ item_id: proposal.id, item_version: proposal.source.version, classification: proposal.classification,
          target_ref: change.package.card.command.baseline.subject_ref, field_key: proposal.fieldKey, value: proposal.after,
          quote: proposal.source.quote, occurred_at: proposal.source.occurredAt, locator: proposal.source.locator,
          source_event_ref: `event:${source.result.event_id}`, links: [] }] } });
    assert.equal(imported.imports[0].status, "task_prepared");
    reviewed = imported.imports[0].task_request;
    assert.notEqual(reviewed.command.action.params.payload.blocks.definition.components[0].id, change.package.input.change.component_id);
  } else {
    reviewed = (await worldCall(world, "world_app_prepare_task_change", change.package.input)).request;
  }
  const refused = await world.callTool({ name: "world_app_submit_task_change", arguments: { request: reviewed } });
  assert.equal(refused.isError, true);
  assert.equal((await worldCall(world, "world_app_get_task", { task_id: config.taskId })).task.business.version, initial.report.task.business.version);
  const submission = { request: reviewed, confirmation: { mode: "current_dialogue", decision: "confirm", approved_digest: reviewed.digest,
    text: "Confirm this one displayed synthetic outcome and exact fingerprint; no other field or business gate.", confirmed_at: new Date().toISOString() } };
  const saved = join(root, "original-submission.json");
  await writeFile(saved, JSON.stringify(submission), { mode: 0o600 });
  await assert.rejects(world.callTool({ name: "world_app_submit_task_change", arguments: submission }));
  assert.equal(dropped, true);
  const recovery = await connect(false);
  const original = JSON.parse(await readFile(saved, "utf8"));
  const recovered = await worldCall(recovery, "world_app_verify_task_change", { submission: original });
  assert.equal(recovered.recorded, true);
  assert.equal(recovered.readback, "verified");
  assert.notEqual(recovered.verification_command.approval_digest, change.package.card.command.approval_digest);
  const repeated = await worldCall(recovery, "world_app_submit_task_change", original);
  assert.equal(repeated.receipt.receipt_id, recovered.receipt.receipt_id);
  const verified = await rpc("report_task_repair_receipt", { proposalId: proposal.id,
    receipt: { stage: "change", verificationCommand: recovered.verification_command } });
  assert.equal(verified.state, "verified");
  assert.equal(verified.receiptId, recovered.receipt.receipt_id);
  for (let refresh = 0; refresh < 2; refresh++)
    assert.equal((await rpc("get_task_repair_handoff", { proposalId: proposal.id })).proposal.receiptId, recovered.receipt.receipt_id);
  const current = await request(`/api/task-quality/tasks/${config.taskId}/check`, {});
  assert.equal(current.report.quality.findings.some((item: { code: string }) => item.code === "missing_outcome"), false);
  assert.ok(current.report.quality.fields.some((item: { value: unknown }) => item.value === "Synthetic readable plugin receipt"));
  assert.ok(current.report.task.business.pending_change);
  const blocks = current.report.task.business.blocks;
  for (const [blockId, componentId] of [["definition", "retained-criterion"], ["plan", "retained-activity"]]) {
    const before = initial.report.task.business.blocks.find((item: { id: string }) => item.id === blockId).components.find((item: { id: string }) => item.id === componentId);
    const after = blocks.find((item: { id: string }) => item.id === blockId).components.find((item: { id: string }) => item.id === componentId);
    for (const key of ["id", "type", "text", "attributes", "scope", "refs", "artifacts"]) assert.deepEqual(after[key], before[key]);
  }
  assert.deepEqual(current.report.task.records.latest_state, initial.report.task.records.latest_state);
  console.log(`WORLD_PLUGIN_ENGINEERING_OK: ${config.mode}, real three-service HTTP, native personal MCP, lost reply, original-request recovery and current fields`);
} finally {
  for (const client of clients) await client.close();
  await tianshu.close(); await chat.close(); await pool.end();
  await admin.query(`DROP DATABASE ${database} WITH (FORCE)`); await admin.end(); await rm(root, { recursive: true, force: true });
}
