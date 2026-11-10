// 每个子会话显示「哪个来源的哪个模型」：开工前预览「自动」落到哪，开跑后以执行方自己报的为准，对不上时记一条（契约 LocalRun、POST /v1/runs/preview）。
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { LocalRun, LocalSessionSummary } from "@warmap/contracts";
import { modelDisplayName, sameModel } from "../src/models.js";
import { registerFormats } from "../src/store.js";
import { api, pair, startTestRunner, tempDir } from "./helpers.js";

registerFormats();
/** 等到 fn 回真值（fn 可以是异步的）。 */
async function until<T>(fn: () => Promise<T | null | undefined | false>, ms = 15_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("等待超时");
    await new Promise((r) => setTimeout(r, 30));
  }
}
const conforms = (schema: Parameters<typeof Value.Check>[0], value: unknown) => {
  expect([...Value.Errors(schema, value)].map((e) => `${e.path} ${e.message}`)).toEqual([]);
};

describe("模型名", () => {
  it("给人看的名字：Claude 模型写系列和版本，别名写系列，网关模型去掉厂商前缀原样", () => {
    expect(modelDisplayName("claude-opus-5-5")).toBe("Opus 5.5");
    expect(modelDisplayName("claude-sonnet-4-20250514")).toBe("Sonnet 4");
    expect(modelDisplayName("claude-haiku-5-5[1m]")).toBe("Haiku 5.5");
    expect(modelDisplayName("wangsu/claude-opus-5-5")).toBe("Opus 5.5");
    expect(modelDisplayName("opus")).toBe("Opus");
    expect(modelDisplayName("wangsu/qwen3.8-flash")).toBe("qwen3.8-flash");
    expect(modelDisplayName("deepseek-v4")).toBe("deepseek-v4");
  });
  it("请求的和实际的是不是同一个：一样，或者别名落到这个系列的某一版", () => {
    expect(sameModel("opus", "claude-opus-5-5")).toBe(true);
    expect(sameModel("opus", "claude-sonnet-5-5")).toBe(false);
    expect(sameModel("wangsu/qwen3.8-flash", "wangsu/qwen3.8-flash")).toBe(true);
    expect(sameModel("claude-opus-5-5", "claude-opus-5-5[1m]")).toBe(true);
    expect(sameModel("wangsu/qwen3.8-flash", "wangsu/deepseek-v4")).toBe(false);
  });
});

