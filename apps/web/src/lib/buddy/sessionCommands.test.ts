import { describe, expect, it, vi } from "vitest";
import type { TSessionCommandView } from "@warmap/contracts";
import { LocalRunnerError, type LocalRunner, type TLocalSessionSummary } from "@/lib/local/runner";
import { runSessionCommand } from "./sessionCommands";

const SESSION = "00000000-0000-4000-8000-0000000000a1";
const entry = (command: TSessionCommandView["command"], sessionId = SESSION): TSessionCommandView => ({
  id: "00000000-0000-4000-8000-0000000000f1", kind: "card", subSessionId: "00000000-0000-4000-8000-0000000000c1", sessionId,
  deviceId: "00000000-0000-4000-8000-0000000000d1", requestedAt: "2026-11-09T01:00:00Z", command,
});
const sessions = [{ id: SESSION }] as TLocalSessionSummary[];
const runner = (fail?: Error) => {
  const call = vi.fn(async () => { if (fail) throw fail; return {}; });
  return { runner: { sendMessage: call, answerQuestion: call, decidePermission: call } as unknown as LocalRunner, call };
};

describe("网页认领主管线按字母发来的动作（18.10）", () => {
  it("转话、回答、批准各调本机对应的接口，报 done", async () => {
    const { runner: r, call } = runner();
    expect(await runSessionCommand(r, sessions, entry({ type: "message", text: "先停一下改测试" }))).toEqual({ result: "done" });
    expect(call).toHaveBeenLastCalledWith(SESSION, "先停一下改测试", undefined, undefined, undefined, undefined);
    await runSessionCommand(r, sessions, entry({ type: "message", text: "约定改了，按新的完成标准做", agreementRevision: 3 }));
    expect(call).toHaveBeenLastCalledWith(SESSION, "约定改了，按新的完成标准做", undefined, undefined, undefined, 3);
    await runSessionCommand(r, sessions, entry({ type: "answer", requestId: "q1", answer: { choices: [["zod"]] } }));
    expect(call).toHaveBeenLastCalledWith(SESSION, "q1", { choices: [["zod"]] });
    await runSessionCommand(r, sessions, entry({ type: "permission", requestId: "p1", decision: { decision: "allow" } }));
    expect(call).toHaveBeenLastCalledWith(SESSION, "p1", { decision: "allow" });
  });

  it("本机上没有这个会话报 not_running；回答、批准过的（409）报 expired；本机拒了报 failed 带原因；连不上不报", async () => {
    expect(await runSessionCommand(runner().runner, [], entry({ type: "message", text: "x" }))).toEqual({ result: "not_running" });
    const handled = new LocalRunnerError("conflict", "已经处理过了", 409);
    expect(await runSessionCommand(runner(handled).runner, sessions, entry({ type: "answer", requestId: "q1", answer: { choices: [] } }))).toEqual({ result: "expired" });
    expect(await runSessionCommand(runner(new LocalRunnerError("validation", "不认识的选项", 400)).runner, sessions, entry({ type: "permission", requestId: "p1", decision: { decision: "deny" } })))
      .toEqual({ result: "failed", message: "不认识的选项" });
    expect(await runSessionCommand(runner(new LocalRunnerError("network", "连不上")).runner, sessions, entry({ type: "message", text: "x" }))).toBeNull();
  });
});
