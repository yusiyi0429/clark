import { describe, expect, it, vi } from "vitest";
import type { TSessionCommandView } from "@warmap/contracts";
import { LocalRunnerError, type LocalRunner, type TLocalSessionSummary } from "@/lib/local/runner";
const actions = vi.hoisted(() => ({ claimSessionCommands: vi.fn(), reportSessionCommand: vi.fn(async () => undefined) }));
vi.mock("./actions", () => actions);

import { runClaimedCommands, runSessionCommand } from "./sessionCommands";

const SESSION = "00000000-0000-4000-8000-0000000000a1";
const OTHER = "00000000-0000-4000-8000-0000000000a2";
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
  it("同一条转话命令被认领两次，本机只送一次", async () => {
    // 本机收编号（protocol ≥ 2）：转话带命令的编号，被认领两次（租期过了另一个标签页又认领）时本机按编号认出是同一句
    const { runner: r, call } = runner();
    const withIds = Object.assign(r, { clientMessageIds: true });
    const twice = entry({ type: "message", text: "先停一下改测试" });
    await runSessionCommand(withIds, sessions, twice);
    await runSessionCommand(withIds, sessions, twice);
    expect(call.mock.calls).toEqual([[SESSION, "先停一下改测试", undefined, undefined, twice.id, undefined], [SESSION, "先停一下改测试", undefined, undefined, twice.id, undefined]]);
  });

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

describe("登记以后这一页马上认领（主循环第 61、62 条）", () => {
  it("说给开着的这个会话、不带约定版本的转话：走这一页的发话（先画出来），报 done；别的照旧调本机", async () => {
    const claimed = [entry({ type: "message", text: "本人补上了：申请号 A 无" }), entry({ type: "message", text: "约定改了", agreementRevision: 2 }), entry({ type: "message", text: "别的会话" }, OTHER)];
    actions.claimSessionCommands.mockResolvedValueOnce(claimed);
    const say = vi.fn(async () => true);
    const { runner: r, call } = runner();
    const refresh = vi.fn(async () => undefined);
    await runClaimedCommands("00000000-0000-4000-8000-0000000000d1", { runner: r, sessions: [{ id: SESSION }, { id: OTHER }] as TLocalSessionSummary[], refresh }, { sessionId: SESSION, say });
    expect(say).toHaveBeenCalledTimes(1);
    expect(say).toHaveBeenCalledWith("本人补上了：申请号 A 无");
    expect(call).toHaveBeenCalledWith(SESSION, "约定改了", undefined, undefined, undefined, 2);
    expect(call).toHaveBeenCalledWith(OTHER, "别的会话", undefined, undefined, undefined, undefined);
    expect(actions.reportSessionCommand).toHaveBeenCalledTimes(3);
    expect(refresh).toHaveBeenCalled();
  });
});