async function setup() {
  const work = tempDir("tl-model-");
  const offline = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
  const t = await startTestRunner({ pickFolder: work, fetchImpl: offline });
  const token = await pair(t.port);
  const call = (method: string, path: string, body?: unknown) => api(t.port, token, method, path, body);
  await call("POST", "/v1/folders/pick", {});
  const fake = (cfg: Record<string, unknown>) => writeFileSync(join(work, ".fake-claude.json"), JSON.stringify(cfg));
  fake({});
  const session = async (id: string) => (await call("GET", `/v1/sessions/${id}`)).body.session;
  const open = async (title: string, extra: Record<string, unknown> = {}) => {
    // 卡在本人允许的文件夹里做：假 claude 读得到那里的 .fake-claude.json（专题的专用目录读不到）
    mkdirSync(join(work, title), { recursive: true });
    const r = await call("POST", "/v1/sessions", { subject: { kind: "card", cardId: title }, title, cwd: join(work, title), firstMessage: `做 ${title}`, ...extra });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body as { id: string };
  };
  const events = (id: string) => readFileSync(join(t.dataDir, "sessions", id, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const statusSynced = (id: string) => JSON.parse(readFileSync(join(t.dataDir, "outbox.json"), "utf8")).entries
    .map((e: any) => e.item).filter((i: any) => i.type === "status" && i.sessionId === id).map((i: any) => i.data);
  const preview = async (body: unknown) => { const r = await call("POST", "/v1/runs/preview", body); expect(r.status, JSON.stringify(r.body)).toBe(200); return r.body; };
  return { t, call, fake, session, open, events, statusSynced, preview };
}

describe("哪个来源的哪个模型", { timeout: 60_000 }, () => {
  it("订阅「自动」：开工前预览落到 Opus、思考 medium；开跑后以 Claude Code 报的为准（Opus 5.5），进摘要和同步；记下别名落到的版本，之后预览写版本号", async () => {
    const h = await setup();
    try {
      const before = await h.preview({});
      conforms(LocalRun, before);
      expect(before).toEqual({
        mode: "auto", model: "opus", effort: "medium", multiAgent: false,
        source: "subscription", sourceLabel: "Claude 订阅", modelName: "Opus", actual: null,
        harness: "claude-code", origin: { provider: "claude-subscription", label: "Claude 订阅", via: null },
      });
      expect(await h.preview({ modelTier: "light" })).toMatchObject({ model: "sonnet", effort: "low", modelName: "Sonnet" });
      expect(await h.preview({ taskBudget: { taskId: "T-9", budget: { mode: "unlimited", hours: null, weeklyPercent: null, money: null } } }))
        .toMatchObject({ mode: "unlimited", model: "opus", effort: "max", multiAgent: true });

      const a = await h.open("A");
      const s = await until(async () => { const x = await h.session(a.id); return x.run?.actual && x; });
      conforms(LocalSessionSummary, s);
      expect(s.run).toMatchObject({ source: "subscription", sourceLabel: "Claude 订阅", model: "opus", modelName: "Opus" });
      expect(s.run.actual).toMatchObject({ model: "claude-opus-5-5", modelName: "Opus 5.5" });
      // 同步给云端的 status 也带着（手机看得到）
      expect(h.statusSynced(a.id).some((d: any) => d.run?.actual?.modelName === "Opus 5.5" && d.run.sourceLabel === "Claude 订阅")).toBe(true);
      // 别名落到的是同系列的一版：不算对不上
      expect(h.events(a.id).some((e) => e.type === "notice" && e.code === "model_mismatch")).toBe(false);
      // 之后开工前就写得出版本号
      expect((await h.preview({})).modelName).toBe("Opus 5.5");
    } finally {
      await h.t.cleanup();
    }
  });

  it("实际跑的和请求的对不上：以实际为准，记一条 model_mismatch，同步里也是实际的；不当成别名的版本记下", async () => {
    const h = await setup();
    try {
      h.fake({ initModel: "claude-sonnet-5-5" });
      const a = await h.open("B");
      const s = await until(async () => { const x = await h.session(a.id); return x.run?.actual && x; });
      expect(s.run).toMatchObject({ model: "opus", modelName: "Opus", actual: { model: "claude-sonnet-5-5", modelName: "Sonnet 5.5" } });
      const notices = h.events(a.id).filter((e) => e.type === "notice" && e.code === "model_mismatch");
      expect(notices).toHaveLength(1);
      expect(notices[0].text).toContain("claude-sonnet-5-5");
      const withActual = h.statusSynced(a.id).filter((d: any) => d.run?.actual);
      expect(withActual.at(-1).run.actual.model).toBe("claude-sonnet-5-5");
      // 订阅的别名没落到同系列：不当成 opus 的版本记下
      expect((await h.preview({})).modelName).toBe("Opus");
    } finally {
      await h.t.cleanup();
    }
  });

  it("TokenHub：预览写配置的名字和去掉前缀的模型名，不传思考强度；没有这个配置回 400", async () => {
    const h = await setup();
    try {
      const put = await h.call("PUT", "/v1/models/th", { label: "TokenHub", source: "gateway", baseUrl: "https://tokenhub.example.com", model: "wangsu/qwen3.8-flash", apiKey: "sk-test" });
      expect(put.status, JSON.stringify(put.body)).toBe(200);
      expect(await h.preview({ modelProfileId: "th", modelTier: "strong" })).toEqual({
        mode: "auto", model: "wangsu/qwen3.8-flash", effort: null, multiAgent: false,
        source: "gateway", sourceLabel: "TokenHub", modelName: "qwen3.8-flash", actual: null,
        harness: "claude-code", origin: { provider: "tokenhub", label: "TokenHub", via: null },
      });
      expect((await h.call("POST", "/v1/runs/preview", { modelProfileId: "nope" })).status).toBe(400);
      expect((await h.call("POST", "/v1/runs/preview", { title: "多余" })).status).toBe(400);
    } finally {
      await h.t.cleanup();
    }
  });
});
