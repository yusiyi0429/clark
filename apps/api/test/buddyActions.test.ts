import { describe, expect, it } from "vitest";
import type { FeishuClient } from "../src/feishu/client.js";
import { BOARD_NOW, boardFixture, THIRD } from "./boardFixture.js";
import { TEST_CEO, TEST_MEMBER } from "./helpers.js";

/**
 * 新首页 17.4：伙伴代本人做事。授权、Chat 的通用入口（动作清单、按名字执行）、审计和撤销、子会话的开工 / 停掉 / 归档 / 删进回收站、
 * 「请这台电脑停掉」、转达给同事、服务凭据轮换和来源地址。对话流里插帧在 chatService.test.ts。
 */

const TOKEN = "chat-token";
const running = (title: string) => ["status", { status: "running", title, agent: "claude-code", modelLabel: "订阅 · Sonnet" }] as [string, unknown];

async function fixture(seed: Parameters<typeof boardFixture>[1] = {}) {
  const sent: { id: string; text: string }[] = [];
  const feishuClient = { sendMessage: async (_type: string, id: string, _msgType: string, content: { text: string }) => {
    sent.push({ id, text: content.text });
    return { messageId: "om_test" };
  } } as unknown as FeishuClient;
  const f = await boardFixture({ feishuClient }, { boardCloudAgents: false, internalChatToken: TOKEN, ...seed });
  const act = (name: string, args: unknown, options: { token?: string; ip?: string; owner?: string } = {}) => f.t.app.inject({ method: "POST",
    url: `/internal/me/buddy-actions/${name}`, headers: { authorization: `Bearer ${options.token ?? TOKEN}`, "x-owner-id": options.owner ?? TEST_MEMBER.personId },
    payload: { args }, ...(options.ip ? { remoteAddress: options.ip } : {}) });
  const ok = async (name: string, args: unknown) => {
    const res = await act(name, args);
    if (res.statusCode !== 200) throw new Error(`${name}: ${res.body}`);
    return res.json() as { summary: string; result: Record<string, unknown> | null; auditId: string | null; undoable: boolean };
  };
  const grant = () => f.call("PUT", "/api/me/buddy-authority", { authority: "full" });
  const undo = (auditId: string) => f.call("POST", `/api/me/buddy-actions/log/${auditId}/undo`);
  /** 交给 Claude Code 的卡（子会话）。 */
  const agentCard = async (title: string) => {
    const id = await f.card(title);
    await f.t.sql("UPDATE tasks SET executor='claude_code' WHERE id=$1", [id]);
    return id;
  };
  return { ...f, act, ok, grant, undo, agentCard, sent };
}

