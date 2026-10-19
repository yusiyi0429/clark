import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { ConversationSseEvent } from "@warmap/contracts";
import { createTestApp } from "./helpers.js";
import type { ConversationRuntime } from "../src/conversations.js";

function parseSse(body: string): Record<string, unknown>[] {
  return body.trim().split("\n\n").flatMap((block) => {
    const line = block.split("\n").find((candidate) => candidate.startsWith("data: "));
    return line ? [JSON.parse(line.slice(6)) as Record<string, unknown>] : [];
  });
}
type Emit = Parameters<ConversationRuntime["run"]>[0]["emit"];
const tool = (emit: Emit, phase: "started" | "completed", toolCallId: string, name: string, extra: { detail?: string; isError?: boolean } = {}) =>
  emit({ type: "tool", phase, toolCallId, name, ...(phase === "completed" ? { isError: extra.isError ?? false } : {}), ...(extra.detail ? { detail: extra.detail } : {}) });

describe("当前步骤：工具开始、结束映射成 step 事件，存进运行记录", () => {
  it("同类工具并成一步、做完打勾带结果；再次用到时那一步重新变成当前步骤；没有步骤名的工具不显示", async () => {
    const t = await createTestApp({}, { async run(input) {
      tool(input.emit, "started", "a", "read_mission_card");
      tool(input.emit, "completed", "a", "read_mission_card");
      tool(input.emit, "started", "b", "query_company");
      tool(input.emit, "started", "c", "read_ontology");
      tool(input.emit, "completed", "b", "query_company", { detail: "本体里找到 2 条：《经营原则》" });
      tool(input.emit, "completed", "c", "read_ontology", { detail: "读到本体《经营原则》" });
      tool(input.emit, "started", "d", "some_unmapped_tool");
      tool(input.emit, "completed", "d", "some_unmapped_tool");
      tool(input.emit, "started", "e", "read_mission_card");
      tool(input.emit, "completed", "e", "read_mission_card");
      input.emit({ type: "message", delta: "好" });
      return { assistantMessage: "好", runtimeEntries: input.runtimeEntries };
    } });
    try {
      const response = await t.app.inject({ method: "POST", url: "/api/conversations/global/messages",
        headers: { cookie: await t.loginCookie(), origin: t.publicOrigin, accept: "text/event-stream" }, payload: { message: "看看本月 Mission" } });
      const events = parseSse(response.body);
      const steps = events.filter((event) => event.type === "step");
      for (const event of steps) expect(Value.Check(ConversationSseEvent, event)).toBe(true);
      expect(steps.map(({ id, label, status, result }) => ({ id, label, status, ...(result ? { result } : {}) }))).toEqual([
        { id: "s1", label: "读 Mission 卡", status: "active" },
        { id: "s1", label: "读 Mission 卡", status: "done" },
        { id: "s2", label: "查本体", status: "active" },
        { id: "s2", label: "查本体", status: "done", result: "读到本体《经营原则》" },
        { id: "s1", label: "读 Mission 卡", status: "active" },
        { id: "s1", label: "读 Mission 卡", status: "done" },
      ]);
      const [run] = await t.sql("SELECT input_snapshot->'steps' AS steps FROM agent_runs WHERE kind = 'conversation'");
      expect(run.steps).toEqual([
        { id: "s1", label: "读 Mission 卡", status: "done" },
        { id: "s2", label: "查本体", status: "done", result: "读到本体《经营原则》" },
      ]);
    } finally {
      await t.close();
    }
  });

  it("这一轮没完成：还在进行的那一步记为 stopped，界面与运行记录一致", async () => {
    const t = await createTestApp({}, { async run(input) {
      tool(input.emit, "started", "a", "web_search");
      throw new Error("upstream down");
    } });
    try {
      const response = await t.app.inject({ method: "POST", url: "/api/conversations/global/messages",
        headers: { cookie: await t.loginCookie(), origin: t.publicOrigin, accept: "text/event-stream" }, payload: { message: "外面怎么说" } });
      const steps = parseSse(response.body).filter((event) => event.type === "step");
      expect(steps.map(({ label, status }) => [label, status])).toEqual([["查公开来源", "active"], ["查公开来源", "stopped"]]);
      const [run] = await t.sql("SELECT status, input_snapshot->'steps' AS steps FROM agent_runs WHERE kind = 'conversation'");
      expect(run).toEqual({ status: "failed", steps: [{ id: "s1", label: "查公开来源", status: "stopped" }] });
    } finally {
      await t.close();
    }
  });
});
