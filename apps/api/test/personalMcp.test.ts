import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { call, executionFixture, newTask } from "./executionFixture.js";

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
      const stored = (await f.t.sql("SELECT secret_hash FROM personal_tokens WHERE id=$1", [view.id]))[0].secret_hash as string;
      expect(stored).not.toContain(token);
      expect((await call(f, f.member, "GET", "/api/me/tokens")).json()).toMatchObject({ mcpPath: "/mcp/me", tokens: [{ id: view.id, name: "测试设备" }] });
      expect(JSON.stringify((await call(f, f.member, "GET", "/api/me/tokens")).json())).not.toContain(token);
      expect((await call(f, f.ceo, "POST", "/api/me/tokens", { name: "CEO", client: "codex", expiresInDays: null })).statusCode).toBe(403);
      const send = (id: number, method: string, params?: Record<string, unknown>, bearer = token) => f.t.app.inject({
        method: "POST", url: "/mcp/me", headers: { authorization: `Bearer ${bearer}`, accept: "application/json, text/event-stream" }, payload: rpc(id, method, params),
      });
      const initialized = await send(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
      expect(initialized.statusCode).toBe(200);
      expect(initialized.json().result.serverInfo.name).toBe("tianshu-execution-items");
      const tools = await send(2, "tools/list");
      expect(tools.json().result.tools.map((tool: { name: string }) => tool.name)).toEqual(["list_my_items", "get_item", "append_progress", "update_status"]);
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
      expect((await call(f, f.member, "GET", `/api/me/tasks/${task.id}`)).json().progress[0].source).toBe("codex");
      const updated = await invoke(8, "update_status", { itemId: task.id, status: "in_progress", version: 1 });
      expect(JSON.parse(updated.content[0].text).version).toBe(2);
      const stale = await invoke(9, "update_status", { itemId: task.id, status: "done", version: 1 });
      expect(JSON.parse(stale.content[0].text).currentVersion).toBe(2);
      expect((await f.t.app.inject({ method: "GET", url: "/api/me/tokens", headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(401);
      expect((await f.t.app.inject({ method: "POST", url: "/mcp/company-memory", headers: { authorization: `Bearer ${token}` }, payload: rpc(10, "tools/list") })).statusCode).toBe(401);
      expect((await call(f, f.member, "DELETE", `/api/me/tokens/${view.id}`)).statusCode).toBe(204);
      expect((await send(11, "tools/list")).statusCode).toBe(401);
      expect((await call(f, f.member, "GET", "/api/me/tokens")).json().tokens).toEqual([]);
    } finally { await f.t.close(); }
  });

  it("网页进展、协作者权限、个人卡摘要、到期与数量限制", async () => {
    const f = await executionFixture();
    try {
      const task = (await call(f, f.member, "POST", "/api/me/tasks", newTask())).json();
      const url = `/api/me/tasks/${task.id}/progress`, event = randomUUID();
      expect((await call(f, f.third, "POST", url, { clientEventId: event, body: "不可写" })).statusCode).toBe(404);
      await call(f, f.member, "POST", `/api/me/tasks/${task.id}/collaborators`, { personIds: ["person-fixture-003"] });
      const written = await call(f, f.third, "POST", url, { clientEventId: event, body: "协作完成验证" });
      expect(written.statusCode).toBe(200);
      expect((await call(f, f.third, "POST", url, { clientEventId: event, body: "协作完成验证" })).json().id).toBe(written.json().id);
      expect((await call(f, f.third, "PATCH", `/api/me/tasks/${task.id}`, { version: 1, status: "done" })).statusCode).toBe(404);
      const collaboratorToken = (await call(f, f.third, "POST", "/api/me/tokens", { name: "协作端", client: "claude", expiresInDays: 30 })).json();
      const sendCollaborator = (id: number, name: string, args: Record<string, unknown>) => f.t.app.inject({ method: "POST", url: "/mcp/me",
        headers: { authorization: `Bearer ${collaboratorToken.token}`, accept: "application/json, text/event-stream" }, payload: rpc(id, "tools/call", { name, arguments: args }) });
      expect((await sendCollaborator(1, "append_progress", { itemId: task.id, body: "Claude 补充证据" })).json().result.isError).toBe(false);
      expect((await sendCollaborator(2, "update_status", { itemId: task.id, status: "done", version: 1 })).json().result.content[0].text).toContain("找不到这件执行事项");
      const ceoItems = await call(f, f.ceo, "GET", `/api/mission-cards/${f.card}/items`);
      expect(ceoItems.json().missions[0].items[0].latestProgress.body).toBe("Claude 补充证据");
      expect((await call(f, f.ceo, "GET", `/api/me/tasks/${task.id}`)).statusCode).toBe(404);
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