describe("伙伴代本人做事（17.4）", { timeout: 60_000 }, () => {
  it("授权：缺省只能读，动作清单只有读、界面和计划清单，写动作 403；同意以后清单是全部、写动作照做；没有的动作 404、参数不对 400；别人的东西照网页接口 404", async () => {
    const f = await fixture();
    try {
      expect((await f.call("GET", "/api/me/buddy-authority")).json()).toEqual({ authority: "none", grantedAt: null });
      const list = async () => (await f.t.app.inject({ method: "GET", url: "/internal/me/buddy-actions",
        headers: { authorization: `Bearer ${TOKEN}`, "x-owner-id": TEST_MEMBER.personId } })).json();
      expect((await list()).actions.map((action: { name: string }) => action.name)).toEqual(["read_work_home", "read_project", "open_page", "update_plan"]);
      const denied = await f.act("set_appearance", { appearance: "dark" });
      expect([denied.statusCode, denied.json().code]).toEqual([403, "BUDDY_NOT_AUTHORIZED"]);
      expect((await f.call("GET", "/api/me/appearance")).json()).toEqual({ appearance: "system" });
      // 读和界面动作没授权也能用。
      expect((await f.ok("read_work_home", {})).result).toHaveProperty("projects");
      expect(await f.ok("open_page", { target: { kind: "preferences" } })).toMatchObject({ auditId: null, undoable: false });

      const granted = (await f.grant()).json();
      expect(granted).toMatchObject({ authority: "full", grantedAt: expect.any(String) });
      // 再打开一次不改时间；关掉清掉。
      expect((await f.grant()).json()).toEqual(granted);
      const all = await list();
      expect(all.authority).toEqual(granted);
      expect(all.actions).toHaveLength(19);
      expect(all.actions.find((action: { name: string }) => action.name === "send_message")).toMatchObject({ kind: "write", parameters: { type: "object" } });

      expect((await f.act("fly_away", {})).json().code).toBe("UNKNOWN_ACTION");
      const invalid = await f.act("set_appearance", { appearance: "pink" });
      expect([invalid.statusCode, invalid.json().code]).toEqual([400, "INVALID_ARGS"]);
      const theirs = await f.act("rename_project", { projectId: "00000000-0000-4000-8000-000000000000", name: "别人的" });
      expect(theirs.statusCode).toBe(404);
      const noOwner = await f.act("read_work_home", {}, { owner: "nobody" });
      expect([noOwner.statusCode, noOwner.json().code]).toEqual([404, "OWNER_NOT_FOUND"]);

      expect((await f.call("PUT", "/api/me/buddy-authority", { authority: "none" })).json()).toEqual({ authority: "none", grantedAt: null });
      expect((await f.act("set_appearance", { appearance: "dark" })).statusCode).toBe(403);
    } finally { await f.close(); }
  });

  it("写动作记审计、能撤的撤：外观、新建项目、改名（对象又变了撤不了）、归档项目、挂 Task、预算、登记拆卡；撤过的不能再撤", async () => {
    const f = await fixture();
    try {
      await f.grant();
      await f.t.sql("INSERT INTO project_bootstraps(person_id,done_at,report) VALUES($1,now(),'{}')", [TEST_MEMBER.personId]);
      const look = await f.ok("set_appearance", { appearance: "dark" });
      expect(look).toMatchObject({ summary: "外观换成了深色", undoable: true });
      expect((await f.undo(look.auditId!)).json()).toMatchObject({ action: "set_appearance", undoable: false, undoneAt: expect.any(String) });
      expect((await f.call("GET", "/api/me/appearance")).json()).toEqual({ appearance: "system" });
      expect((await f.undo(look.auditId!)).json().code).toBe("NOT_UNDOABLE");

      const created = await f.ok("create_project", { name: "对话质量" });
      const projectId = created.result!.projectId as string;
      const renamed = await f.ok("rename_project", { projectId, name: "对话质量 V2" });
      expect(renamed.summary).toBe("把项目「对话质量」改名为「对话质量 V2」");
      // 本人后来又改了名：照现在的样子撤不了。
      await f.call("PATCH", `/api/me/projects/${projectId}`, { name: "本人起的名" });
      const stale = await f.undo(renamed.auditId!);
      expect([stale.statusCode, stale.json().code]).toEqual([409, "NOT_UNDOABLE"]);
      const linked = await f.ok("link_task_to_project", { projectId, taskId: "task-open" });
      expect(linked.summary).toBe("把 Task「对话质量达标」挂到了项目「本人起的名」");
      expect((await f.undo(linked.auditId!)).statusCode).toBe(200);
      expect((await f.t.sql("SELECT project_id FROM project_goals WHERE task_id='task-open'"))).toEqual([{ project_id: null }]);

      const archived = await f.ok("archive_project", { projectId });
      expect((await f.call("GET", `/api/me/projects/${projectId}`)).json().project.archivedAt).not.toBeNull();
      await f.undo(archived.auditId!);
      expect((await f.call("GET", `/api/me/projects/${projectId}`)).json().project.archivedAt).toBeNull();

      const budget = { mode: "set", hours: 2, weeklyPercent: null, money: null };
      const set = await f.ok("set_budget", { taskId: "task-open", budget });
      expect((await f.call("GET", "/api/me/tasks/task-open/budget")).json()).toMatchObject({ budget, inherited: false });
      await f.undo(set.auditId!);
      expect((await f.call("GET", "/api/me/tasks/task-open/budget")).json()).toMatchObject({ inherited: true });

      const split = await f.ok("split_cards", { projectId, words: "先拆打分，录屏不要" });
      expect(split.undoable).toBe(true);
      expect((await f.t.sql("SELECT source_words FROM card_split_requests WHERE id=$1", [split.result!.requestId]))[0].source_words).toEqual(["先拆打分，录屏不要"]);
      // 已经有一条没开的登记：再登记拿到的是那一条，不给撤。
      expect((await f.ok("split_cards", { projectId })).undoable).toBe(false);
      await f.undo(split.auditId!);
      expect((await f.t.sql("SELECT 1 FROM card_split_requests WHERE id=$1 AND closed_at IS NULL", [split.result!.requestId]))).toEqual([]);
      expect((await f.act("split_cards", {})).json().code).toBe("INVALID_ARGS");

      const log = (await f.call("GET", "/api/me/buddy-actions/log")).json().entries as { action: string; undoable: boolean }[];
      expect(log.map((entry) => entry.action)).toEqual(["split_cards", "split_cards", "set_budget", "archive_project", "link_task_to_project", "rename_project",
        "create_project", "set_appearance"]);
      expect(log.find((entry) => entry.action === "create_project")!.undoable).toBe(true);
    } finally { await f.close(); }
  });

  it("子会话：开工登记（电脑接下前能撤）；在跑的归档、删都先要停，停掉是登记「请这台电脑停掉」由那台电脑上的网页认领后报结果；删进回收站首页就没了，恢复回来", async () => {
    const f = await fixture();
    try {
      await f.grant();
      const card = await f.agentCard("跑题库打分");
      const machine = await f.local();
      const start = await f.ok("start_sub_session", { kind: "card", id: card });
      expect(start.undoable).toBe(true);
      await f.undo(start.auditId!);
      expect((await f.call("POST", "/api/me/session-starts/claim", { deviceId: machine.device })).json().starts).toEqual([]);
      const again = await f.ok("start_sub_session", { kind: "card", id: card });
      expect((await f.call("POST", "/api/me/session-starts/claim", { deviceId: machine.device })).json().starts).toEqual([expect.objectContaining({ cardId: card })]);
      // 电脑已经接下了：撤不了。
      expect((await f.undo(again.auditId!)).json().code).toBe("NOT_UNDOABLE");

      const session = await machine.send({ kind: "card", cardId: card }, [running("跑题库打分")]);
      expect((await f.act("start_sub_session", { kind: "card", id: card })).json().code).toBe("ALREADY_RUNNING");
      expect((await f.act("archive_sub_session", { kind: "card", id: card })).json().code).toBe("SUB_SESSION_RUNNING");
      expect((await f.act("delete_sub_session", { kind: "card", id: card })).json().code).toBe("SUB_SESSION_RUNNING");

      const stop = await f.ok("stop_sub_session", { kind: "card", id: card });
      expect(stop).toMatchObject({ undoable: false });
      const other = await f.local("另一台");
      expect((await f.call("POST", "/api/me/session-stops/claim", { deviceId: other.device })).json().stops).toEqual([]);
      const claimed = (await f.call("POST", "/api/me/session-stops/claim", { deviceId: machine.device })).json().stops;
      expect(claimed).toEqual([{ id: expect.any(String), kind: "card", subSessionId: card, sessionId: session, deviceId: machine.device, requestedAt: expect.any(String) }]);
      expect((await f.call("POST", "/api/me/session-stops/claim", { deviceId: machine.device })).json().stops).toEqual([]);
      expect((await f.call("POST", `/api/me/session-stops/${claimed[0].id}/done`, { deviceId: other.device, result: "stopped" })).statusCode).toBe(404);
      expect((await f.call("POST", `/api/me/session-stops/${claimed[0].id}/done`, { deviceId: machine.device, result: "stopped" })).statusCode).toBe(204);
      expect((await f.call("POST", `/api/me/session-stops/${claimed[0].id}/done`, { deviceId: machine.device, result: "stopped" })).statusCode).toBe(404);

      // 没在跑的：归档后首页收起，撤销回来；删进回收站，恢复回来。
      const idle = await f.agentCard("写复盘");
      const shown = async () => {
        const home = (await f.call("GET", "/api/me/work-home")).json() as { projects: { subSessions: { id: string }[] }[]; other: { subSessions: { id: string }[] } };
        return [...home.projects.flatMap((project) => project.subSessions), ...home.other.subSessions].map((sub) => sub.id);
      };
      expect(await shown()).toContain(idle);
      const archived = await f.ok("archive_sub_session", { kind: "card", id: idle });
      expect(await shown()).not.toContain(idle);
      await f.undo(archived.auditId!);
      expect(await shown()).toContain(idle);
      const deleted = await f.ok("delete_sub_session", { kind: "card", id: idle });
      expect(deleted.summary).toBe("把「写复盘」删进了回收站，30 天内能恢复");
      expect(await shown()).not.toContain(idle);
      const trash = (await f.call("GET", "/api/me/trash")).json().items;
      expect(trash).toEqual([{ kind: "card", id: idle, title: "写复盘", deletedAt: expect.any(String), purgeAt: expect.any(String) }]);
      expect(Date.parse(trash[0].purgeAt) - Date.parse(trash[0].deletedAt)).toBe(30 * 24 * 60 * 60 * 1000);
      expect((await f.call("POST", `/api/me/trash/card/${idle}/restore`)).statusCode).toBe(204);
      expect(await shown()).toContain(idle);
      expect((await f.undo(deleted.auditId!)).json().code).toBe("NOT_UNDOABLE");
      // 满 30 天的真删。
      await f.ok("delete_sub_session", { kind: "card", id: idle });
      await f.t.sql("UPDATE tasks SET trashed_at=$2::timestamptz - interval '31 days' WHERE id=$1", [idle, BOARD_NOW]);
      expect((await f.call("GET", "/api/me/trash")).json().items).toEqual([]);
      expect(await f.t.sql("SELECT 1 FROM tasks WHERE id=$1", [idle])).toEqual([]);
    } finally { await f.close(); }
  });

  it("转达给同事：先出草稿，本人点「发出」才由机器人发、开头是「本人请我转达：」，收不到的列出来；不发了的不能再发；每天最多 20 条", async () => {
    const f = await fixture();
    try {
      await f.grant();
      await f.t.sql("INSERT INTO feishu_identities (person_id, open_id) VALUES ($1, 'ou_third')", [THIRD.personId]);
      expect((await f.act("send_message", { toPersonIds: ["nobody"], text: "在吗" })).json().code).toBe("PERSON_NOT_FOUND");
      expect((await f.act("send_message", { toPersonIds: [TEST_MEMBER.personId], text: "在吗" })).json().code).toBe("PERSON_NOT_FOUND");
      const drafted = await f.ok("send_message", { toPersonIds: [THIRD.personId, TEST_CEO.personId], text: "下午的会改到四点" });
      expect(drafted).toMatchObject({ undoable: false, auditId: expect.any(String) });
      const id = drafted.result!.draftId as string;
      expect(f.sent).toEqual([]);
      expect((await f.call("GET", `/api/me/buddy-messages/${id}`)).json()).toMatchObject({ status: "draft", text: "下午的会改到四点",
        to: [{ personId: THIRD.personId, name: "测试丙" }, { personId: TEST_CEO.personId, name: "测试甲" }], failed: [], sentAt: null });
      const sent = (await f.call("POST", `/api/me/buddy-messages/${id}/send`)).json();
      expect(sent).toMatchObject({ status: "sent", sentAt: expect.any(String), failed: [{ personId: TEST_CEO.personId, name: "测试甲" }] });
      expect(f.sent).toEqual([{ id: "ou_third", text: "测试乙请我转达：下午的会改到四点" }]);
      expect((await f.call("POST", `/api/me/buddy-messages/${id}/send`)).json().code).toBe("NOT_DRAFT");
      // 别人看不到。
      const theirs = await f.t.app.inject({ method: "GET", url: `/api/me/buddy-messages/${id}`, headers: { cookie: await f.t.loginCookie() } });
      expect(theirs.statusCode).toBe(404);

      const other = (await f.ok("send_message", { toPersonIds: [THIRD.personId], text: "算了" })).result!.draftId as string;
      expect((await f.call("POST", `/api/me/buddy-messages/${other}/cancel`)).json().status).toBe("cancelled");
      expect((await f.call("POST", `/api/me/buddy-messages/${other}/send`)).json().code).toBe("NOT_DRAFT");

      // 今天（照服务的时钟）已经发出 20 条。
      await f.t.sql(`INSERT INTO buddy_messages(id,owner_id,to_ids,text,status,created_at,sent_at)
        SELECT gen_random_uuid(),$1,ARRAY[$2],'旧的','sent',$3,$3 FROM generate_series(1,19)`, [TEST_MEMBER.personId, THIRD.personId, sent.sentAt]);
      const limited = await f.act("send_message", { toPersonIds: [THIRD.personId], text: "第 21 条" });
      expect([limited.statusCode, limited.json().code]).toEqual([429, "DAILY_LIMIT"]);
    } finally { await f.close(); }
  });

  it("服务凭据轮换：旧凭据在换的过程中照样认，别的不认；配了来源地址只认那些地址来的", async () => {
    const f = await fixture({ internalChatTokensPrevious: ["old-token"], internalCallerAllowlist: ["127.0.0.1", "10.0.0.0/8"] });
    try {
      expect((await f.act("read_work_home", {}, { token: "old-token" })).statusCode).toBe(200);
      expect((await f.act("read_work_home", {}, { token: "wrong" })).statusCode).toBe(401);
      expect((await f.act("read_work_home", {}, { ip: "10.2.3.4" })).statusCode).toBe(200);
      const outside = await f.act("read_work_home", {}, { ip: "8.8.8.8" });
      expect([outside.statusCode, outside.json().code]).toEqual([403, "CALLER_NOT_ALLOWED"]);
      // 别的 /internal 接口同一套。
      const workers = await f.t.app.inject({ method: "GET", url: "/internal/me/workers", remoteAddress: "8.8.8.8",
        headers: { authorization: `Bearer ${TOKEN}`, "x-owner-id": TEST_MEMBER.personId } });
      expect(workers.statusCode).toBe(403);
    } finally { await f.close(); }
  });
});
