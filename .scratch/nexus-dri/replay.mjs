// 本地回放 Nexus → DRI 确认（nexus-dri-confirmation/0.1）。只用 node 标准库，只打本机地址；凭据从环境变量读，不打印。
//
//   node .scratch/nexus-dri/replay.mjs receiver [端口，缺省 4321]
//     假的 Nexus 回调接收端：收到回调后用 NEXUS_DRI_CALLBACK_SECRET 验签，打印结果，回 200。
//   node .scratch/nexus-dri/replay.mjs push <天枢 api 地址> <负责人的本体人员 ID>
//     拿溪南的合成样例改成「现在创建、一小时后到期」的一条新请求（重算指纹）推给天枢，打印回执。
//     用到 NEXUS_DRI_SERVICE_TOKEN；租户和 agentId 取 NEXUS_DRI_TENANT_ID、NEXUS_DRI_AGENT_ID（缺省用样例里的值）。
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : value !== null && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
  : JSON.stringify(value);

const [mode, ...args] = process.argv.slice(2);
if (mode === "receiver") {
  const port = Number(args[0] ?? 4321);
  const secret = process.env.NEXUS_DRI_CALLBACK_SECRET ?? "";
  createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const timestamp = String(req.headers["x-dri-timestamp"]);
      const expected = `sha256=${createHmac("sha256", secret).update(`${timestamp}.`).update(body).digest("hex")}`;
      console.log(JSON.stringify({ signatureOk: expected === req.headers["x-dri-signature"], timestamp, callback: JSON.parse(body.toString("utf8")) }, null, 2));
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, persisted: true, worldWritten: false }));
    });
  }).listen(port, "127.0.0.1", () => console.log(`假接收端在 http://127.0.0.1:${port}/callbacks/dri`));
} else if (mode === "push") {
  const [base, confirmer] = args;
  const sample = JSON.parse(readFileSync(new URL("../../apps/api/test/fixtures/nexus-dri-contract-examples.json", import.meta.url), "utf8")).request;
  const now = Date.now();
  const requestId = `dri:replay-${now}`;
  const { fingerprint: _fingerprint, ...rest } = {
    ...sample, requestId, callbackCorrelation: requestId, itemId: `replay-item-${now}`, createdAt: now, expiresAt: now + 60 * 60 * 1000,
    proposedConfirmers: [confirmer], recipientTenant: process.env.NEXUS_DRI_TENANT_ID ?? sample.recipientTenant, agentId: process.env.NEXUS_DRI_AGENT_ID ?? sample.agentId,
  };
  const request = { ...rest, fingerprint: createHash("sha256").update(canonical(rest)).digest("hex") };
  const response = await fetch(`${base}/api/integrations/nexus/dri/requests`, {
    method: "POST", body: JSON.stringify(request),
    headers: { authorization: `Bearer ${process.env.NEXUS_DRI_SERVICE_TOKEN}`, "content-type": "application/json", "idempotency-key": `nexus-dri-delivery:${requestId}:${request.revision}` },
  });
  console.log(response.status, await response.text());
} else {
  console.error("用法见文件开头");
  process.exit(1);
}
