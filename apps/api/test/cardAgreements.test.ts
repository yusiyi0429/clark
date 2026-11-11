import { describe, expect, it } from "vitest";
import { boardFixture } from "./boardFixture.js";

/** 主循环第 60 条：卡的约定唯一、能改、改了大家都知道。 */
describe("卡的约定", { timeout: 60_000 }, () => {
  const running = (title: string) => ["status", { status: "running", title, agent: "claude-code", modelLabel: "Opus 5.5" }] as [string, unknown];

  it("本人在会话详情里改：版本号加 1、记修改记录；一样的不记；在跑时登记转话带版本号；老路改完成标准同样记；完成了不能改", async () => {
    const f = await boardFixture({ boardCloudAgents: false });
    try {
      const id = await f.card("候选名初查", { doneDefinition: "列出 3 个候选名\n每个附近似商标的申请号" });
      const detail = async () => (await f.call("GET", `/api/me/cards/${id}`)).json();
      const version = async () => (await detail()).task.version as number;
      expect((await detail()).agreement).toEqual({ revision: 1, changes: 0, proposal: null });
      await f.call("PATCH", `/api/me/cards/${id}`, { version: await version(), executor: "claude_code" });
      expect((await detail()).agreement).toEqual({ revision: 1, changes: 0, proposal: null });
      const machine = await f.local();
      await machine.send({ kind: "card", cardId: id }, [running("候选名初查")]);

      const changed = await f.call("PATCH", `/api/me/cards/${id}`, { version: await version(), standards: ["列出 3 个候选名", "近似商标由本人查"], reason: "商标网拦自动访问" });
      expect(changed.statusCode).toBe(200);
      expect(await detail()).toMatchObject({ standards: ["列出 3 个候选名", "近似商标由本人查"], agreement: { revision: 2, changes: 1, proposal: null } });
      const changes = (await f.call("GET", `/api/me/cards/${id}/agreement-changes`)).json().changes;
      expect(changes).toEqual([{ id: expect.any(String), revision: 2, at: expect.any(String), by: { kind: "person", name: expect.any(String) },
        before: { brief: null, standards: ["列出 3 个候选名", "每个附近似商标的申请号"] }, after: { brief: null, standards: ["列出 3 个候选名", "近似商标由本人查"] },
        reason: "商标网拦自动访问" }]);
      // 执行方在跑：登记了一条转话，带新标准全文和版本号，那台电脑上的网页认领。
      const commands = (await f.call("POST", "/api/me/session-commands/claim", { deviceId: machine.device })).json().commands;
      expect(commands.map((entry: { command: unknown }) => entry.command)).toEqual([{ type: "message", agreementRevision: 2,
        text: "卡的约定改了（第 2 版），原因：商标网拦自动访问。按新的做，交回时逐条对新的完成标准自评。\n新的完成标准：\n1. 列出 3 个候选名\n2. 近似商标由本人查" }]);

      // 和原来一样：不记、版本号不动；只改执行方这类不算约定。
      await f.call("PATCH", `/api/me/cards/${id}`, { version: await version(), standards: ["列出 3 个候选名", "近似商标由本人查"] });
      expect((await detail()).agreement).toMatchObject({ revision: 2, changes: 1 });
      // 交代也是约定。
      await f.call("PATCH", `/api/me/cards/${id}`, { version: await version(), brief: "先查商标网" });
      expect((await detail()).agreement).toMatchObject({ revision: 3, changes: 2 });
      // 老路 PATCH 执行事项改完成标准：同样记。
      expect((await f.call("PATCH", `/api/me/tasks/${id}`, { version: await version(), doneDefinition: "列出 5 个候选名" })).statusCode).toBe(200);
      expect((await detail()).agreement).toMatchObject({ revision: 4, changes: 3 });
      expect((await f.call("GET", `/api/me/cards/${id}/agreement-changes`)).json().changes[0]).toMatchObject({ revision: 4, by: { kind: "person" }, reason: null,
        after: { standards: ["列出 5 个候选名"] } });
      // 本机交回前核对：设备令牌取最新的约定。
      const agreement = await f.t.app.inject({ method: "GET", url: `/api/local-runner/card-agreement?cardId=${id}`, headers: { authorization: `Bearer ${machine.token}` } });
      expect(agreement.json()).toEqual({ cardId: id, revision: 4, brief: "先查商标网", standards: ["列出 5 个候选名"] });
      expect((await f.t.app.inject({ method: "GET", url: "/api/local-runner/card-agreement?cardId=00000000-0000-4000-8000-000000000000",
        headers: { authorization: `Bearer ${machine.token}` } })).statusCode).toBe(404);

      expect((await f.call("PATCH", `/api/me/cards/${id}`, { version: await version(), standards: ["x".repeat(300), "y".repeat(300), ..."abcdef".split("").map((c) => c.repeat(300))] }))
        .json()).toMatchObject({ code: "TOO_LONG" });
      await f.t.sql("UPDATE tasks SET status='done' WHERE id=$1", [id]);
      expect((await f.call("PATCH", `/api/me/cards/${id}`, { version: await version(), standards: ["别的"] })).json()).toMatchObject({ code: "CARD_DONE" });
    } finally { await f.close(); }
  });

  it("执行方提议：钉一个在等的，新的顶掉旧的；改成这样照改（by worker）并告诉执行方；不改也告诉；定过的不能再定", async () => {
    const f = await boardFixture({ boardCloudAgents: false });
    try {
      const id = await f.card("候选名初查", { doneDefinition: "列出 3 个候选名\n每个附近似商标的申请号" });
      const machine = await f.local();
      const propose = (reason: string, standards: string[]) => machine.send({ kind: "card", cardId: id }, [running("候选名初查"), ["agreement_proposal", { standards, reason }]]);
      await propose("第一次", ["a"]);
      await propose("商标网要登录", ["列出 3 个候选名", "近似商标由本人查"]);
      const proposal = (await f.call("GET", `/api/me/cards/${id}`)).json().agreement.proposal;
      expect(proposal).toEqual({ id: expect.any(String), standards: ["列出 3 个候选名", "近似商标由本人查"], brief: null, reason: "商标网要登录", at: expect.any(String) });
      expect((await f.t.sql("SELECT reason,status FROM card_agreement_proposals WHERE card_id=$1 ORDER BY reason", [id])).map((row) => [row.reason, row.status]))
        .toEqual([["商标网要登录", "open"], ["第一次", "superseded"]]);

      const decide = (proposalId: string, decision: string) => f.call("POST", `/api/me/cards/${id}/agreement-proposals/${proposalId}/decision`, { decision });
      const accepted = await decide(proposal.id, "accept");
      expect(accepted.statusCode).toBe(200);
      expect(accepted.json()).toMatchObject({ standards: ["列出 3 个候选名", "近似商标由本人查"], agreement: { revision: 2, changes: 1, proposal: null } });
      expect((await f.call("GET", `/api/me/cards/${id}/agreement-changes`)).json().changes[0]).toMatchObject({ by: { kind: "worker", name: "执行方" }, reason: "商标网要登录" });
      expect((await decide(proposal.id, "reject")).json()).toMatchObject({ code: "PROPOSAL_CLOSED" });

      await propose("想去掉第一条", ["近似商标由本人查"]);
      const second = (await f.call("GET", `/api/me/cards/${id}`)).json().agreement.proposal;
      expect((await decide(second.id, "reject")).json()).toMatchObject({ standards: ["列出 3 个候选名", "近似商标由本人查"], agreement: { revision: 2, proposal: null } });
      const told = (await f.call("POST", "/api/me/session-commands/claim", { deviceId: machine.device })).json().commands.map((entry: { command: { text: string } }) => entry.command.text);
      // 测试时钟不走，两条同一时刻登记，认领的先后不定。
      expect(told).toHaveLength(2);
      expect(told).toEqual(expect.arrayContaining([expect.stringContaining("卡的约定改了（第 2 版），原因：商标网要登录。"), "本人不改约定，照原来的完成标准做。"]));
    } finally { await f.close(); }
  });
});
