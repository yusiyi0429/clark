import { describe, expect, it, vi } from "vitest";
import type { TLocalSessionEvent } from "./runner";
import { foldEvents } from "./sessionView";
import { sayToSession } from "@/components/cards/SessionTranscript";

const at = "2026-11-19T01:00:00.000Z";
const ev = (seq: number, body: Record<string, unknown>) => ({ seq, at, sessionId: "s1", ...body }) as unknown as TLocalSessionEvent;

describe("压缩中（修复第 1 轮）", () => {
  it("事件 compacting 开、关跟着变；会话状态变了（进程没了、本机程序重启）也算压完", () => {
    expect(foldEvents([ev(1, { type: "compacting", on: true })]).compacting).toBe(true);
    expect(foldEvents([ev(1, { type: "compacting", on: true }), ev(2, { type: "compacting", on: false })]).compacting).toBe(false);
    expect(foldEvents([ev(1, { type: "compacting", on: true }), ev(2, { type: "status", status: "exited" })]).compacting).toBe(false);
    expect(foldEvents([]).compacting).toBe(false);
  });

  it("/compact 带参数、大小写不同也按压缩处理：有待批准时也直接交给本机，不当成「换个做法」", async () => {
    const runner = { sendMessage: vi.fn(async () => ({ delivery: "compact", messageId: "m" })), decidePermission: vi.fn() };
    const pending = [{ requestId: "r1" }] as never;
    await sayToSession(runner as never, "s1", pending, "  /COMPACT 只留结论 ");
    expect(runner.sendMessage).toHaveBeenCalledWith("s1", "  /COMPACT 只留结论 ", undefined, [], undefined);
    expect(runner.decidePermission).not.toHaveBeenCalled();
    await sayToSession(runner as never, "s1", pending, "/compactx");
    expect(runner.decidePermission).toHaveBeenCalledTimes(1);
  });
});
