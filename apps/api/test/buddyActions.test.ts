import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { FeishuClient } from "../src/feishu/client.js";
import { BOARD_NOW, boardFixture, THIRD } from "./boardFixture.js";
import { letterOf, seqOf } from "../src/subSessionLetters.js";
import { actionList } from "../src/buddyActions.js";
import { BUDDY_ACTION_NAMES } from "@warmap/contracts";
import { buddyPersona } from "../src/buddyPersona.js";
import { TEST_CEO, TEST_MEMBER } from "./helpers.js";

/**
 * 新首页 17.4：伙伴代本人做事。授权、Chat 的通用入口（动作清单、按名字执行）、审计和撤销、子会话的开工 / 停掉 / 归档 / 删进回收站、
 * 「请这台电脑停掉」、转达给同事、服务凭据轮换和来源地址。对话流里插帧在 chatService.test.ts。
 */

const TOKEN = "chat-token";
const running = (title: string) => ["status", { status: "running", title, agent: "claude-code", modelLabel: "订阅 · Sonnet" }] as [string, unknown];

/** 本人在项目对话里说一句（没接 Chat，存在天枢自己 scope 为 project:<id> 的对话里）。 */
const say = (f: Awaited<ReturnType<typeof boardFixture>>, projectId: string, message: string) => f.t.app.inject({ method: "POST",
  url: `/api/conversations/${encodeURIComponent(`project:${projectId}`)}/messages`,
  headers: { cookie: f.member, origin: f.t.publicOrigin, accept: "text/event-stream" }, payload: { message } });

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
      expect((await list()).actions.map((action: { name: string }) => action.name)).toEqual(["read_work_home", "read_partner_inbox", "read_partner_item",
        "read_project", "find_people", "open_page", "update_plan", "ask_user"]);
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
      expect(all.actions.map((action: { name: string }) => action.name)).toEqual(BUDDY_ACTION_NAMES);
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

      // 伙伴带的原话是本人在项目对话里说过的原样片段：存片段。
      expect((await say(f, projectId, "先拆打分，录屏不要")).statusCode).toBe(200);
      const split = await f.ok("split_cards", { projectId, words: "先拆打分" });
      expect(split.undoable).toBe(true);
      expect((await f.t.sql("SELECT source_words FROM card_split_requests WHERE id=$1", [split.result!.requestId]))[0].source_words).toEqual(["先拆打分"]);
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
  it("3700 小卡 U：伙伴登记拆卡带的原话里有自己补的交代，存的改成本人在项目对话里真说的话；几段都是原样片段才存片段", async () => {
    const f = await fixture();
    try {
      await f.grant();
      await f.t.sql("INSERT INTO project_bootstraps(person_id,done_at,report) VALUES($1,now(),'{}')", [TEST_MEMBER.personId]);
      const projectId = (await f.ok("create_project", { name: "验收1112" })).result!.projectId as string;
      const said = ["开一张卡：在 验收1112 文件夹里新建 文件清单.md，别的文件都不要动。", "清单按文件名排"];
      for (const text of said) expect((await say(f, projectId, text)).statusCode).toBe(200);
      const stored = async (requestId: unknown) => (await f.t.sql("SELECT source_words FROM card_split_requests WHERE id=$1", [requestId]))[0].source_words;

      // 一段是原样的、一段是项目对话自己写的交代：整件改用本人最近说的那几条。
      const padded = await f.ok("split_cards", { projectId, words: `本人原话：${said[0]}\n\n交代：\n1. 只新建 文件清单.md，不许新建别的文件` });
      expect(await stored(padded.result!.requestId)).toEqual(said);
      await f.undo(padded.auditId!);

      // 摘的两段（空行隔开）都在本人说过的话里：存这两段。
      const exact = await f.ok("split_cards", { projectId, words: "新建 文件清单.md\n\n  清单按文件名排  " });
      expect(await stored(exact.result!.requestId)).toEqual(["新建 文件清单.md", "清单按文件名排"]);
      // 网页按钮自己带的话照旧原样存。
      expect((await f.call("POST", `/api/me/projects/${projectId}/card-splits`, { words: "按钮里写的" })).json().sourceWords).toEqual(["按钮里写的"]);
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
      // 先按名字找到人员 id（伙伴只知道名字）；本人自己标 self。
      expect((await f.ok("find_people", { query: "测试丙" })).result).toEqual({ people: [{ personId: THIRD.personId, name: "测试丙", self: false }] });
      expect((await f.ok("find_people", { query: "测试乙" })).result).toEqual({ people: [{ personId: TEST_MEMBER.personId, name: "测试乙", self: true }] });
      expect(await f.ok("find_people", { query: "没有这个人" })).toMatchObject({ summary: "人员目录里没有这个名字", result: { people: [] } });
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
  it("18 节第 10 条：子会话用字母称呼（按建立先后、不复用）；停了出报告、要介入出决定卡；项目主管线按字母转话、重开、回答、批准，网页认领后交给本机", async () => {
    expect([1, 2, 26, 27, 28, 52, 53, 702, 703].map(letterOf)).toEqual(["A", "B", "Z", "AA", "AB", "AZ", "BA", "ZZ", "AAA"]);
    expect(["A", "Z", "AA", "ZZ", "AAA"].map(seqOf)).toEqual([1, 26, 27, 702, 703]);
    expect([seqOf("a"), seqOf("ABCD"), seqOf("")]).toEqual([null, null, null]);
    const f = await fixture();
    try {
      await f.grant();
      const project = (await f.call("POST", "/api/me/projects", { name: "本机派活" })).json().projectId as string;
      const inProject = async (title: string) => {
        const id = await f.agentCard(title);
        // 不挂 Task、直接放在项目里（挂着 Task 的算 Task 所在的项目，同首页）。
        await f.t.sql("UPDATE tasks SET project_id=$2,plan_task_id=NULL WHERE id=$1", [id, project]);
        return id;
      };
      const a = await inProject("规划员岗位初版");
      const b = await inProject("验收员只读会话");
      const loose = await f.agentCard("不在项目里的卡");
      await f.t.sql("UPDATE tasks SET plan_task_id=NULL WHERE id=$1", [loose]);
      const letters = async () => {
        const home = (await f.call("GET", "/api/me/work-home")).json() as { projects: { projectId: string; subSessions: { id: string; letter: string | null }[] }[];
          other: { subSessions: { id: string; letter: string | null }[] } };
        return Object.fromEntries([...home.projects.flatMap((entry) => entry.subSessions), ...home.other.subSessions].map((sub) => [sub.id, sub.letter]));
      };
      expect(await letters()).toMatchObject({ [a]: "A", [b]: "B", [loose]: null });
      expect((await f.call("GET", `/api/me/cards/${a}`)).json().letter).toBe("A");
      expect((await f.call("GET", `/api/me/cards/${loose}`)).json().letter).toBeNull();
      // 删掉 B，新建的是 C，不复用。
      await f.t.sql("DELETE FROM tasks WHERE id=$1", [b]);
      const c = await inProject("并行卡独立工作区");
      expect((await letters())[c]).toBe("C");

      // 项目对话（接了 Chat 时记在 project_pipelines）。动作只在项目对话里用；动作清单带了别的对话就不列这几个。
      const conversation = randomUUID(), desk = randomUUID();
      await f.t.sql("INSERT INTO project_pipelines(project_id,owner_id,conversation_id) VALUES($1,$2,$3)", [project, TEST_MEMBER.personId, conversation]);
      const listed = async (conversationId: string) => ((await f.t.app.inject({ method: "GET", url: `/internal/me/buddy-actions?conversationId=${conversationId}`,
        headers: { authorization: `Bearer ${TOKEN}`, "x-owner-id": TEST_MEMBER.personId } })).json().actions as { name: string }[]).map((action) => action.name);
      expect(await listed(desk)).not.toContain("sub_session_tell");
      expect(await listed(conversation)).toEqual(expect.arrayContaining(["sub_session_tell", "sub_session_stop", "sub_session_restart", "sub_session_answer", "sub_session_approve"]));
      const act = (name: string, args: unknown, conversationId: string | null = conversation) => f.t.app.inject({ method: "POST", url: `/internal/me/buddy-actions/${name}`,
        headers: { authorization: `Bearer ${TOKEN}`, "x-owner-id": TEST_MEMBER.personId }, payload: { args, ...(conversationId ? { conversationId } : {}), runId: randomUUID() } });
      const code = async (name: string, args: unknown, conversationId?: string | null) => (await act(name, args, conversationId)).json().code as string;
      expect(await code("sub_session_tell", { letter: "A", text: "先别动测试" }, null)).toBe("PROJECT_ONLY");
      expect(await code("sub_session_tell", { letter: "A", text: "先别动测试" }, desk)).toBe("PROJECT_ONLY");
      expect(await code("sub_session_tell", { letter: "Z", text: "先别动测试" })).toBe("LETTER_NOT_FOUND");
      expect(await code("sub_session_tell", { letter: "B", text: "先别动测试" })).toBe("LETTER_NOT_FOUND");
      expect(await code("sub_session_tell", { letter: "A", text: "先别动测试" })).toBe("NOT_STARTED");
      // 没开过工的重开 = 登记开工。
      expect((await act("sub_session_restart", { letter: "C" })).json().summary).toContain("「C · 并行卡独立工作区」");

      // 本机：A 开工在跑。同一个会话按序号往下报。
      const machine = await f.local();
      const session = randomUUID();
      let seq = 0;
      const report = async (type: string, data: unknown) => {
        seq += 1;
        const res = await f.t.app.inject({ method: "POST", url: "/api/local-runner/sync", headers: { authorization: `Bearer ${machine.token}` }, payload: {
          deviceId: machine.device, runnerVersion: "0.1.0", slots: { max: 3, running: 1, queued: 0 }, items: [{ key: `${machine.device}:${session}:${seq}`, sessionId: session,
            subject: { kind: "card", cardId: a }, occurredAt: new Date(Date.UTC(2026, 10, 6, 1, 0, seq)).toISOString(), type, data }] } });
        expect(res.json().rejected).toEqual([]);
      };
      const status = (value: string, extra: object = {}) => report("status", { status: value, title: "规划员岗位初版", agent: "claude-code", modelLabel: "订阅 · Sonnet", ...extra });
      const feed = async () => ((await f.call("GET", `/api/me/projects/${project}/feed`)).json().items as { kind: string }[])
        .filter((item) => item.kind.startsWith("sub_session_")) as Record<string, unknown>[];
      await status("running");
      expect(await code("sub_session_restart", { letter: "A" })).toBe("ALREADY_RUNNING");
      expect(await code("sub_session_answer", { letter: "A", choices: [["第二个"]] })).toBe("NOT_ASKING");
      expect(await code("sub_session_approve", { letter: "A", decision: "allow" })).toBe("NOT_WAITING_PERMISSION");
      const told = (await act("sub_session_tell", { letter: "A", text: "先别动测试" })).json();
      expect(told.summary).toContain("A · 规划员岗位初版");
      const claim = async (device = machine.device) => (await f.call("POST", "/api/me/session-commands/claim", { deviceId: device })).json().commands as
        { id: string; command: unknown; subSessionId: string; sessionId: string }[];
      const other = await f.local("另一台");
      expect(await claim(other.device)).toEqual([]);
      const first = await claim();
      expect(first).toEqual([{ id: told.result.commandId, kind: "card", subSessionId: a, sessionId: session, deviceId: machine.device, requestedAt: expect.any(String),
        command: { type: "message", text: "先别动测试" } }]);
      expect(await claim()).toEqual([]);
      expect((await f.call("POST", `/api/me/session-commands/${first[0].id}/done`, { deviceId: other.device, result: "done" })).statusCode).toBe(404);
      expect((await f.call("POST", `/api/me/session-commands/${first[0].id}/done`, { deviceId: machine.device, result: "done" })).statusCode).toBe(204);
      expect(await feed()).toEqual([]);

      // 在问本人：直接出决定卡，不出报告；替本人回答登记 answer。
      const question = { requestId: "q-1", questions: [{ question: "先改哪个？", header: "先后", options: [{ label: "规划员", description: "" }, { label: "验收员", description: "" }],
        multiSelect: false }], askedAt: "2026-11-06T01:00:00.000Z" };
      await status("idle", { question });
      await status("idle", { question });
      const asked = await feed();
      expect(asked).toEqual([{ kind: "sub_session_decision", id: expect.any(String), at: expect.any(String), afterSequence: null,
        sub: { kind: "card", id: a, letter: "A", title: "规划员岗位初版" }, sessionId: session, deviceId: machine.device, question, permission: null, status: "open", closedAt: null }]);
      expect(await code("sub_session_answer", { letter: "A", choices: [["规划员"], ["验收员"]] })).toBe("INVALID_ARGS");
      await act("sub_session_answer", { letter: "A", choices: [["验收员"]] });
      expect((await claim()).map((entry) => entry.command)).toEqual([{ type: "answer", requestId: "q-1", answer: { choices: [["验收员"]] } }]);
      // 答了接着做：那张关掉。
      await status("running");
      expect(await feed()).toEqual([expect.objectContaining({ kind: "sub_session_decision", status: "closed", closedAt: expect.any(String) })]);

      // 等批准：出批准卡；批准登记 permission。
      const permission = { requestId: "p-1", toolName: "Bash", title: "rm -rf build", outsidePaths: [] };
      await status("waiting_permission", { permission });
      expect((await feed()).at(-1)).toMatchObject({ kind: "sub_session_decision", permission, question: null, status: "open" });
      const approved = (await act("sub_session_approve", { letter: "A", decision: "allow" })).json();
      expect(approved.summary).toContain("批准了 A · 规划员岗位初版 的「rm -rf build」");
      expect((await claim()).map((entry) => entry.command)).toEqual([{ type: "permission", requestId: "p-1", decision: { decision: "allow" } }]);
      await status("running");

      // 停了：本机报 stopped，出报告（status 的 idle 本身不出报告）；产出物按 artifact 条目的 key 对上云端收下的那件。
      await status("idle");
      expect((await feed()).filter((item) => item.kind === "sub_session_report")).toEqual([]);
      const artifact = Buffer.from("# 规划员\n职责……");
      await report("artifact", { artifactId: "a1", title: "规划员岗位", fileName: "planner.md", mimeType: "text/markdown", size: artifact.length,
        sha256: createHash("sha256").update(artifact).digest("hex"), contentBase64: artifact.toString("base64") });
      const artifactKey = `${machine.device}:${session}:${seq}`;
      // 本机截摘要时逗号、冒号结尾的行也补了「；」（3700 上的「三件事都做完了：；已删除…」）：存的时候去掉。
      await report("stopped", { why: "turn_done", summary: "规划员岗位写好了，；放在 planner.md。", blocker: null,
        outputs: [{ key: artifactKey, title: "规划员岗位", fileName: "planner.md" }, { key: `${machine.device}:${session}:999`, title: "截图", fileName: "a.png" }] });
      const outputId = (await f.t.sql("SELECT id::text FROM local_outputs WHERE client_id=$1", [artifactKey]))[0].id as string;
      expect((await feed()).filter((item) => item.kind === "sub_session_report")).toEqual([{ kind: "sub_session_report", id: expect.any(String), at: expect.any(String),
        afterSequence: null, sub: { kind: "card", id: a, letter: "A", title: "规划员岗位初版" }, why: "turn_done", summary: "规划员岗位写好了，放在 planner.md。", blocker: null,
        outputs: [{ outputId, title: "规划员岗位", fileName: "planner.md" }, { outputId: null, title: "截图", fileName: "a.png" }] }]);
      // 左栏：一轮正常做完写「做完一轮」，云端带 stopWhy = turn_done；开始下一轮就清掉。
      const leftSub = async () => ((await f.call("GET", "/api/me/work-home")).json().projects as { projectId: string; subSessions: { id: string; state: string; stopWhy?: string }[] }[])
        .find((entry) => entry.projectId === project)!.subSessions.find((entry) => entry.id === a)!;
      expect(await leftSub()).toMatchObject({ state: "waiting", stopWhy: "turn_done" });
      // 重开 = 往里说「接着做」；再停住一次是第二条报告。
      await act("sub_session_restart", { letter: "A" });
      expect((await claim()).map((entry) => entry.command)).toEqual([{ type: "message", text: "接着做" }]);
      await status("running");
      expect((await leftSub()).stopWhy).toBeUndefined();
      expect(await f.t.sql("SELECT stop_why FROM local_runs WHERE id=$1", [session])).toEqual([{ stop_why: null }]);
      await report("stopped", { why: "held", summary: null, blocker: "订阅额度用完，14:00 恢复", outputs: [] });
      expect((await feed()).filter((item) => item.kind === "sub_session_report").map((item) => [item.why, item.blocker])).toEqual([["turn_done", null],
        ["held", "订阅额度用完，14:00 恢复"]]);
      // 已经存下的旧摘要，读的时候也去掉。
      await f.t.sql("UPDATE sub_session_reports SET summary='三件事都做完了：；已删除旧的 planner.md。' WHERE why='held'");
      expect((await feed()).find((item) => item.kind === "sub_session_report" && item.why === "held").summary).toBe("三件事都做完了：已删除旧的 planner.md。");
      // 本机程序重启打断的停下也收（报告表的检查原来不认 runner_restart）；停着不在等什么，左栏写「已停下」。
      await report("stopped", { why: "runner_restart", summary: null, blocker: null, outputs: [] });
      await status("exited");
      expect(await leftSub()).toMatchObject({ state: "waiting", stopWhy: "runner_restart" });
      await status("running");
      // 主循环第 63 条：报告不再替本人给项目主管线发一句、不让它回一小轮——项目对话里一条消息都没有（没跑模型）。
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(await f.t.sql(`SELECT 1 FROM conversation_messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.scope=$1`, [`project:${project}`])).toEqual([]);
      // 停下按字母走 stop_sub_session：登记「请这台电脑停掉」。
      expect((await act("sub_session_stop", { letter: "A" })).json().summary).toBe("已请那台电脑停掉「A · 规划员岗位初版」（本人电脑上开着天枢网页时马上停）");
      expect((await f.call("POST", "/api/me/session-stops/claim", { deviceId: machine.device })).json().stops).toEqual([expect.objectContaining({ subSessionId: a, sessionId: session })]);
      // 排着的（run 是 queued，3700 的 C、D、K、N）：回本人的话是从队列撤下，不写「停掉」。
      await status("queued", { queuePosition: 1 });
      expect(await f.t.sql("SELECT state FROM local_runs WHERE id=$1", [session])).toEqual([{ state: "queued" }]);
      expect((await act("sub_session_stop", { letter: "A" })).json().summary).toBe("已请那台电脑把「A · 规划员岗位初版」从队列撤下（本人电脑上开着天枢网页时马上停）");
      // 不在项目里的卡停了不报。
      await machine.send({ kind: "card", cardId: loose }, [running("不在项目里的卡"), ["stopped", { why: "turn_done", summary: null, blocker: null, outputs: [] }]]);
      expect(await f.t.sql("SELECT 1 FROM sub_session_reports WHERE subject_id=$1", [loose])).toEqual([]);
    } finally { await f.close(); }
  });
  it("18 节第 11 条：建项目、拆卡之前先用选项框问清现实（文件夹、目录、迁移、GitHub、做成什么样），同一个文件夹已有项目先问；人设里也有这条", () => {
    const description = (name: string) => actionList({ authority: "full", grantedAt: null }).find((action) => action.name === name)!.description;
    for (const name of ["create_project", "split_cards"]) {
      for (const word of ["ask_user", "文件夹", "目录", "Codex", "GitHub", "和本人要的是不是一回事"]) expect(description(name)).toContain(word);
    }
    expect(description("create_project")).toContain("这个文件夹已经有项目了还要再建，先问本人");
    expect(description("split_cards")).toContain("不拆、不开工");
    // 3700 验收：项目对话把「只拆这两张验收卡，范围限定在…」塞进了 modelWords。说明里写死只放来源、模型、思考的原话，没说就不带。
    for (const word of ["modelWords 只放本人关于用哪个来源、哪个模型、思考开到多少的原话", "本人没说这些就不带", "不放 modelWords"])
      expect(description("split_cards")).toContain(word);
    // 3700 小卡 U：项目对话把自己写的交代塞进了 words。说明里写死只能原样摘，拿不准就不带。
    for (const word of ["words 只能原样摘本人在项目对话里说过的话，不改写、不加自己的交代", "拿不准就不带，云端取本人最近说的话"])
      expect(description("split_cards")).toContain(word);
    expect(description("ask_user")).toContain("建项目、拆卡之前一定先用它把现实问清楚");
    for (const personality of ["steady", "direct", "warm", "coach"] as const)
      expect(buddyPersona({ name: "团团", personality }, "测试乙")).toContain("# 先从现实出发（哪种性格都一样）");
  });
  it("18 节第 12 条：自动接力连续 20 次本人没说话就停住、「等你」里问继续还是停下；本人在项目对话里说一句清零；设成不限就不停", async () => {
    const f = await fixture();
    try {
      await f.grant();
      const project = (await f.call("POST", "/api/me/projects", { name: "天枢" })).json() as { projectId: string; autoRelayLimit: number | null };
      expect(project.autoRelayLimit).toBe(20);
      const card = await f.agentCard("规划员岗位初版");
      await f.t.sql("UPDATE tasks SET project_id=$2,plan_task_id=NULL WHERE id=$1", [card, project.projectId]);
      const conversation = randomUUID();
      await f.t.sql("INSERT INTO project_pipelines(project_id,owner_id,conversation_id) VALUES($1,$2,$3)", [project.projectId, TEST_MEMBER.personId, conversation]);
      expect((await f.call("GET", "/api/me/work-home")).json().projects.find((entry: { projectId: string }) => entry.projectId === project.projectId).subSessions[0].letter).toBe("A");
      const machine = await f.local();
      await machine.send({ kind: "card", cardId: card }, [running("规划员岗位初版")]);
      const tell = (text: string) => f.t.app.inject({ method: "POST", url: "/internal/me/buddy-actions/sub_session_tell",
        headers: { authorization: `Bearer ${TOKEN}`, "x-owner-id": TEST_MEMBER.personId }, payload: { args: { letter: "A", text }, conversationId: conversation, runId: randomUUID() } });
      const waiting = async () => ((await f.call("GET", "/api/me/work-home")).json().waiting as { id: string; kind: string; title: string; answer: string }[])
        .filter((item) => item.kind === "auto_relay");
      const decide = (decision: string) => f.call("POST", `/api/me/projects/${project.projectId}/auto-relay`, { decision });

      // 连转 20 次：第 21 次不做，「等你」里出一条。
      for (let i = 1; i <= 20; i++) expect((await tell(`第 ${i} 次`)).statusCode).toBe(200);
      const blocked = await tell("第 21 次");
      expect([blocked.statusCode, blocked.json().code]).toEqual([409, "AUTO_RELAY_PAUSED"]);
      expect(await waiting()).toEqual([expect.objectContaining({ id: `auto_relay:${project.projectId}`, title: "天枢：自动接力已连续 20 轮，继续吗？", answer: "inline",
        open: { kind: "project", id: project.projectId }, projectId: project.projectId })]);
      expect(await f.t.sql("SELECT 1 FROM session_commands WHERE card_id=$1", [card])).toHaveLength(20);
      // 停着时子会话停了：报告照样记，不再触发主管线那一轮。
      await machine.send({ kind: "card", cardId: card }, [["stopped", { why: "turn_done", summary: null, blocker: null, outputs: [] }]]);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(await f.t.sql("SELECT 1 FROM sub_session_reports WHERE subject_id=$1", [card])).toHaveLength(1);
      expect(await f.t.sql("SELECT 1 FROM conversations WHERE scope=$1", [`project:${project.projectId}`])).toEqual([]);

      // 停下：那一条收起，照旧停着；继续：清零恢复。没停着时答 409。
      expect((await decide("stop")).statusCode).toBe(204);
      expect(await waiting()).toEqual([]);
      expect((await tell("还是不行")).json().code).toBe("AUTO_RELAY_PAUSED");
      expect((await decide("continue")).statusCode).toBe(204);
      expect((await tell("继续")).statusCode).toBe(200);
      expect((await decide("continue")).json().code).toBe("NOT_PAUSED");

      // 本人在项目对话里说一句：清零。再转 19 次也不停（加上清零前那一次之后的计数从 0 起）。
      for (let i = 0; i < 18; i++) await tell(`再转 ${i}`);
      expect((await f.call("POST", `/api/conversations/project:${project.projectId}/messages`, { message: "B 先停一下" })).statusCode).toBe(200);
      for (let i = 0; i < 19; i++) expect((await tell(`清零后 ${i}`)).statusCode).toBe(200);
      expect(await waiting()).toEqual([]);

      // 设成不限：不停。
      expect((await f.call("PATCH", `/api/me/projects/${project.projectId}`, { autoRelayLimit: null })).json().autoRelayLimit).toBeNull();
      for (let i = 0; i < 25; i++) expect((await tell(`不限 ${i}`)).statusCode).toBe(200);
      expect(await waiting()).toEqual([]);
    } finally { await f.close(); }
  });
  it("主循环第 60 条：项目管线用 update_card 改卡的约定（按字母或卡 id，原因必带），记一条 by pipeline 的修改；只在项目对话里能用", async () => {
    const f = await fixture();
    try {
      await f.grant();
      const project = (await f.call("POST", "/api/me/projects", { name: "品牌建设" })).json().projectId as string;
      const card = await f.agentCard("候选名初查");
      await f.t.sql("UPDATE tasks SET project_id=$2,plan_task_id=NULL WHERE id=$1", [card, project]);
      const conversation = randomUUID();
      await f.t.sql("INSERT INTO project_pipelines(project_id,owner_id,conversation_id) VALUES($1,$2,$3)", [project, TEST_MEMBER.personId, conversation]);
      await f.call("GET", "/api/me/work-home"); // 读首页时给子会话编字母
      const update = (args: Record<string, unknown>, conversationId: string | null = conversation) => f.t.app.inject({ method: "POST",
        url: "/internal/me/buddy-actions/update_card", headers: { authorization: `Bearer ${TOKEN}`, "x-owner-id": TEST_MEMBER.personId },
        payload: { args, ...(conversationId ? { conversationId } : {}), runId: randomUUID() } });

      const done = await update({ letter: "A", standards: ["列出 3 个候选名", "近似商标由本人查"], reason: "本人说商标网要他自己查" });
      expect(done.statusCode).toBe(200);
      expect(done.json().summary).toBe("改了 A · 候选名初查 的约定（第 2 版）");
      expect((await f.call("GET", `/api/me/cards/${card}/agreement-changes`)).json().changes).toEqual([expect.objectContaining({ revision: 2,
        by: { kind: "pipeline", name: "管线" }, reason: "本人说商标网要他自己查", after: { brief: null, standards: ["列出 3 个候选名", "近似商标由本人查"] } })]);
      expect((await update({ cardId: card, brief: "先查商标网", reason: "补一句交代" })).json().summary).toBe("改了 「候选名初查」 的约定（第 3 版）");
      expect((await update({ letter: "A", cardId: card, brief: "x", reason: "r" })).json().code).toBe("INVALID_ARGS");
      expect((await update({ letter: "A", reason: "r" })).json().code).toBe("INVALID_ARGS");
      expect((await update({ letter: "A", standards: ["x"] })).json().code).toBe("INVALID_ARGS");
      expect((await update({ letter: "A", standards: ["x"], reason: "r" }, null)).json().code).toBe("PROJECT_ONLY");
    } finally { await f.close(); }
  });
  it("伙伴改 Task 的验收截止日（set_task_due_date），能撤回原来的", async () => {
    const f = await fixture();
    try {
      await f.grant();
      const project = (await f.call("POST", "/api/me/projects", { name: "天枢", taskId: "task-open" })).json().projectId as string;
      const done = await f.ok("set_task_due_date", { projectId: project, taskId: "task-open", dueDate: "2026-11-30" });
      expect(done).toMatchObject({ summary: "把「对话质量达标」的验收截止日定成 2026-11-30", undoable: true });
      expect((await f.call("GET", `/api/me/projects/${project}`)).json().goals[0].dueDate).toBe("2026-11-30");
      await f.undo(done.auditId!);
      expect((await f.call("GET", `/api/me/projects/${project}`)).json().goals[0].dueDate).toBeNull();
    } finally { await f.close(); }
  });
  it("17.2 第 25 条：蓝点只在本人没看过的新情况时出——子会话停下晚于打开、项目对话有新的回复或汇报晚于打开；打开记在云端", async () => {
    const f = await fixture();
    try {
      const project = (await f.call("POST", "/api/me/projects", { name: "天枢" })).json().projectId as string;
      const card = await f.agentCard("规划员岗位初版");
      await f.t.sql("UPDATE tasks SET project_id=$2,plan_task_id=NULL WHERE id=$1", [card, project]);
      const machine = await f.local();
      const session = randomUUID();
      let seq = 0;
      const report = async (type: string, data: unknown) => {
        seq += 1;
        const res = await f.t.app.inject({ method: "POST", url: "/api/local-runner/sync", headers: { authorization: `Bearer ${machine.token}` }, payload: {
          deviceId: machine.device, runnerVersion: "0.1.0", slots: { max: 3, running: 1, queued: 0 }, items: [{ key: `${machine.device}:${session}:${seq}`, sessionId: session,
            subject: { kind: "card", cardId: card }, occurredAt: new Date(Date.UTC(2026, 10, 6, 1, 0, seq)).toISOString(), type, data }] } });
        expect(res.json().rejected).toEqual([]);
      };
      const status = (value: string, extra: object = {}) => report("status", { status: value, title: "规划员岗位初版", agent: "claude-code", modelLabel: "m", ...extra });
      const dots = async () => {
        const entry = (await f.call("GET", "/api/me/work-home")).json().projects.find((row: { projectId: string }) => row.projectId === project);
        return { project: entry.unseen as boolean, sub: entry.subSessions[0].unseen as boolean };
      };
      const seen = (kind: string, id: string) => f.call("POST", "/api/me/work-seen", { kind, id });
      const later = new Date(BOARD_NOW.getTime() + 3600_000);

      expect(await dots()).toEqual({ project: false, sub: false });
      await status("running");
      expect((await dots()).sub).toBe(false);
      // 一轮做完停下：没打开过，是蓝点；打开了就没了（重复打开照旧 204）。
      await status("idle");
      expect((await dots()).sub).toBe(true);
      expect((await seen("sub", card)).statusCode).toBe(204);
      expect((await seen("sub", card)).statusCode).toBe(204);
      expect((await dots()).sub).toBe(false);
      // 之后又停了一次（晚于打开）：又是蓝点。
      await f.t.sql("UPDATE local_runs SET updated_at=$2 WHERE id=$1", [session, later]);
      expect((await dots()).sub).toBe(true);
      // 在问本人是黄点，不算蓝点。
      await status("idle", { question: { requestId: "q-1", questions: [{ question: "先改哪个？", header: "先后", options: [{ label: "A", description: "" }], multiSelect: false }],
        askedAt: "2026-11-06T01:00:00.000Z" } });
      expect((await dots()).sub).toBe(false);

      // 项目：子会话的汇报来了，没打开过项目对话是蓝点；打开了就没了；Chat 那边回完一轮（晚于打开）又是。
      // （汇报会触发项目主管线回一轮，它的回答按真实时间记，比测试的时钟晚；这里先停住自动接力，只看汇报本身。）
      await f.t.sql("UPDATE projects SET auto_relay_paused_at=$2 WHERE id=$1", [project, BOARD_NOW]);
      await report("stopped", { why: "turn_done", summary: null, blocker: null, outputs: [] });
      expect((await dots()).project).toBe(true);
      await seen("project", project);
      expect((await dots()).project).toBe(false);
      await f.t.sql("UPDATE projects SET pipeline_reply_at=$2 WHERE id=$1", [project, later]);
      expect((await dots()).project).toBe(true);
      // 别人看过不算本人看过；参数不对 400。
      await f.t.sql("INSERT INTO work_seen(person_id,kind,object_id,seen_at) VALUES($1,'project',$2,$3)", [THIRD.personId, project, later]);
      expect((await dots()).project).toBe(true);
      expect((await f.call("POST", "/api/me/work-seen", { kind: "card", id: card })).statusCode).toBe(400);
    } finally { await f.close(); }
  });

  it("项目主管线按字母给子会话改名（本人 11/16：总管线自己能改，不用本人去左栏改）；只在项目对话里能用，能撤回", async () => {
    const f = await fixture();
    try {
      await f.grant();
      const project = (await f.call("POST", "/api/me/projects", { name: "新版天枢应用" })).json().projectId as string;
      const long = "本机程序能按岗位拉起规划员、执行 worker、验收员三种 Claude Code 会话";
      const card = await f.agentCard(long);
      await f.t.sql("UPDATE tasks SET project_id=$2,plan_task_id=NULL WHERE id=$1", [card, project]);
      // 字母在读首页时排上（同上一条用例的 letters()）。
      expect((await f.call("GET", `/api/me/cards/${card}`)).json().letter ?? (await f.call("GET", "/api/me/work-home"), (await f.call("GET", `/api/me/cards/${card}`)).json().letter)).toBe("A");
      const conversation = randomUUID(), desk = randomUUID();
      await f.t.sql("INSERT INTO project_pipelines(project_id,owner_id,conversation_id) VALUES($1,$2,$3)", [project, TEST_MEMBER.personId, conversation]);
      const headers = { authorization: `Bearer ${TOKEN}`, "x-owner-id": TEST_MEMBER.personId };
      const listed = async (conversationId: string) => ((await f.t.app.inject({ method: "GET", url: `/internal/me/buddy-actions?conversationId=${conversationId}`, headers }))
        .json().actions as { name: string }[]).map((action) => action.name);
      expect(await listed(conversation)).toContain("sub_session_rename");
      expect(await listed(desk)).not.toContain("sub_session_rename");
      const act = (args: unknown, conversationId: string) => f.t.app.inject({ method: "POST", url: "/internal/me/buddy-actions/sub_session_rename", headers,
        payload: { args, conversationId, runId: randomUUID() } });
      expect((await act({ letter: "A", title: "本机拉起三种会话" }, desk)).json().code).toBe("PROJECT_ONLY");
      expect((await act({ letter: "Z", title: "随便" }, conversation)).json().code).toBe("LETTER_NOT_FOUND");
      const renamed = await act({ letter: "A", title: "本机拉起三种会话" }, conversation);
      expect(renamed.statusCode, renamed.body).toBe(200);
      expect(renamed.json()).toMatchObject({ summary: `把「A · ${long}」改名为「本机拉起三种会话」`, undoable: true });
      expect((await f.t.sql("SELECT title FROM tasks WHERE id=$1", [card]))[0].title).toBe("本机拉起三种会话");
      expect((await f.undo(renamed.json().auditId)).statusCode).toBe(200);
      expect((await f.t.sql("SELECT title FROM tasks WHERE id=$1", [card]))[0].title).toBe(long);
    } finally { await f.close(); }
  });
});
