import { describe, expect, it } from "vitest";
import { call, executionFixture, newTask, type Fixture } from "./executionFixture.js";

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
  it("TASK_AUTO_DONE=0 关掉时：工具说有十足把握、每条都达到也照常等本人确认", async () => {
    const f = await executionFixture("confirmed", "2026-10", {}, { taskAutoDone: false });
    try {
      const invoke = await agent(f);
      const item = await withStandards(f, "Claude 提交过");
      const sent = await invoke("submit_for_acceptance", { itemId: item.id, version: item.version, verdict: "两条都达到", confident: true, standards: fullChecks });
      expect(sent.body).toMatchObject({ submittedForAcceptance: true, status: "in_progress" });
      expect((await call(f, f.member, "GET", `/api/me/tasks/${item.id}`)).json()).toMatchObject({ acceptance: null, submission: { verdict: "两条都达到" } });
    } finally { await f.t.close(); }
  });

  it("默认所有人都开：工具说有十足把握且每条标准都达到、都有依据，直接完成；缺一条依据或没说有把握就照常等确认", async () => {
    const f = await executionFixture();
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
