import { describe, expect, it } from "vitest";
import type { TLocalSessionEvent } from "@warmap/contracts";
import { createMockRunner } from "./mock";
import { foldEvents } from "./sessionView";

/** 假本机演出主循环的几种情形（卡的标题里带关键字）。 */
const until = async (check: () => boolean) => { for (let i = 0; i < 400 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 2)); };

async function card(title: string) {
  const runner = createMockRunner({ stepMs: 1 });
  const session = await runner.createSession({ subject: { kind: "card", cardId: "c1" }, title, cwd: "C:\\work\\tianshu", firstMessage: "交代" });
  const seen: TLocalSessionEvent[] = [];
  const controller = new AbortController();
  void runner.watch(session.id, { after: 0, onEvent: (event) => seen.push(event), signal: controller.signal });
  // 批准、回答都照常过，走到下一处要人的地方。
  const pass = async () => {
    const request = foldEvents(seen).pending[0];
    if (request) await runner.decidePermission(session.id, request.requestId, { decision: "allow" });
    if (foldEvents(seen).question) await runner.sendMessage(session.id, "删掉");
  };
  return { runner, session, seen, pass, stop: () => controller.abort() };
}

describe("假本机：主循环的几种情形", () => {
  it("批准带一句人话和会动的文件；协议不低于 3", async () => {
    const { runner, seen, stop } = await card("普通的卡");
    await until(() => seen.some((event) => event.type === "permission_request"));
    const request = seen.find((event) => event.type === "permission_request");
    expect(request?.type === "permission_request" && request.request.description).toBe("跑一遍网页的测试，看改的地方有没有弄坏别的");
    expect(request?.type === "permission_request" && request.request.paths).toEqual(["apps/web/test-results/report.json"]);
    expect((await runner.health()).protocol).toBeGreaterThanOrEqual(3);
    stop();
  });

  it("「本人补」：第一次交回第 2 条要本人补，结论是等本人补；补了一句以后再交回，这回过了", async () => {
    const { runner, session, seen, pass, stop } = await card("候选名 本人补");
    await until(() => seen.some((event) => event.type === "permission_request"));
    await pass();
    await until(() => !!foldEvents(seen).question);
    await pass();
    await until(() => seen.some((event) => event.type === "verdict"));
    const first = seen.find((event) => event.type === "handback");
    expect(first?.type === "handback" && first.criteria[1]).toMatchObject({ result: "needs_person", need: expect.stringContaining("申请号") });
    const verdict = seen.find((event) => event.type === "verdict");
    expect(verdict?.type === "verdict" && [verdict.needsPerson, verdict.passed, verdict.blocked]).toEqual([true, false, false]);
    expect(verdict?.type === "verdict" && verdict.criteria[1]).toMatchObject({ verdict: "needs_person", fixBy: "person" });
    await runner.sendMessage(session.id, "近似商标申请号：A 无；B 第 12345678 号");
    await until(() => seen.filter((event) => event.type === "verdict").length === 2);
    const last = seen.filter((event) => event.type === "verdict").at(-1);
    expect(last?.type === "verdict" && [last.passed, last.needsPerson]).toEqual([true, false]);
    stop();
  });

  it("「改约定」：执行方提议改完成标准", async () => {
    const { seen, stop } = await card("候选名 改约定");
    await until(() => seen.some((event) => event.type === "agreement_proposal"));
    const proposal = seen.find((event) => event.type === "agreement_proposal");
    expect(proposal?.type === "agreement_proposal" && proposal.standards).toContain("近似商标由本人在商标网查");
    stop();
  });

  it("「重启」：做到一半本机程序重启，停下原因是本机程序重启；接着做能续上", async () => {
    const { runner, session, seen, stop } = await card("候选名 重启");
    await until(() => foldEvents(seen).stopped !== null);
    expect(foldEvents(seen).stopped?.why).toBe("runner_restart");
    await runner.sendMessage(session.id, "接着做");
    await until(() => seen.some((event) => event.type === "permission_request"));
    expect(foldEvents(seen).stopped).toBeNull();
    stop();
  });

  it("停下：本人停的、强停都带原因", async () => {
    const { runner, session, seen, stop } = await card("普通的卡");
    await until(() => seen.some((event) => event.type === "plan"));
    await runner.interrupt(session.id);
    expect(foldEvents(seen).stopped?.why).toBe("interrupted");
    await runner.kill(session.id);
    expect(foldEvents(seen).stopped?.why).toBe("killed");
    stop();
  });
});
