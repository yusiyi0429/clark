// 子会话换模型（设计 17.2 第 32 条，契约 LocalSessionModelRequest）：同一来源里当场换（set_model），跨来源这一轮做完后用 --resume 换上新模型重开；
// 都用假 claude 和假网关地址，不连真的网关、不用真钥匙。
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { LocalSessionModelResponse } from "@warmap/contracts";
import { registerFormats } from "../src/store.js";
import { api, pair, startTestRunner, tempDir } from "./helpers.js";

registerFormats();
async function until<T>(fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, ms = 15_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("等待超时");
    await new Promise((r) => setTimeout(r, 30));
  }
}

describe("子会话换模型", { timeout: 40_000 }, () => {
  let t: Awaited<ReturnType<typeof startTestRunner>>;
  let token: string;
  const work = tempDir("tl-swap-");
  const call = (method: string, path: string, body?: unknown) => api(t.port, token, method, path, body);
  const trace = () => readFileSync(join(work, ".fake-claude-trace.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const launches = (id: string) => trace().filter((l) => l.argv?.includes(id));
  const session = async (id: string) => (await call("GET", `/v1/sessions/${id}`)).body;
  const events = (id: string) => readFileSync(join(t.dataDir, "sessions", id, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const open = async (name: string) => {
    mkdirSync(join(work, name), { recursive: true });
    const r = await call("POST", "/v1/sessions", { subject: { kind: "card", cardId: name }, title: name, cwd: join(work, name), firstMessage: `做 ${name}` });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body.id as string;
  };
  const waitingPermission = (id: string) => until(async () => { const s = await session(id); return s.pendingPermissions[0] ?? null; });
  const allow = async (id: string) => {
    const p = await waitingPermission(id);
    expect((await call("POST", `/v1/sessions/${id}/permissions/${encodeURIComponent(p.requestId)}`, { decision: "allow" })).status).toBe(200);
  };
  const setModel = async (id: string, modelProfileId: string) => {
    const r = await call("PUT", `/v1/sessions/${id}/model`, { modelProfileId });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(Value.Check(LocalSessionModelResponse, r.body)).toBe(true);
    return r.body;
  };

  beforeAll(async () => {
    const offline = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    t = await startTestRunner({ pickFolder: work, fetchImpl: offline });
    token = await pair(t.port);
    await call("POST", "/v1/folders/pick", {});
    writeFileSync(join(work, ".fake-claude.json"), "{}");
    await call("PUT", "/v1/models/sub-haiku", { label: "订阅 Haiku", source: "subscription", model: "haiku" });
    await call("PUT", "/v1/models/th", { label: "TokenHub", source: "gateway", baseUrl: "https://tokenhub.example.com", model: "wangsu/qwen3.8-flash", apiKey: "sk-test-0123456789" });
  });
  afterAll(() => t.cleanup());

  it("同一来源里换（订阅 Opus 换 Haiku）：跑着也当场换，下一次回答起用新模型", async () => {
    const id = await open("A");
    await waitingPermission(id); // 一轮正在跑
    const r = await setModel(id, "sub-haiku");
    expect(r.applied).toBe("now");
    expect(r.session).toMatchObject({ modelProfileId: "sub-haiku", modelLabel: "订阅 Haiku", run: { model: "haiku", modelName: "Haiku", actual: null } });
    expect(r.session.pendingModel).toBeUndefined();
    expect(trace().some((l) => l.setModel === "haiku")).toBe(true);
    expect(launches(id)).toHaveLength(1); // 没重开
    expect(events(id).some((e) => e.type === "notice" && e.code === "model_changed")).toBe(true);
    // 下一轮开头执行方报的就是新的
    await allow(id);
    await until(async () => (await session(id)).session.status === "idle");
    await call("POST", `/v1/sessions/${id}/messages`, { text: "再来" });
    await until(async () => (await session(id)).session.run?.actual?.model === "claude-haiku-5-5");
    await call("POST", `/v1/sessions/${id}/kill`, {});
  });

  it("跨来源（订阅换 TokenHub）：跑着先记下，这一轮做完用 --resume 换上新模型重开，对话接着；云端的 status 带新的跑法", async () => {
    const id = await open("B");
    await waitingPermission(id);
    const r = await setModel(id, "th");
    expect(r.applied).toBe("after_turn");
    expect(r.session).toMatchObject({ modelProfileId: "subscription", pendingModel: { modelProfileId: "th", modelLabel: "TokenHub" } });
    expect(launches(id)).toHaveLength(1);
    await allow(id); // 这一轮做完 → 换
    await until(() => launches(id).length === 2);
    const s = await until(async () => { const x = (await session(id)).session; return x.modelProfileId === "th" && x.status === "idle" ? x : null; });
    expect(s.pendingModel).toBeUndefined();
    expect(s.run).toMatchObject({ source: "gateway", model: "wangsu/qwen3.8-flash", modelName: "qwen3.8-flash", origin: { provider: "tokenhub" } });
    const relaunch = launches(id)[1];
    expect(relaunch.argv).toContain("--resume");
    expect(relaunch.authToken).toBe("sk-test-0123456789");
    // 网关的模型名经 --settings 的 env 交给 Claude Code（假 claude 不读它，所以不看它报的实际模型）
    expect((relaunch.argv as string[]).join(" ")).toContain("wangsu/qwen3.8-flash");
    expect(relaunch.argv).not.toContain("--model");
    // 重开不算停了（不报 stopped），状态一直是等你回复
    const stops = (JSON.parse(readFileSync(join(t.dataDir, "outbox.json"), "utf8")).entries as { item: any }[]).map((e) => e.item).filter((i) => i.sessionId === id && i.type === "stopped");
    expect(stops).toHaveLength(1); // 只有那一轮做完
    const statuses = (JSON.parse(readFileSync(join(t.dataDir, "outbox.json"), "utf8")).entries as { item: any }[]).map((e) => e.item).filter((i) => i.sessionId === id && i.type === "status");
    expect(statuses.at(-1).data.run).toMatchObject({ model: "wangsu/qwen3.8-flash" });
    expect(statuses.some((x) => x.data.status === "exited" || x.data.status === "failed")).toBe(false);
    // 接着说话：新进程收下
    expect((await call("POST", `/v1/sessions/${id}/messages`, { text: "接着做" })).body.delivery).toBe("new_turn");
    await waitingPermission(id);
    expect(launches(id)).toHaveLength(2);
    await call("POST", `/v1/sessions/${id}/kill`, {});
  });

  it("等你回复时跨来源换：当场重开，回「已生效」", async () => {
    const id = await open("C");
    await allow(id);
    await until(async () => (await session(id)).session.status === "idle");
    const r = await setModel(id, "th");
    expect(r.applied).toBe("now");
    await until(() => launches(id).length === 2);
    expect(launches(id)[1].argv).toContain("--resume");
    await until(async () => (await session(id)).session.modelProfileId === "th");
    await call("POST", `/v1/sessions/${id}/kill`, {});
  });

  it("思考程度：订阅能选五档、网关不能选；开工带了就照它传，不能选的回 400", async () => {
    const profiles = (await call("GET", "/v1/models")).body.profiles;
    expect(Object.fromEntries(profiles.map((p: any) => [p.id, [p.efforts, p.defaultEffort]]))).toEqual({
      subscription: [["low", "medium", "high", "xhigh", "max"], null], "sub-haiku": [["low", "medium", "high", "xhigh", "max"], null], th: [[], null],
    });
    mkdirSync(join(work, "E"), { recursive: true });
    const bad = await call("POST", "/v1/sessions", { subject: { kind: "card", cardId: "E" }, title: "E", cwd: join(work, "E"), firstMessage: "做 E", modelProfileId: "th", effort: "high" });
    expect([bad.status, bad.body.error.message]).toEqual([400, "「TokenHub」不能选「high」这档思考程度"]);
    expect((await call("POST", "/v1/runs/preview", { effort: "xhigh" })).body).toMatchObject({ effort: "xhigh" });
    const r = await call("POST", "/v1/sessions", { subject: { kind: "card", cardId: "E" }, title: "E", cwd: join(work, "E"), firstMessage: "做 E", effort: "xhigh" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ effort: "xhigh", run: { effort: "xhigh" } });
    await until(() => launches(r.body.id).length === 1);
    const argv = launches(r.body.id)[0].argv as string[];
    expect(argv[argv.indexOf("--effort") + 1]).toBe("xhigh");
    await call("POST", `/v1/sessions/${r.body.id}/kill`, {});
  });

  it("开着换思考程度：Claude Code 当场换（apply_flag_settings），不重开；null 回到自动；换模型时选的那档新模型支持就留着", async () => {
    const id = await open("F");
    await waitingPermission(id);
    const up =await call("PUT", `/v1/sessions/${id}/model`, { effort: "max" });
    expect(up.body).toMatchObject({ applied: "now", session: { modelProfileId: "subscription", effort: "max", run: { effort: "max" } } });
    expect(trace().filter((l) => l.applyFlags?.effortLevel).map((l) => l.applyFlags.effortLevel)).toContain("max");
    expect(launches(id)).toHaveLength(1);
    // 回到自动：标准档是 medium
    const auto = await call("PUT", `/v1/sessions/${id}/model`, { effort: null });
    expect(auto.body.session.effort).toBeUndefined();
    expect(auto.body.session.run.effort).toBe("medium");
    // 选了 high 再换成订阅 Haiku：high 留着，只换模型
    await call("PUT", `/v1/sessions/${id}/model`, { effort: "high" });
    const haiku = await call("PUT", `/v1/sessions/${id}/model`, { modelProfileId: "sub-haiku" });
    expect(haiku.body).toMatchObject({ applied: "now", session: { modelProfileId: "sub-haiku", effort: "high", run: { model: "haiku", effort: "high" } } });
    // 网关不能选思考程度；什么都不带回 400
    expect((await call("PUT", `/v1/sessions/${id}/model`, { modelProfileId: "th", effort: "low" })).status).toBe(400);
    expect((await call("PUT", `/v1/sessions/${id}/model`, {})).status).toBe(400);
    // 换到网关：选的那档它不支持，回到自动（网关不传思考程度）
    const th = await call("PUT", `/v1/sessions/${id}/model`, { modelProfileId: "th" });
    expect(th.body).toMatchObject({ applied: "after_turn", session: { pendingModel: { modelProfileId: "th", effort: null } } });
    await call("POST", `/v1/sessions/${id}/kill`, {});
    await until(async () => (await session(id)).session.modelProfileId === "th");
    expect((await session(id)).session.effort).toBeUndefined();
  });

  it("进程不在（强停了）：直接换，下次开起来用新的；没有这个配置回 400", async () => {
    const id = await open("D");
    await waitingPermission(id);
    await call("POST", `/v1/sessions/${id}/kill`, {});
    await until(async () => (await session(id)).session.status === "exited");
    const r = await setModel(id, "sub-haiku");
    expect([r.applied, r.session.modelProfileId]).toEqual(["now", "sub-haiku"]);
    await call("POST", `/v1/sessions/${id}/messages`, { text: "接着" });
    await until(() => launches(id).length === 2);
    const argv = launches(id)[1].argv as string[];
    expect([argv.includes("--resume"), argv[argv.indexOf("--model") + 1]]).toEqual([true, "haiku"]);
    expect((await call("PUT", `/v1/sessions/${id}/model`, { modelProfileId: "nope" })).status).toBe(400);
    await call("POST", `/v1/sessions/${id}/kill`, {});
  });
});
