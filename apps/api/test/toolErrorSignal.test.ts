import { afterEach, describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { ConversationSseEvent } from "@warmap/contracts";
import type { ConversationRuntime } from "../src/conversations.js";
import { toolErrorCode } from "../src/piConversationRuntime.js";
import { createTestApp, type TestApp } from "./helpers.js";

/** 对话里的工具报错或超时：运行记录的 qualitySignals 记一条 {kind:"tool_error", tool, code, at}（管理员视图「质量信号」读它）。 */
let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => { await cleanup?.(); cleanup = undefined; });

describe("工具报错的质量信号", () => {
  it("工具超时、报错各记一条，界面收到的事件不带错误码；没出错不记", async () => {
    let failing = true;
    const runtime: ConversationRuntime = { async run(input) {
      if (failing) {
        input.emit({ type: "tool", phase: "started", toolCallId: "t1", name: "read_progress" });
        input.emit({ type: "tool", phase: "completed", toolCallId: "t1", name: "read_progress", isError: true, errorCode: "TOOL_TIMEOUT" });
        input.emit({ type: "tool", phase: "started", toolCallId: "t2", name: "web_search" });
        input.emit({ type: "tool", phase: "completed", toolCallId: "t2", name: "web_search", isError: true });
      }
      input.emit({ type: "message", delta: "好" });
      return { assistantMessage: "好", runtimeEntries: input.runtimeEntries };
    } };
    const t: TestApp = await createTestApp({}, runtime);
    cleanup = () => t.close();
    const cookie = await t.loginCookie();
    const send = () => t.app.inject({ method: "POST", url: "/api/conversations/global/messages", headers: { cookie, origin: t.publicOrigin }, payload: { message: "进展怎样" } });
    const response = await send();
    const events = response.body.trim().split("\n\n").flatMap((block) => block.split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6))));
    for (const event of events) expect(Value.Check(ConversationSseEvent, event)).toBe(true);
    expect(events.some((event) => "errorCode" in event)).toBe(false);

    const [run] = await t.agentRuns();
    expect(run.input_snapshot.qualitySignals).toEqual([
      { kind: "tool_error", tool: "read_progress", code: "TOOL_TIMEOUT", at: expect.any(String) },
      { kind: "tool_error", tool: "web_search", code: "TOOL_ERROR", at: expect.any(String) },
    ]);
    expect(Number.isNaN(Date.parse(run.input_snapshot.qualitySignals[0].at))).toBe(false);

    failing = false;
    await send();
    const runs = await t.agentRuns();
    expect(runs.at(-1)!.input_snapshot.qualitySignals).toBeUndefined();
  }, 60_000);

  it("错误类别：超时、检索到上限、工具自己的错误码，其余 TOOL_ERROR", () => {
    expect(toolErrorCode({ content: [{ type: "text", text: "这一步（读进展）超过 90 秒没有返回，已跳过。" }] })).toBe("TOOL_TIMEOUT");
    expect(toolErrorCode({ content: [{ type: "text", text: JSON.stringify({ code: "PERSONAL_MISSION_CARD_NOT_FOUND", message: "任务卡不存在" }) }] })).toBe("PERSONAL_MISSION_CARD_NOT_FOUND");
    expect(toolErrorCode({ content: [{ type: "text", text: "本轮检索已到上限（8 次），这次没有执行检索。" }] })).toBe("SEARCH_LIMIT");
    expect(toolErrorCode({ content: [{ type: "text", text: "boom" }] })).toBe("TOOL_ERROR");
    expect(toolErrorCode(undefined)).toBe("TOOL_ERROR");
  });
});
