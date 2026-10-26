import { describe, expect, it } from "vitest";
import { call, executionFixture, newTask, type Fixture } from "./executionFixture.js";
import { TEST_MEMBER } from "./helpers.js";

const rpc = (id: number, name: string, args: Record<string, unknown>) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
const agent = async (f: Fixture) => {
  const { token } = (await call(f, f.member, "POST", "/api/me/tokens", { name: "Claude", client: "claude", expiresInDays: 30 })).json();
  let id = 0;
  return async (name: string, args: Record<string, unknown>) => {
    const out = (await f.t.app.inject({ method: "POST", url: "/mcp/me",
      headers: { authorization: `Bearer ${token}`, accept: "application/json, text/event-stream" }, payload: rpc(++id, name, args) })).json().result;
    return { isError: out.isError as boolean, body: JSON.parse(out.content[0].text) };
  };
};
const withStandards = async (f: Fixture, title: string) =>
  (await call(f, f.member, "POST", "/api/me/tasks", newTask(null, { title, doneDefinition: "主线合入\n预发跑通" }))).json() as { id: string; version: number };
const fullChecks = [{ index: 0, met: true, evidence: "PR #45 已合入" }, { index: 1, met: true, evidence: "预发 46b8dab8 全程测过" }];

describe("执行事项怎么完成", () => {
  it("首页「完成 → 确认」：没有提交就按每条标准都达到记；有外部工具的提交就照它记；版本不对 409", async () => {
    const f = await executionFixture();
    try {
      const plain = await withStandards(f, "没人提交过");
      expect((await call(f, f.member, "POST", `/api/me/tasks/${plain.id}/complete`, { version: plain.version + 1 })).statusCode).toBe(409);
      const done = await call(f, f.member, "POST", `/api/me/tasks/${plain.id}/complete`, { version: plain.version });
      expect(done.statusCode).toBe(200);
      expect(done.json()).toMatchObject({ status: "done" });
      const detail = (await call(f, f.member, "GET", `/api/me/tasks/${plain.id}`)).json();
      expect(detail.acceptance).toMatchObject({ by: { personId: TEST_MEMBER.personId }, verdict: null,
        standards: [{ text: "主线合入", met: true, evidence: null }, { text: "预发跑通", met: true, evidence: null }] });
      expect(detail.acceptance.auto).toBeUndefined();
      expect((await call(f, f.member, "POST", `/api/me/tasks/${plain.id}/complete`, { version: detail.task.version })).json().code).toBe("TASK_ALREADY_DONE");
      // 别人的事项点不了。
      expect((await call(f, f.third, "POST", `/api/me/tasks/${plain.id}/complete`, { version: detail.task.version })).statusCode).toBe(404);

      const invoke = await agent(f);
      const submitted = await withStandards(f, "Claude 提交过");
      const sent = await invoke("submit_for_acceptance", { itemId: submitted.id, version: submitted.version, verdict: "差一条", confident: true,
        standards: [{ index: 0, met: true, evidence: "PR #45 已合入" }, { index: 1, met: false }] });
      // 不在灰度名单里：照常等本人确认。
      expect(sent.body).toMatchObject({ submittedForAcceptance: true, status: "in_progress" });
      expect((await call(f, f.member, "POST", `/api/me/tasks/${submitted.id}/complete`, { version: sent.body.version })).statusCode).toBe(200);
      expect((await call(f, f.member, "GET", `/api/me/tasks/${submitted.id}`)).json().acceptance).toMatchObject({ verdict: "差一条",
        standards: [{ met: true, evidence: "PR #45 已合入" }, { met: false, evidence: null }] });
    } finally { await f.t.close(); }
  });

  it("灰度：名单里的人，工具说有十足把握且每条标准都达到、都有依据，直接完成；缺一条依据或没说有把握就照常等确认", async () => {
    const f = await executionFixture("confirmed", "2026-10", {}, { taskAutoDonePersonIds: [TEST_MEMBER.personId] });
    try {
      const invoke = await agent(f);
      const sure = await withStandards(f, "有十足把握");
      const auto = await invoke("submit_for_acceptance", { itemId: sure.id, version: sure.version, verdict: "两条都达到", confident: true, standards: fullChecks });
      expect(auto.body).toMatchObject({ status: "done", autoDone: true });
      const detail = (await call(f, f.member, "GET", `/api/me/tasks/${sure.id}`)).json();
      expect(detail.acceptance).toMatchObject({ auto: "claude", verdict: "两条都达到", standards: [{ met: true, evidence: "PR #45 已合入" }, { met: true }] });
      expect(detail.submission).toBeNull();
      const notices = (await call(f, f.member, "GET", "/api/me/notifications")).json();
      expect(JSON.stringify(notices)).toContain("「有十足把握」已判定完成");
      expect(JSON.stringify((await call(f, f.member, "GET", `/api/threads/task/${sure.id}`)).json())).toContain("Claude Code 判定这件事完成了：两条都达到");
      // 不对可以重新打开。
      expect((await call(f, f.member, "POST", `/api/me/tasks/${sure.id}/reopen`, { version: detail.task.version })).json()).toMatchObject({ status: "in_progress" });

      const thin = await withStandards(f, "少一条依据");
      expect((await invoke("submit_for_acceptance", { itemId: thin.id, version: thin.version, confident: true,
        standards: [fullChecks[0], { index: 1, met: true }] })).body).toMatchObject({ submittedForAcceptance: true });
      const unsure = await withStandards(f, "没说有把握");
      expect((await invoke("submit_for_acceptance", { itemId: unsure.id, version: unsure.version, standards: fullChecks })).body).toMatchObject({ submittedForAcceptance: true });
      const noStandards = (await call(f, f.member, "POST", "/api/me/tasks", newTask(null, { title: "没写完成标准" }))).json();
      expect((await invoke("submit_for_acceptance", { itemId: noStandards.id, version: noStandards.version, confident: true })).body).toMatchObject({ submittedForAcceptance: true });
    } finally { await f.t.close(); }
  });
});
