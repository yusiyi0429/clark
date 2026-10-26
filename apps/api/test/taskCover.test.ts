import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { MaterialView, TaskDetailResponse } from "@warmap/contracts";
import { taskStandards } from "../src/tasks.js";
import type { AcceptanceDraftInput } from "../src/taskAcceptanceDraft.js";
import { call, executionFixture, newTask, type Fixture } from "./executionFixture.js";

const upload = (f: Fixture, cookie: string, taskId: string, name: string, body: string) => {
  const boundary = "----task-cover-test";
  return f.t.app.inject({ method: "POST", url: `/api/materials/task/${taskId}`,
    headers: { cookie, origin: f.t.publicOrigin, "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: text/markdown\r\n\r\n${body}\r\n--${boundary}--\r\n`) });
};
const detail = async (f: Fixture, cookie: string, id: string) => (await call(f, cookie, "GET", `/api/me/tasks/${id}`)).json();
const groupSays = async (f: Fixture, id: string) => (await f.t.sql("SELECT content FROM thread_messages WHERE object_type='task' AND object_id=$1 AND kind='co-agent' ORDER BY id", [id]))
  .map((row) => row.content as string);
const rpc = (id: number, method: string, params?: Record<string, unknown>) => ({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
async function mcpAs(f: Fixture, cookie: string, client: "codex" | "claude" | "other") {
  const { token } = (await call(f, cookie, "POST", "/api/me/tokens", { name: `${client} 测试`, client, expiresInDays: 30 })).json();
  let id = 0;
  return async (name: string, args: Record<string, unknown>) => {
    const response = await f.t.app.inject({ method: "POST", url: "/mcp/me", headers: { authorization: `Bearer ${token}`, accept: "application/json, text/event-stream" },
      payload: rpc(++id, "tools/call", { name, arguments: args }) });
    const result = response.json().result as { isError: boolean; content: { text: string }[] };
    return { isError: result.isError, value: JSON.parse(result.content[0].text) };
  };
}

// 契约里的 uuid 格式要先登记，Value.Check 才认（同 myRadar.test.ts）。
FormatRegistry.Set("uuid", (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value));

describe("完成标准按行拆", () => {
  it("去掉空行和行首记号；日期开头不当序号", () => {
    expect(taskStandards("- 三方需求都进了路线图\n\n2. 每条写明负责人\n(3) 明华确认\n10.8 上线\n- [x] 已打勾\n• 圆点\n1、顿号序号")).toEqual([
      "三方需求都进了路线图", "每条写明负责人", "明华确认", "10.8 上线", "已打勾", "圆点", "顿号序号"]);
    expect(taskStandards(null)).toEqual([]);
    expect(taskStandards("一句话写完")).toEqual(["一句话写完"]);
  });
});

describe("执行事项封面", () => {
  it("只认推进人的动作：协作者放材料、写进展、贴链接都不改状态；推进人贴链接就进行中；同一地址不重复", async () => {
    const f = await executionFixture();
    try {
      const task = (await call(f, f.member, "POST", "/api/me/tasks", newTask(null, { doneDefinition: "- 路线图定稿\n- 明华确认" }))).json();
      await call(f, f.member, "POST", `/api/me/tasks/${task.id}/collaborators`, { personIds: ["person-fixture-003"] });
      const draft = await upload(f, f.third, task.id, "协作者草稿.md", "# 草稿");
      expect(draft.statusCode).toBe(201);
      // Co-Agent 正在按批注改这一份时 working 为真，改完就消失。
      await f.t.sql(`INSERT INTO material_annotations(id,material_id,object_type,object_id,version,quote,prefix,suffix,body,author_id,client_id,status,decided_by)
        VALUES($1,$2,'task',$3,1,'草稿','','','改成定稿','person-fixture-003',$4,'applying','person-fixture-003')`, [randomUUID(), draft.json().id, task.id, randomUUID()]);
      const working = async () => (await call(f, f.member, "GET", `/api/materials/task/${task.id}`)).json().materials[0].working;
      expect(await working()).toBe(true);
      await f.t.sql("UPDATE material_annotations SET status='applied' WHERE material_id=$1", [draft.json().id]);
      expect(await working()).toBe(false);
      expect((await call(f, f.third, "POST", `/api/me/tasks/${task.id}/progress`, { clientEventId: randomUUID(), body: "补了竞品" })).statusCode).toBe(200);
      const figma = await call(f, f.third, "POST", `/api/materials/task/${task.id}/links`, { url: "https://www.figma.com/file/abc/Roadmap" });
      expect(figma.statusCode).toBe(201);
      expect(figma.json().fileName).toBe("figma.com · Roadmap");
      expect((await detail(f, f.member, task.id)).task).toMatchObject({ status: "not_started", version: 2, awaitingAcceptance: false });

      const link = await call(f, f.member, "POST", `/api/materials/task/${task.id}/links`, { url: "https://claude.ai/artifact/St2bVptWaKpntfngGskjry", title: "原型 v3" });
      expect(link.statusCode).toBe(201);
      expect(Value.Check(MaterialView, link.json())).toBe(true);
      expect(link.json()).toMatchObject({ format: "link", url: "https://claude.ai/artifact/St2bVptWaKpntfngGskjry", fileName: "原型 v3",
        origin: "upload", editable: false, canDelete: true, working: false });
      expect((await detail(f, f.member, task.id)).task).toMatchObject({ status: "in_progress", version: 3 });
      const again = await call(f, f.member, "POST", `/api/materials/task/${task.id}/links`, { url: "https://claude.ai/artifact/St2bVptWaKpntfngGskjry" });
      expect(again.statusCode).toBe(200);
      expect(again.json().id).toBe(link.json().id);
      const listed = (await call(f, f.member, "GET", `/api/materials/task/${task.id}`)).json().materials;
      expect(listed.map((item: { fileName: string }) => item.fileName)).toEqual(["协作者草稿.md", "figma.com · Roadmap", "原型 v3"]);
    } finally { await f.t.close(); }
  });

  it("链接只收 http/https、不带账号密码、只给执行事项；没有原件，不能写批注", async () => {
    const f = await executionFixture();
    try {
      const task = (await call(f, f.member, "POST", "/api/me/tasks", newTask(null))).json();
      const base = `/api/materials/task/${task.id}`;
      expect((await call(f, f.member, "POST", `${base}/links`, { url: "javascript:alert(1)" })).json().code).toBe("INVALID_INPUT");
      expect((await call(f, f.member, "POST", `${base}/links`, { url: "https://who:secret@example.com/x" })).json().code).toBe("MATERIAL_LINK_INVALID");
      expect((await call(f, f.member, "POST", `/api/materials/issue/${randomUUID()}/links`, { url: "https://example.com" })).json().code).toBe("MATERIAL_LINK_UNSUPPORTED");
      const link = (await call(f, f.member, "POST", `${base}/links`, { url: "https://example.com/" })).json();
      expect(link.fileName).toBe("example.com");
      expect((await call(f, f.member, "GET", `${base}/${link.id}/file`)).json().code).toBe("MATERIAL_NO_FILE");
      expect((await call(f, f.member, "GET", `${base}/${link.id}/preview`)).json().code).toBe("MATERIAL_NO_FILE");
      const read = (await call(f, f.member, "GET", `${base}/${link.id}`)).json();
      expect(read).toMatchObject({ material: { format: "link", url: "https://example.com/" }, blocks: null, annotations: [] });
      const annotated = await call(f, f.member, "POST", `${base}/${link.id}/annotations`,
        { clientId: randomUUID(), version: 1, quote: "example", prefix: "", suffix: "", body: "改一下" });
      expect(annotated.json().code).toBe("MATERIAL_LINK_NOT_ANNOTATABLE");
    } finally { await f.t.close(); }
  });

  it("完成只能经推进人逐条验收：每条都达到才完成、没写标准先写；快照、交付结果、群里一句；协作者不能验收；重新打开", async () => {
    const f = await executionFixture();
    try {
      const task = (await call(f, f.member, "POST", "/api/me/tasks", newTask(null, { doneDefinition: "- 路线图定稿\n- 明华确认" }))).json();
      await call(f, f.member, "POST", `/api/me/tasks/${task.id}/collaborators`, { personIds: ["person-fixture-003"] });
      expect((await call(f, f.member, "PATCH", `/api/me/tasks/${task.id}`, { version: 2, status: "done" })).json().code).toBe("INVALID_INPUT");
      const doc = (await upload(f, f.member, task.id, "路线图 v4.md", "# 路线图\n\n九个迭代")).json();
      let current = await detail(f, f.member, task.id);
      expect(current.task).toMatchObject({ status: "in_progress", version: 3 });
      expect(current.standards).toEqual(["路线图定稿", "明华确认"]);
      expect(current).toMatchObject({ submission: null, acceptance: null });

      const accept = (body: Record<string, unknown>, cookie = f.member) => call(f, cookie, "POST", `/api/me/tasks/${task.id}/accept`,
        { version: 3, verdict: "路线图定稿，九个迭代", standards: [], deliverableMaterialIds: [], ...body });
      expect((await accept({}, f.third)).json().code).toBe("TASK_NOT_FOUND");
      expect((await accept({ standards: [{ index: 2, met: true, evidence: null, materialId: null }] })).json().code).toBe("ACCEPTANCE_STANDARD_INVALID");
      expect((await accept({ deliverableMaterialIds: [randomUUID()] })).json().code).toBe("ACCEPTANCE_MATERIAL_INVALID");
      const stale = await accept({ version: 2 });
      expect(stale.statusCode).toBe(409);
      expect(stale.json().latestTask.version).toBe(3);

      // 逐条对：有一条没确认达到就不能完成。
      expect((await accept({ standards: [{ index: 0, met: true, evidence: null, materialId: null }] })).json().code).toBe("ACCEPTANCE_NOT_ALL_MET");
      expect((await accept({ standards: [{ index: 0, met: true, evidence: null, materialId: null }, { index: 1, met: false, evidence: "没确认", materialId: null }] })).json().code).toBe("ACCEPTANCE_NOT_ALL_MET");
      const accepted = await accept({ standards: [{ index: 0, met: true, evidence: " 见路线图 v4 ", materialId: doc.id }, { index: 1, met: true, evidence: null, materialId: null }], deliverableMaterialIds: [doc.id, doc.id] });
      expect(accepted.statusCode).toBe(200);
      expect(accepted.json()).toMatchObject({ status: "done", version: 4, awaitingAcceptance: false });
      current = await detail(f, f.third, task.id);
      expect(Value.Check(TaskDetailResponse, current)).toBe(true);
      expect(current.acceptance).toMatchObject({ by: { personId: "person-fixture-002" }, verdict: "路线图定稿，九个迭代", deliverableMaterialIds: [doc.id],
        standards: [{ text: "路线图定稿", met: true, evidence: "见路线图 v4", materialId: doc.id }, { text: "明华确认", met: true, evidence: null, materialId: null }] });
      expect(await groupSays(f, task.id)).toContain("测试乙验收了这件事：路线图定稿，九个迭代");
      expect((await call(f, f.member, "PATCH", `/api/me/tasks/${task.id}`, { version: 4, status: "in_progress" })).json().code).toBe("TASK_ALREADY_DONE");
      expect((await accept({ version: 4 })).json().code).toBe("TASK_ALREADY_DONE");
      // 验收之后改完成标准也不动验收记录里的快照。
      await call(f, f.member, "PATCH", `/api/me/tasks/${task.id}`, { version: 4, doneDefinition: "全新的标准" });
      expect((await detail(f, f.member, task.id)).acceptance.standards[0].text).toBe("路线图定稿");

      expect((await call(f, f.third, "POST", `/api/me/tasks/${task.id}/reopen`, { version: 5 })).json().code).toBe("TASK_NOT_FOUND");
      const reopened = await call(f, f.member, "POST", `/api/me/tasks/${task.id}/reopen`, { version: 5 });
      expect(reopened.json()).toMatchObject({ status: "in_progress", version: 6 });
      expect((await detail(f, f.member, task.id)).acceptance).toBeNull();
      expect(await groupSays(f, task.id)).toContain("测试乙重新打开了这件事。");
      expect((await call(f, f.member, "POST", `/api/me/tasks/${task.id}/reopen`, { version: 6 })).json().code).toBe("TASK_NOT_DONE");
      // 没写完成标准的先写再验收；未启动也能直接验收：完成不一定要留下文件。
      const quiet = (await call(f, f.member, "POST", "/api/me/tasks", newTask(null))).json();
      expect((await call(f, f.member, "POST", `/api/me/tasks/${quiet.id}/accept`, { version: 1, verdict: null, standards: [], deliverableMaterialIds: [] })).json().code)
        .toBe("ACCEPTANCE_NO_STANDARDS");
      const written = (await call(f, f.member, "PATCH", `/api/me/tasks/${quiet.id}`, { version: 1, doneDefinition: "口头确认过" })).json();
      expect((await call(f, f.member, "POST", `/api/me/tasks/${quiet.id}/accept`, { version: written.version, verdict: null,
        standards: [{ index: 0, met: true, evidence: null, materialId: null }], deliverableMaterialIds: [] })).json()).toMatchObject({ status: "done" });
    } finally { await f.t.close(); }
  });

  it("外部工具：update_status(done) 只提交验收；草稿、通知只留一条、协作者不能提交但能放链接；逐条退回写原因、验收后通知已读", async () => {
    const f = await executionFixture();
    try {
      const task = (await call(f, f.member, "POST", "/api/me/tasks", newTask(null, { doneDefinition: "- 路线图定稿\n- 明华确认" }))).json();
      await call(f, f.member, "POST", `/api/me/tasks/${task.id}/collaborators`, { personIds: ["person-fixture-003"] });
      const owner = await mcpAs(f, f.member, "codex"), collaborator = await mcpAs(f, f.third, "other");

      const submitted = await owner("update_status", { itemId: task.id, status: "done", version: 2 });
      expect(submitted).toMatchObject({ isError: false, value: { status: "in_progress", version: 3, submittedForAcceptance: true } });
      expect((await call(f, f.member, "GET", "/api/me/home")).json().myTasks.find((item: { id: string }) => item.id === task.id))
        .toMatchObject({ status: "in_progress", awaitingAcceptance: true });
      let notices = (await call(f, f.member, "GET", "/api/me/notifications")).json().notifications.filter((item: { kind: string }) => item.kind === "task_submitted");
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatchObject({ text: "「第一步」等你验收", objectType: "task", objectId: task.id, readAt: null });
      expect(await groupSays(f, task.id)).toContain("测试乙用 Codex 提交了验收。");

      const linked = await collaborator("add_link", { itemId: task.id, url: "https://github.com/acme/app/pull/42" });
      expect(linked).toMatchObject({ isError: false, value: { title: "github.com · 42", url: "https://github.com/acme/app/pull/42", created: true, item: { status: "in_progress", version: 3 } } });
      expect((await collaborator("submit_for_acceptance", { itemId: task.id, version: 3 })).value).toMatchObject({ code: "FORBIDDEN", message: "只有推进人能提交验收" });
      expect((await collaborator("add_link", { itemId: randomUUID(), url: "https://example.com" })).value.code).toBe("TASK_NOT_FOUND");

      const drafted = await owner("submit_for_acceptance", { itemId: task.id, version: 3, verdict: "路线图 v4 定稿",
        standards: [{ index: 0, met: true, evidence: "PR #42 合入", materialId: linked.value.id }], deliverables: [linked.value.id] });
      expect(drafted.value).toMatchObject({ version: 4, submittedForAcceptance: true });
      const item = (await owner("get_item", { itemId: task.id })).value;
      expect(item.standards).toEqual(["路线图定稿", "明华确认"]);
      expect(item.materials).toEqual([expect.objectContaining({ id: linked.value.id, format: "link", url: "https://github.com/acme/app/pull/42", owner: "测试丙" })]);
      expect(item.submission).toMatchObject({ via: "codex", verdict: "路线图 v4 定稿", deliverableMaterialIds: [linked.value.id],
        standards: [{ index: 0, met: true, evidence: "PR #42 合入", materialId: linked.value.id }] });
      notices = (await call(f, f.member, "GET", "/api/me/notifications")).json().notifications.filter((entry: { kind: string }) => entry.kind === "task_submitted");
      expect(notices).toHaveLength(1);
      expect((await owner("submit_for_acceptance", { itemId: task.id, version: 4, standards: [{ index: 9, met: true }] })).value.code).toBe("ACCEPTANCE_STANDARD_INVALID");

      const giveBack = (standards: unknown[], version = 4, cookie = f.member) => call(f, cookie, "POST", `/api/me/tasks/${task.id}/acceptance-return`, { version, standards });
      expect((await giveBack([{ index: 0, met: true, evidence: null, materialId: null }])).json().code).toBe("ACCEPTANCE_NOTHING_MISSED");
      expect((await giveBack([{ index: 1, met: false, evidence: null, materialId: null }])).json().code).toBe("ACCEPTANCE_REASON_REQUIRED");
      expect((await giveBack([{ index: 1, met: false, evidence: "明华还没确认", materialId: null }], 4, f.third)).json().code).toBe("TASK_NOT_FOUND");
      const cleared = await giveBack([{ index: 0, met: true, evidence: "PR #42 合入", materialId: null }, { index: 1, met: false, evidence: " 明华还没确认 ", materialId: null }]);
      expect(cleared.json()).toMatchObject({ status: "in_progress", awaitingAcceptance: false, version: 5 });
      expect((await call(f, f.member, "GET", "/api/me/notifications")).json().notifications.find((entry: { kind: string }) => entry.kind === "task_submitted").readAt).not.toBeNull();
      expect(await groupSays(f, task.id)).toContain("测试乙验收没通过，退回接着做。没达到：「明华确认」：明华还没确认");

      await owner("update_status", { itemId: task.id, status: "done", version: 5 });
      const accepted = await call(f, f.member, "POST", `/api/me/tasks/${task.id}/accept`, { version: 6, verdict: null,
        standards: [{ index: 0, met: true, evidence: null, materialId: null }, { index: 1, met: true, evidence: null, materialId: null }], deliverableMaterialIds: [] });
      expect(accepted.json()).toMatchObject({ status: "done", awaitingAcceptance: false });
      expect((await call(f, f.member, "GET", "/api/me/notifications")).json().notifications
        .filter((entry: { kind: string }) => entry.kind === "task_submitted").every((entry: { readAt: string | null }) => entry.readAt !== null)).toBe(true);
      expect(await groupSays(f, task.id)).toContain("测试乙验收了这件事。");
      expect((await owner("update_status", { itemId: task.id, status: "in_progress", version: 7 })).value.code).toBe("TASK_ALREADY_DONE");
      expect((await owner("submit_for_acceptance", { itemId: task.id, version: 7 })).value.code).toBe("TASK_ALREADY_DONE");
    } finally { await f.t.close(); }
  });

  it("外部工具写进展让事项开始后，结果里带着最新版本，接着提交验收不撞版本；退回时清掉提交、通知已读", async () => {
    const f = await executionFixture();
    try {
      const task = (await call(f, f.member, "POST", "/api/me/tasks", newTask(null))).json();
      const owner = await mcpAs(f, f.member, "claude");
      const progressed = await owner("append_progress", { itemId: task.id, body: "路线图写完了" });
      expect(progressed.value.item).toEqual({ status: "in_progress", version: 2 });
      expect((await owner("update_status", { itemId: task.id, status: "done", version: progressed.value.item.version })).value)
        .toMatchObject({ status: "in_progress", version: 3, submittedForAcceptance: true });
      await f.t.sql("UPDATE tasks SET created_by='meeting' WHERE id=$1", [task.id]);
      const returned = await call(f, f.member, "POST", `/api/me/tasks/${task.id}/return`, { version: 3, reason: "不归我" });
      expect(returned.json()).toMatchObject({ status: "returned", awaitingAcceptance: false });
      expect((await call(f, f.member, "GET", `/api/me/tasks/${task.id}`)).json().submission).toBeNull();
      expect((await call(f, f.member, "GET", "/api/me/notifications")).json().notifications
        .filter((entry: { kind: string }) => entry.kind === "task_submitted").map((entry: { readAt: string | null }) => entry.readAt !== null)).toEqual([true]);
    } finally { await f.t.close(); }
  });

  it("验收草稿：起草不出来 503；假 Agent 的草稿只留真实存在的标准和材料；协作者、已完成的拿不到", async () => {
    const seen: AcceptanceDraftInput[] = [];
    let materialId = "";
    const f = await executionFixture("confirmed", "2026-10", { taskAcceptanceAgent: { async draft(input) {
      seen.push(input);
      return { verdict: " 九个迭代齐了 ", deliverableMaterialIds: [materialId, randomUUID()],
        standards: [{ index: 0, met: true, evidence: "见路线图", materialId }, { index: 0, met: false, evidence: "重复", materialId: null },
          { index: 5, met: true, evidence: "不存在的一条", materialId: null }, { index: 1, met: false, evidence: "还没找到明华的确认", materialId: randomUUID() }] };
    } } });
    try {
      const task = (await call(f, f.member, "POST", "/api/me/tasks", newTask(null, { doneDefinition: "- 路线图定稿\n- 明华确认" }))).json();
      await call(f, f.member, "POST", `/api/me/tasks/${task.id}/collaborators`, { personIds: ["person-fixture-003"] });
      materialId = (await upload(f, f.member, task.id, "路线图.md", "# 路线图\n\n九个迭代，负责人齐全")).json().id;
      await call(f, f.member, "POST", `/api/materials/task/${task.id}/links`, { url: "https://example.com/proto" });
      await call(f, f.member, "POST", `/api/me/tasks/${task.id}/progress`, { clientEventId: randomUUID(), body: "和明华过了一遍方向" });
      const drafted = await call(f, f.member, "POST", `/api/me/tasks/${task.id}/acceptance-draft`);
      expect(drafted.statusCode).toBe(200);
      expect(drafted.json()).toEqual({ verdict: "九个迭代齐了", deliverableMaterialIds: [materialId],
        standards: [{ index: 0, met: true, evidence: "见路线图", materialId }, { index: 1, met: false, evidence: "还没找到明华的确认", materialId: null }] });
      expect(seen[0]).toMatchObject({ title: "第一步", standards: [{ index: 0, text: "路线图定稿" }, { index: 1, text: "明华确认" }],
        progress: [{ author: "测试乙", body: "和明华过了一遍方向" }], meetingQuote: null });
      expect(seen[0].materials).toEqual([
        expect.objectContaining({ id: materialId, name: "路线图.md", excerpt: "# 路线图\n\n九个迭代，负责人齐全" }),
        expect.objectContaining({ format: "link", url: "https://example.com/proto", excerpt: "" })]);
      expect((await call(f, f.third, "POST", `/api/me/tasks/${task.id}/acceptance-draft`)).statusCode).toBe(404);
      const version = (await detail(f, f.member, task.id)).task.version;
      await call(f, f.member, "POST", `/api/me/tasks/${task.id}/accept`, { version, verdict: null,
        standards: [{ index: 0, met: true, evidence: null, materialId: null }, { index: 1, met: true, evidence: null, materialId: null }], deliverableMaterialIds: [] });
      expect((await call(f, f.member, "POST", `/api/me/tasks/${task.id}/acceptance-draft`)).json().code).toBe("TASK_NOT_ACCEPTABLE");
    } finally { await f.t.close(); }
    const g = await executionFixture();
    try {
      const task = (await call(g, g.member, "POST", "/api/me/tasks", newTask(null))).json();
      const unavailable = await call(g, g.member, "POST", `/api/me/tasks/${task.id}/acceptance-draft`);
      expect(unavailable.statusCode).toBe(503);
      expect(unavailable.json().code).toBe("ACCEPTANCE_DRAFT_UNAVAILABLE");
    } finally { await g.t.close(); }
  });
});
