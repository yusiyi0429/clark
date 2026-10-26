import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { call, executionFixture, newTask } from "./executionFixture.js";
import { TEST_MEMBER } from "./helpers.js";

const rpc = (id: number, method: string, params?: Record<string, unknown>) => ({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });

describe("个人令牌与执行事项 MCP", () => {
  it("创建、握手、四个工具、进展幂等、权限、版本冲突、撤销", async () => {
    const f = await executionFixture();
    try {
      const task = (await call(f, f.member, "POST", "/api/me/tasks", newTask())).json();
      const other = (await call(f, f.third, "POST", "/api/me/tasks", newTask(null))).json();
      const created = await call(f, f.member, "POST", "/api/me/tokens", { name: "测试设备", client: "codex", expiresInDays: 30 });
      expect(created.statusCode).toBe(200);
      const { token, view } = created.json();
      expect(token).toMatch(/^tsm_[0-9a-f]{32}_[A-Za-z0-9_-]{43}$/);
      expect(view.lastProgressAt).toBeNull();
      const stored = (await f.t.sql("SELECT secret_hash FROM personal_tokens WHERE id=$1", [view.id]))[0].secret_hash as string;
      expect(stored).not.toContain(token);
      expect((await call(f, f.member, "GET", "/api/me/tokens")).json()).toMatchObject({ mcpPath: "/mcp/me", tokens: [{ id: view.id, name: "测试设备" }] });
      expect(JSON.stringify((await call(f, f.member, "GET", "/api/me/tokens")).json())).not.toContain(token);
      expect((await call(f, f.ceo, "POST", "/api/me/tokens", { name: "CEO", client: "codex", expiresInDays: null })).statusCode).toBe(200);
      const send = (id: number, method: string, params?: Record<string, unknown>, bearer = token) => f.t.app.inject({
        method: "POST", url: "/mcp/me", headers: { authorization: `Bearer ${bearer}`, accept: "application/json, text/event-stream" }, payload: rpc(id, method, params),
      });
      const initialized = await send(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
      expect(initialized.statusCode).toBe(200);
      expect(initialized.json().result.serverInfo.name).toBe("tianshu");
      const tools = await send(2, "tools/list");
      expect(tools.json().result.tools.map((tool: { name: string }) => tool.name)).toEqual(["list_my_items", "create_item", "get_item", "append_progress", "update_status", "submit_for_acceptance", "add_link", "update_item", "delete_item", "return_item", "accept_item", "get_mission_card", "edit_mission_card", "list_pending", "get_my_review", "save_review_draft"]);
      const invoke = async (id: number, name: string, args: Record<string, unknown>) => (await send(id, "tools/call", { name, arguments: args })).json().result;
      const listed = await invoke(3, "list_my_items", {});
      expect(JSON.parse(listed.content[0].text).items.some((item: { id: string }) => item.id === task.id)).toBe(true);
      const hidden = await invoke(4, "get_item", { itemId: other.id });
      expect(hidden.isError).toBe(true); expect(hidden.content[0].text).toContain("找不到这件执行事项");
      const before = await invoke(5, "get_item", { itemId: task.id });
      expect(JSON.parse(before.content[0].text).task.id).toBe(task.id);
      const event = randomUUID();
      const progress = await invoke(6, "append_progress", { itemId: task.id, body: "完成接口核对", clientEventId: event });
      const replay = await invoke(7, "append_progress", { itemId: task.id, body: "完成接口核对", clientEventId: event });
      expect(JSON.parse(progress.content[0].text).id).toBe(JSON.parse(replay.content[0].text).id);
      expect((await f.t.sql("SELECT count(*) AS n FROM task_progress WHERE task_id=$1", [task.id]))[0].n).toBe("1");
      const usedToken = (await call(f, f.member, "GET", "/api/me/tokens")).json().tokens.find((item: { id: string }) => item.id === view.id);
      expect(usedToken.lastUsedAt).not.toBeNull();
      expect(usedToken.lastProgressAt).not.toBeNull();
      // 推进人自己的工具写进展，未启动的事项随之进行中（进度只认推进人自报，推进人的工具就是他本人）。
      const started = (await call(f, f.member, "GET", `/api/me/tasks/${task.id}`)).json();
      expect(started.progress[0].source).toBe("codex");
      expect(started.task).toMatchObject({ status: "in_progress", version: 2 });
      const updated = await invoke(8, "update_status", { itemId: task.id, status: "not_started", version: 2 });
      expect(JSON.parse(updated.content[0].text).version).toBe(3);
      const stale = await invoke(9, "update_status", { itemId: task.id, status: "done", version: 2 });
      expect(JSON.parse(stale.content[0].text).currentVersion).toBe(3);
      expect((await f.t.app.inject({ method: "GET", url: "/api/me/tokens", headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(401);
      expect((await call(f, f.member, "DELETE", `/api/me/tokens/${view.id}`)).statusCode).toBe(204);
      expect((await send(11, "tools/list")).statusCode).toBe(401);
      expect((await call(f, f.member, "GET", "/api/me/tokens")).json().tokens).toEqual([]);
    } finally { await f.t.close(); }
  });

  it("Agent 按正在做的事建执行事项：直接生效、标为 Agent 建、重试不重复、能挂本人 Mission、不能挂别人的", async () => {
    const asked: { id: string; code: string }[][] = [];
    const f = await executionFixture("confirmed", "2026-10", { planTasks: async (missions) => {
      asked.push(missions);
      return [{ taskId: "t1", missionId: "execution-one", name: "回流方案定稿", doneDefinition: "会议结论写进本体", criteria: ["纪要能读回"] }];
    } });
    try {
      const { token } = (await call(f, f.member, "POST", "/api/me/tokens", { name: "Claude", client: "claude", expiresInDays: 30 })).json();
      const invoke = async (id: number, name: string, args: Record<string, unknown>) => (await f.t.app.inject({ method: "POST", url: "/mcp/me",
        headers: { authorization: `Bearer ${token}`, accept: "application/json, text/event-stream" }, payload: rpc(id, "tools/call", { name, arguments: args }) })).json().result;
      const before = JSON.parse((await invoke(1, "list_my_items", {})).content[0].text);
      // 每个 Mission 带它下面的 Task（和首页同一个来源），Agent 照着填 planTaskId。
      expect(before.missions).toEqual([
        { id: "execution-one", title: "上线", battlefield: "增长战场", tasks: [{ taskId: "t1", name: "回流方案定稿" }] },
        { id: "execution-two", title: "验证", battlefield: "增长战场", tasks: [] },
      ]);
      expect(asked).toEqual([[{ id: "execution-one", code: "execution-one" }, { id: "execution-two", code: "execution-two" }]]);
      const clientId = randomUUID();
      const args = { clientId, title: "会议回流本体：设计+实现+测试", doneDefinition: "会议纪要写进本体\n天枢能读回", missionId: "execution-one", startDate: "2026-10-10" };
      const created = await invoke(2, "create_item", args);
      expect(created.isError).toBe(false);
      const item = JSON.parse(created.content[0].text);
      expect(item).toMatchObject({ title: args.title, status: "not_started", mission: { missionId: "execution-one" } });
      expect(item.href).toContain(`/me/tasks/${item.id}`);
      expect(JSON.parse((await invoke(3, "create_item", args)).content[0].text).id).toBe(item.id);
      expect((await f.t.sql("SELECT count(*) AS n FROM tasks WHERE owner_id=$1 AND client_id=$2", [TEST_MEMBER.personId, clientId]))[0].n).toBe("1");
      const detail = (await call(f, f.member, "GET", `/api/me/tasks/${item.id}`)).json();
      expect(detail.task).toMatchObject({ source: "agent", doneDefinition: args.doneDefinition, owner: { personId: TEST_MEMBER.personId } });
      const foreign = await invoke(4, "create_item", { clientId: randomUUID(), title: "挂别人的 Mission", missionId: "not-mine" });
      expect(foreign.isError).toBe(true); expect(foreign.content[0].text).toContain("MISSION_NOT_AVAILABLE");
      const onTask = JSON.parse((await invoke(5, "create_item", { clientId: randomUUID(), title: "挂到 Task", missionId: "execution-one", planTaskId: "t1" })).content[0].text);
      expect((await call(f, f.member, "GET", `/api/me/tasks/${onTask.id}`)).json().task.planTaskId).toBe("t1");
      const lone = await invoke(6, "create_item", { clientId: randomUUID(), title: "独立事项挂 Task", planTaskId: "t1", noMissionReason: "对不上" });
      expect(lone.isError).toBe(true);
      expect(JSON.parse(lone.content[0].text)).toMatchObject({ code: "INVALID_INPUT", message: "独立事项不能挂 Task" });
      // 只有本人自己建的可以不挂 Mission：Agent 不带 missionId 又不写原因的不收；写了原因的进本人的待归位，Mission 不能被 Agent 取消。
      const bare = await invoke(8, "create_item", { clientId: randomUUID(), title: "外部数据源调研" });
      expect(bare.isError).toBe(true);
      expect(JSON.parse(bare.content[0].text)).toMatchObject({ code: "MISSION_REQUIRED" });
      const unmatched = JSON.parse((await invoke(9, "create_item", { clientId: randomUUID(), title: "外部数据源调研", noMissionReason: "你名下没有和数据源调研对得上的 Mission" })).content[0].text);
      const home = (await call(f, f.member, "GET", "/api/me/home-plan")).json();
      expect(home.unplaced).toEqual([expect.objectContaining({ id: unmatched.id, unplaced: { reason: "你名下没有和数据源调研对得上的 Mission" } })]);
      expect(home.activities.some((entry: { item: { id: string } }) => entry.item.id === unmatched.id)).toBe(false);
      const unhook = await invoke(10, "update_item", { itemId: onTask.id, version: 1, missionId: null });
      expect(unhook.isError).toBe(true);
      expect(JSON.parse(unhook.content[0].text)).toMatchObject({ code: "MISSION_REQUIRED" });
      const tooLong = await invoke(7, "create_item", { clientId: randomUUID(), title: "Task id 太长", missionId: "execution-one", planTaskId: "t".repeat(201) });
      expect(tooLong.isError).toBe(true);
      expect(JSON.parse(tooLong.content[0].text)).toMatchObject({ code: "INVALID_INPUT" });
      // Agent 建的和本人建的一样：未开始时本人能删。
      expect((await call(f, f.member, "DELETE", `/api/me/tasks/${item.id}?version=${detail.task.version}`)).statusCode).toBe(204);
    } finally { await f.t.close(); }
  });

  it("Agent 维护事项：改、删进行中的（材料一并收起）、会后分派只能退回、本人说了才代为验收并记下原话", async () => {
    const f = await executionFixture();
    try {
      const { token } = (await call(f, f.member, "POST", "/api/me/tokens", { name: "Claude", client: "claude", expiresInDays: 30 })).json();
      const invoke = async (id: number, name: string, args: Record<string, unknown>) => {
        const out = (await f.t.app.inject({ method: "POST", url: "/mcp/me",
          headers: { authorization: `Bearer ${token}`, accept: "application/json, text/event-stream" }, payload: rpc(id, "tools/call", { name, arguments: args }) })).json().result;
        return { isError: out.isError as boolean, body: JSON.parse(out.content[0].text) };
      };
      const created = (await invoke(1, "create_item", { clientId: randomUUID(), title: "已合入主线的配置", missionId: "execution-one", startDate: "2026-10-10" })).body;
      const renamed = await invoke(2, "update_item", { itemId: created.id, version: created.version, title: "外部工具自动记录进天枢", doneDefinition: "Agent 能建事项\n能写进展", dueDate: null });
      expect(renamed.isError).toBe(false);
      expect(renamed.body).toMatchObject({ title: "外部工具自动记录进天枢", doneDefinition: "Agent 能建事项\n能写进展", dueDate: null });
      // 写进展让它进行中，再挂一个链接材料；Agent 整理时进行中的也能删，材料一并收起。
      const progressed = await invoke(3, "append_progress", { itemId: created.id, body: "接通了" });
      await invoke(4, "add_link", { itemId: created.id, url: "https://example.com/pr/1" });
      const version = (await invoke(5, "get_item", { itemId: created.id })).body.task.version;
      expect(progressed.body.item.status).toBe("in_progress");
      expect((await invoke(6, "delete_item", { itemId: created.id, version })).body).toEqual({ deleted: true });
      expect((await f.t.sql("SELECT count(*) AS n FROM tasks WHERE id=$1", [created.id]))[0].n).toBe("0");
      expect((await f.t.sql("SELECT count(*) AS n FROM object_materials WHERE object_type='task' AND object_id=$1 AND deleted_at IS NULL", [created.id]))[0].n).toBe("0");
      // 网页上进行中的仍不能删。
      const web = (await call(f, f.member, "POST", "/api/me/tasks", newTask())).json();
      await call(f, f.member, "PATCH", `/api/me/tasks/${web.id}`, { version: 1, status: "in_progress" });
      expect((await call(f, f.member, "DELETE", `/api/me/tasks/${web.id}?version=2`)).json().code).toBe("TASK_NOT_DELETABLE");
      // 会后分派的不能删，只能退回。
      const assigned = randomUUID();
      await f.t.sql("INSERT INTO tasks(id,title,owner_id,created_by,status) VALUES($1,'会后分派的事',$2,'meeting','not_started')", [assigned, TEST_MEMBER.personId]);
      const refused = await invoke(7, "delete_item", { itemId: assigned, version: 1 });
      expect(refused.isError).toBe(true); expect(refused.body.code).toBe("TASK_NOT_DELETABLE");
      expect((await invoke(8, "return_item", { itemId: assigned, version: 1, reason: "不归我" })).body).toMatchObject({ status: "returned" });
      // 提交验收后列表里标出等验收；本人逐条确认了才代为确认（有一条没达到不行），群里记下工具和原话；不能自己判定完成。
      const done = (await call(f, f.member, "POST", "/api/me/tasks", newTask(null, { title: "要验收的事", doneDefinition: "两家都确认" }))).json();
      expect((await invoke(13, "submit_for_acceptance", { itemId: done.id, version: done.version, confident: true })).isError).toBe(true);
      const submitted = await invoke(9, "submit_for_acceptance", { itemId: done.id, version: done.version, verdict: "做完了", standards: [{ index: 0, met: true, evidence: "两家都回了" }] });
      expect((await invoke(10, "list_my_items", {})).body.items.find((item: { id: string }) => item.id === done.id)).toMatchObject({ awaitingAcceptance: true, source: "self" });
      expect((await invoke(11, "accept_item", { itemId: done.id, version: submitted.body.version, userConfirmation: " " })).isError).toBe(true);
      const unmet = await invoke(14, "accept_item", { itemId: done.id, version: submitted.body.version, userConfirmation: "先这样", standards: [{ index: 0, met: false }] });
      expect(unmet.isError).toBe(true); expect(unmet.body.code).toBe("ACCEPTANCE_NOT_ALL_MET");
      const accepted = await invoke(12, "accept_item", { itemId: done.id, version: submitted.body.version, userConfirmation: "两家都确认了，通过" });
      expect(accepted.body).toMatchObject({ status: "done" });
      const detail = (await call(f, f.member, "GET", `/api/me/tasks/${done.id}`)).json();
      expect(detail.acceptance).toMatchObject({ verdict: "做完了", by: { personId: TEST_MEMBER.personId } });
      expect(JSON.stringify((await call(f, f.member, "GET", `/api/threads/task/${done.id}`)).json())).toContain("Claude Code 里确认验收（“两家都确认了，通过”）");
    } finally { await f.t.close(); }
  });

  it("网页进展、协作者权限、任务卡摘要、到期与数量限制", async () => {
    const f = await executionFixture();
    try {
      const task = (await call(f, f.member, "POST", "/api/me/tasks", newTask())).json();
      const url = `/api/me/tasks/${task.id}/progress`, event = randomUUID();
      expect((await call(f, f.third, "POST", url, { clientEventId: event, body: "不可写" })).statusCode).toBe(404);
      await call(f, f.member, "POST", `/api/me/tasks/${task.id}/collaborators`, { personIds: ["person-fixture-003"] });
      const written = await call(f, f.third, "POST", url, { clientEventId: event, body: "协作完成验证" });
      expect(written.statusCode).toBe(200);
      expect((await call(f, f.third, "POST", url, { clientEventId: event, body: "协作完成验证" })).json().id).toBe(written.json().id);
      // 协作者写进展不改状态：进度只认推进人自报。
      expect((await call(f, f.member, "GET", `/api/me/tasks/${task.id}`)).json().task).toMatchObject({ status: "not_started", version: 2 });
      expect((await call(f, f.third, "PATCH", `/api/me/tasks/${task.id}`, { version: 2, status: "in_progress" })).statusCode).toBe(404);
      // 其他工具（OpenCode 等）的令牌同样可用，写的进展来源记为 other。
      const collaboratorToken = (await call(f, f.third, "POST", "/api/me/tokens", { name: "协作端", client: "other", expiresInDays: 30 })).json();
      const sendCollaborator = (id: number, name: string, args: Record<string, unknown>) => f.t.app.inject({ method: "POST", url: "/mcp/me",
        headers: { authorization: `Bearer ${collaboratorToken.token}`, accept: "application/json, text/event-stream" }, payload: rpc(id, "tools/call", { name, arguments: args }) });
      expect((await sendCollaborator(1, "append_progress", { itemId: task.id, body: "Claude 补充证据" })).json().result.isError).toBe(false);
      expect((await sendCollaborator(2, "update_status", { itemId: task.id, status: "done", version: 1 })).json().result.content[0].text).toContain("找不到这件执行事项");
      const ceoItems = await call(f, f.ceo, "GET", `/api/mission-cards/${f.card}/items`);
      expect(ceoItems.json().missions[0].items[0].latestProgress.body).toBe("Claude 补充证据");
      expect(ceoItems.json().missions[0].items[0].latestProgress.source).toBe("other");
      expect((await call(f, f.ceo, "GET", `/api/me/tasks/${task.id}`)).statusCode).toBe(403);
      expect((await call(f, f.third, "GET", `/api/mission-cards/${f.card}/items`)).statusCode).toBe(404);
      const tokens = [];
      for (let i = 0; i < 5; i++) tokens.push((await call(f, f.member, "POST", "/api/me/tokens", { name: `设备${i}`, client: "claude", expiresInDays: null })).json());
      expect((await call(f, f.member, "POST", "/api/me/tokens", { name: "第六个", client: "codex", expiresInDays: null })).statusCode).toBe(409);
      await f.t.sql("UPDATE personal_tokens SET expires_at=$2 WHERE id=$1", [tokens[0].view.id, "2026-10-09T00:00:00Z"]);
      expect((await f.t.app.inject({ method: "POST", url: "/mcp/me", headers: { authorization: `Bearer ${tokens[0].token}` }, payload: rpc(1, "tools/list") })).statusCode).toBe(401);
    } finally { await f.t.close(); }
  });

  it("每分钟写工具调用超过 20 次返回 MCP 限流错误", async () => {
    const f = await executionFixture();
    try {
      const { token } = (await call(f, f.member, "POST", "/api/me/tokens", { name: "限流测试", client: "codex", expiresInDays: null })).json();
      const send = (id: number) => f.t.app.inject({ method: "POST", url: "/mcp/me", headers: { authorization: `Bearer ${token}`, accept: "application/json, text/event-stream" },
        payload: rpc(id, "tools/call", { name: "update_status", arguments: { itemId: randomUUID(), status: "done", version: 1 } }) });
      for (let i = 1; i <= 20; i++) expect((await send(i)).json().result.content[0].text).toContain("找不到这件执行事项");
      expect((await send(21)).json().result.content[0].text).toContain("调用太频繁，请稍后再试");
    } finally { await f.t.close(); }
  });
});
