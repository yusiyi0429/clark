/**
 * 本地回放一条 Nexus → DRI 确认请求（nexus-dri-confirmation/0.1），不走网络：一条命令做完「收请求 → 负责人确认 → 回调」，
 * 把回执、确认记录、带签名的回调正文原样存成文件，发给溪南核。步骤和说明见同目录的「本地回放步骤.md」。
 *
 *   node apps/api/node_modules/tsx/dist/cli.mjs .scratch/nexus-dri/replay-local.mts <请求正文.json> <confirmed|amended|rejected> [改后的内容] [--at now|<ISO 时间>] [--out <目录>]
 *
 * 只用 54329 上的一次性测试库（跑完就删），回调打到本进程在 127.0.0.1 上临时开的假接收端；不调模型、不发飞书、不写本体、不连外网。
 * 租户、agentId、负责人都照请求正文里的值配，所以真实格式的请求正文不用改就能回放。
 * 签名密钥：设了 NEXUS_DRI_CALLBACK_SECRET 就用它，否则用溪南公开合成样例里的样例密钥；密钥不打印。
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const option = (name: string): string | undefined => { const at = args.indexOf(name); return at < 0 ? undefined : args.splice(at, 2)[1]; };
const at = option("--at");
const here = fileURLToPath(new URL(".", import.meta.url));
const out = resolve(option("--out") ?? join(here, "out", new Date().toISOString().replace(/[:.]/g, "-")));
const [file, decision, value] = args;
if (!file || !["confirmed", "amended", "rejected"].includes(decision) || (decision === "amended" && !value)) {
  console.error("用法：replay-local.mts <请求正文.json> <confirmed|amended|rejected> [改后的内容] [--at now|<ISO 时间>] [--out <目录>]");
  process.exit(1);
}

const { createTestApp, TEST_MEMBER } = await import("../../apps/api/test/helpers.js");
const { requestFingerprint } = await import("../../apps/api/src/nexusDri.js");
const raw = readFileSync(file, "utf8").replace(/^﻿/, "");
const request = JSON.parse(raw);
const sampleSecret: string = JSON.parse(readFileSync(join(here, "../../apps/api/test/fixtures/nexus-dri-contract-examples.json"), "utf8")).signingDemonstration.secret;
const secret = process.env.NEXUS_DRI_CALLBACK_SECRET?.trim() || sampleSecret;
// 「现在」：缺省是请求创建后一分钟（过期的旧样例也能回放）；--at now 用真实时间。
const clock = at === "now" ? () => new Date() : (() => { const fixed = new Date(at ?? request.createdAt + 60_000); return () => fixed; })();

// 假的 Nexus 回调接收端：记下收到的原始正文和头，回 200。
const received: { body: Buffer; headers: Record<string, string> }[] = [];
const receiver = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    received.push({ body: Buffer.concat(chunks), headers: Object.fromEntries(["content-type", "x-dri-timestamp", "x-dri-signature"].map((name) => [name, String(req.headers[name])])) });
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, persisted: true, worldWritten: false }));
  });
});
await new Promise<void>((done) => receiver.listen(0, "127.0.0.1", done));

const TOKEN = "replay-local-token";
const people = join(mkdtempSync(join(tmpdir(), "nexus-dri-replay-")), "people.json");
writeFileSync(people, JSON.stringify({ people: { [TEST_MEMBER.personId]: request.proposedConfirmers?.[0] ?? "" } }));
const t = await createTestApp({
  worldInstanceLocalFile: people,
  nexusDri: { serviceToken: TOKEN, tenantId: request.recipientTenant, agentId: request.agentId, callbackSecret: secret, callbackUrl: `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/callbacks/dri` },
}, undefined, { monthlyNow: clock });

mkdirSync(out, { recursive: true });
const save = (name: string, content: string | Buffer) => { writeFileSync(join(out, name), content); console.log(`  已存 ${join(out, name)}`); };
let failed = false;
try {
  console.log(`「现在」按 ${clock().toISOString()}；签名密钥：${secret === sampleSecret ? "样例密钥" : "环境变量里的"}`);
  console.log("1. 推请求");
  const pushed = await t.app.inject({ method: "POST", url: "/api/integrations/nexus/dri/requests", payload: raw,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", "idempotency-key": `nexus-dri-delivery:${request.requestId}:${request.revision}` } });
  console.log(`  HTTP ${pushed.statusCode} ${pushed.body}`);
  if (pushed.statusCode !== 200) {
    if (pushed.json().code === "FINGERPRINT_MISMATCH") console.log(`  请求里的 fingerprint：${request.fingerprint}\n  天枢算出来的：      ${requestFingerprint(request)}`);
    throw new Error("请求没有被接收");
  }
  save("receipt.json", pushed.body);

  console.log(`2. 负责人（本体人员 ID ${request.proposedConfirmers[0]}）${decision}`);
  const cookie = await t.memberCookie();
  const items = (await t.app.inject({ method: "GET", url: "/api/me/nexus-confirmations", headers: { cookie } })).json().items as { id: string }[];
  if (!items.length) throw new Error("负责人的列表里没有这一条：多半是按上面的「现在」已经过期，换 --at 再试");
  const decided = await t.app.inject({ method: "POST", url: `/api/me/nexus-confirmations/${items[0].id}/decision`, headers: { cookie, origin: t.publicOrigin },
    payload: { decision, ...(decision === "amended" ? { value } : {}) } });
  console.log(`  HTTP ${decided.statusCode} ${decided.body}`);
  if (decided.statusCode !== 200) throw new Error("确认没有办成");
  const { confirmationRef } = decided.json();

  console.log("3. 确认记录（Nexus 按 confirmationRef 读回的那一份）");
  const record = await t.app.inject({ method: "GET", url: `/api/integrations/nexus/dri/confirmations/${confirmationRef}`, headers: { authorization: `Bearer ${TOKEN}` } });
  console.log(`  HTTP ${record.statusCode} ${record.body}`);
  save("confirmation-record.json", record.body);

  console.log("4. 回调 Nexus（打到本机假接收端）");
  await t.app.nexusDri.deliver(confirmationRef);
  if (!received.length) throw new Error("假接收端没有收到回调");
  console.log(`  头：${JSON.stringify(received[0].headers)}\n  正文：${received[0].body.toString("utf8")}`);
  save("callback-headers.json", JSON.stringify(received[0].headers, null, 2));
  save("callback-body.json", received[0].body);
} catch (error) {
  failed = true;
  console.error(`没有跑完：${(error as Error).message}`);
} finally {
  await t.close();
  await new Promise<void>((done) => receiver.close(() => done()));
}
process.exit(failed ? 1 : 0);
