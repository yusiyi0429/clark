// 压缩的超时兜底（修复第 1 轮）：执行方 5 分钟没回就以「没压缩成」放开；迟到的结束吞掉，不当成一轮结束（假时钟、假 claude、假 codex，不调模型）。
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeCodeAdapter } from "../src/agents/claudeCode.js";
import { CodexAdapter } from "../src/agents/codex.js";
import type { AgentLaunch, AgentRun } from "../src/agents/types.js";
import type { EventBody } from "../src/eventLog.js";
import { FAKE_CLAUDE, FAKE_CODEX, tempDir } from "./helpers.js";

const until = async (check: () => boolean, ms = 10_000) => {
  const t0 = Date.now();
  while (!check()) {
    if (Date.now() - t0 > ms) throw new Error("等待超时");
    await new Promise((r) => setTimeout(r, 20));
  }
};

function launch(cwd: string, model: AgentLaunch["model"]): AgentLaunch {
  return {
    sessionId: randomUUID(), cwd, resume: false, model, run: { model: "haiku", effort: "low", multiAgent: false }, includePersonalConfig: false,
    mcpConfigPath: null, mcpEnv: {}, allowedTools: [], disallowedTools: [], systemPromptPath: null, agentsPath: null, pluginDirs: [],
    allowedRoots: () => [cwd], autoAllowRoot: null, extraDirs: () => [], permissionMode: "auto",
  };
}
const origin = { kind: "anthropic", label: "Claude 订阅" } as unknown as AgentLaunch["model"]["origin"];

const runs: AgentRun[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(runs.splice(0).map((r) => r.kill()));
});

/** 压缩：开着假时钟发出去，拨过 5 分钟看它放开；之后换回真时钟等迟到的结束。 */
async function timesOut(run: AgentRun, events: EventBody[]) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const result = run.compact();
  // 执行方先回「开始压了」（Codex 的 turn/started 几毫秒就到）：真时间等一会儿，假时钟不动
  for (const t0 = Date.now(); Date.now() - t0 < 500;) await new Promise((r) => setImmediate(r));
  await vi.advanceTimersByTimeAsync(4 * 60_000 + 59_000);
  let settled = false;
  void result.then(() => { settled = true; });
  await Promise.resolve();
  expect(settled).toBe(false); // 不到 5 分钟还等着
  await vi.advanceTimersByTimeAsync(1_000);
  const r = await result;
  vi.useRealTimers();
  expect(r.ok).toBe(false);
  expect(r.text).toContain("5 分钟");
  return events.length;
}

describe("压缩的超时兜底", { timeout: 60_000 }, () => {
  it("压缩 5 分钟没回就放开，迟到的结束不触发一轮结束", async () => {
    // Claude Code：/compact 2 秒（真时钟）后才回 result
    const work = tempDir("tl-ctimeout-");
    writeFileSync(join(work, ".fake-claude.json"), JSON.stringify({ compactMs: 2_000 }));
    const claude = await new ClaudeCodeAdapter(async () => ({ command: process.execPath, prefixArgs: [FAKE_CLAUDE] }))
      .start(launch(work, { profileId: "p", label: "Claude 订阅", source: "subscription", baseUrl: null, model: null, smallModel: null, webSearch: true, apiKey: null, origin }));
    runs.push(claude);
    const events: EventBody[] = [];
    claude.onEvent((e) => events.push(e));
    const at = await timesOut(claude, events);
    // 迟到的 compact_boundary、result 到了：照记「压缩了上下文」、读一次用量，不报一轮的开始和结束
    await until(() => events.some((e) => e.type === "context_usage"));
    expect(events.slice(at).map((e) => e.type)).not.toContain("turn_end");
    expect(events.map((e) => e.type)).not.toContain("agent_info");
    // 之后正常的一轮照常报
    claude.send("做一件事");
    await until(() => events.some((e) => e.type === "turn_end"));
    expect(events.filter((e) => e.type === "agent_info")).toHaveLength(1);

    // Codex：thread/compact/start 之后 2 秒才 turn/completed
    const home = tempDir("tl-ctimeout-cx-");
    writeFileSync(join(home, "auth.json"), "{}");
    writeFileSync(join(home, "fake-compact-ms"), "2000");
    const dataDir = tempDir("tl-ctimeout-data-");
    mkdirSync(join(work, "cx"), { recursive: true });
    const codex = await new CodexAdapter(async () => ({ command: process.execPath, prefixArgs: [FAKE_CODEX] }), { home, dataDir })
      .start(launch(join(work, "cx"), { profileId: "c", label: "Codex 订阅", source: "subscription", baseUrl: null, model: "gpt-6.1-sol", smallModel: null, webSearch: true, apiKey: null, origin }));
    runs.push(codex);
    const cxEvents: EventBody[] = [];
    codex.onEvent((e) => cxEvents.push(e));
    const cxAt = await timesOut(codex, cxEvents);
    await until(() => cxEvents.some((e) => e.type === "notice" && e.code === "context_compacted"));
    await new Promise((r) => setTimeout(r, 200));
    expect(cxEvents.slice(cxAt).map((e) => e.type)).not.toContain("turn_end");
    expect(cxEvents.map((e) => e.type)).not.toContain("agent_info");
    codex.send("ctx 30000");
    await until(() => cxEvents.some((e) => e.type === "turn_end"));
    expect(cxEvents.filter((e) => e.type === "agent_info")).toHaveLength(1);

    // Codex 压缩时没报新的用量：不把压缩前的旧数再报一遍
    rmSync(join(home, "fake-compact-ms"));
    writeFileSync(join(home, "fake-compact-nousage"), "");
    const before = cxEvents.filter((e) => e.type === "context_usage").length;
    expect((await codex.compact()).ok).toBe(true);
    expect(cxEvents.filter((e) => e.type === "context_usage")).toHaveLength(before);
  });
});
