import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { MaterialDetailResponse } from "@warmap/contracts";
import { createObjectMaterial, editObjectMaterial, readObjectMaterial } from "../src/objectMaterials.js";
import { createMaterialAnnotation, proposeMaterialEdit } from "../src/materialFeedback.js";
import { createMaterialAnnotationQueue } from "../src/materialAnnotationQueue.js";
import type { MaterialAnnotationAgent } from "../src/materialAnnotationAgent.js";
import { hashSecret } from "../src/session.js";
import { TEST_CEO, TEST_MEMBER, createTestApp } from "./helpers.js";

const viewer = { personId: TEST_CEO.personId, role: "ceo" as const, displayName: "测试甲" };
const names = new Map([[TEST_CEO.personId, "测试甲"], [TEST_MEMBER.personId, "测试乙"]]);
/** 默认是能改的人「立即修改」；保存传 note。 */
const request = (body = "改为明天", intent: "note" | "edit" = "edit") => ({ clientId: randomUUID(), version: 1, quote: "今天开会。", prefix: "", suffix: "", body, intent });
const noChange: MaterialAnnotationAgent = { async generate() { return { candidate: { edits: [], summary: "保持原文", noChange: "原文已满足意见" } }; } };
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
async function fixture(agent: MaterialAnnotationAgent = noChange, body = "# 计划\n\n今天开会。") {
  const t = await createTestApp({}, undefined, { materialAnnotationAgent: agent });
  const issue = await t.createIssue();
  const ref = { objectType: "issue" as const, objectId: issue.objectRef.id };
  const made = await createObjectMaterial(t.pool, ref, viewer, "计划", body, "起草", null);
  const cookie = await t.loginCookie();
  const url = `/api/materials/issue/${ref.objectId}/${made.id}`;
  const headers = { cookie, origin: t.publicOrigin };
  const post = (path: string, payload: unknown) => t.app.inject({ method: "POST", url: url + path, headers, payload });
  const detail = async () => (await t.app.inject({ method: "GET", url, headers })).json();
  const read = () => readObjectMaterial(t.pool.query.bind(t.pool), ref, made.id, viewer);
  const edit = async (find: string, replace: string) => editObjectMaterial(t.pool, ref, made.id, viewer,
    (await read()).version, [{ find, replace }], "讨论后修改", null);
  return { ...t, ref, id: made.id, url, headers, post, detail, read, edit };
}

describe("材料批注队列", () => {
  it("API 按作者和 clientId 幂等；响应 applying 可见，修订带批注；无权限不可写", async () => {
    const entered = gate(), finish = gate();
    let calls = 0;
    const t = await fixture({ async generate(input) {
      calls++; entered.release(); await finish.promise;
      expect(input).toMatchObject({ version: 1, source: "# 计划\n\n今天开会。", quote: "今天开会。", body: "改为明天" });
      return { candidate: { edits: [{ find: "今天", replace: "明天" }], summary: "改日期", noChange: null } };
    } });
    try {
      const input = request();
      const first = await t.post("/annotations", input);
      expect(first.statusCode, first.body).toBe(200);
      expect(first.json().annotation.status).toBe("queued");
      await entered.promise;
      const second = await t.post("/annotations", input);
      expect(second.json().annotation).toMatchObject({ id: first.json().annotation.id, status: "applying" });
      expect((await t.app.inject({ method: "POST", url: `${t.url}/annotations`,
        headers: { cookie: await t.memberCookie(), origin: t.publicOrigin }, payload: request() })).statusCode).toBe(404);
      finish.release();
      await vi.waitFor(async () => expect((await t.detail()).annotations[0].status).toBe("applied"));
      const detail = await t.detail();
      expect(Value.Check(MaterialDetailResponse, detail)).toBe(true);
      expect(detail.annotations).toHaveLength(1);
      expect(detail.annotations[0]).toMatchObject({ appliedVersion: 2, author: { personId: viewer.personId } });
      expect(detail.revision).toMatchObject({ summary: "按批注：改为明天", requestedBy: { personId: viewer.personId },
        annotation: { id: first.json().annotation.id, quote: input.quote, body: input.body } });
      expect(detail.revisions[1].annotation).toBeNull();
      expect(detail.material.lastRevision.annotation).toEqual(detail.revision.annotation);
      expect(detail.blocks[1].history[0].annotation).toEqual(detail.revision.annotation);
      expect(calls).toBe(1);
    } finally { finish.release(); await t.close(); }
  }, 20_000);

  it.each(["pdf", "docx"])("%s 只能保存批注：没有立即修改和采用，禁止恢复", async (format) => {
    const t = await fixture({ async generate() { throw new Error("read-only must not call agent"); } });
    try {
      await t.sql("UPDATE object_materials SET format=$2,origin='upload',storage_key='test-placeholder' WHERE id=$1", [t.id, format]);
      expect((await t.post("/annotations", request())).json().code).toBe("MATERIAL_READ_ONLY");
      const response = await t.post("/annotations", request("改为明天", "note"));
      expect(response.json().annotation).toMatchObject({ status: "noted", appliedVersion: null, canDecide: false, canApply: false });
      const decided = await t.post(`/annotations/${response.json().annotation.id}/decide`, { decision: "adopt" });
      expect(decided.statusCode).toBe(400);
      expect((await t.detail()).material).toMatchObject({ canEdit: false, pending: 0 });
      expect(await t.detail()).toMatchObject({ blocks: null, removed: [], proposals: [] });
      expect((await t.post("/restore", { version: 1, removedId: "v2-0" })).statusCode).toBe(400);
    } finally { await t.close(); }
  });

  it.each([1, 2])("同材料两条批注严格串行（%i 个队列实例），第二条使用第一条改完的源码", async (workers) => {
    const t = await fixture();
    const entered = gate(), finish = gate();
    const seen: { source: string; version: number }[] = [];
    let active = 0, maxActive = 0;
    const agent: MaterialAnnotationAgent = { async generate(input) {
      seen.push({ source: input.source, version: input.version });
      active++; maxActive = Math.max(maxActive, active);
      if (seen.length === 1) { entered.release(); await finish.promise; }
      active--;
      return { candidate: { edits: [{ find: seen.length === 1 ? "今天" : "明天", replace: seen.length === 1 ? "明天" : "后天" }], summary: "改日期", noChange: null } };
    } };
    const errors: unknown[] = [];
    const queues = Array.from({ length: workers }, () => createMaterialAnnotationQueue({ pool: t.pool, agent, viewer: () => viewer, onError: (cause) => errors.push(cause) }));
    try {
      const q = t.pool.query.bind(t.pool);
      await createMaterialAnnotation(q, t.ref, t.id, viewer, request("第一条"), names);
      const first = queues[0].enqueue(t.id);
      await entered.promise;
      await createMaterialAnnotation(q, t.ref, t.id, viewer, request("第二条"), names);
      const second = queues[workers - 1].enqueue(t.id);
      finish.release();
      await Promise.all([first, second]);
      expect(errors).toEqual([]);
      expect(maxActive).toBe(1);
      expect(seen).toEqual([{ source: "# 计划\n\n今天开会。", version: 1 }, { source: "# 计划\n\n明天开会。", version: 2 }]);
      expect((await t.read()).body).toBe("# 计划\n\n后天开会。");
      expect((await t.detail()).annotations.map((item: { status: string }) => item.status)).toEqual(["applied", "applied"]);
    } finally { finish.release(); await Promise.all(queues.map((queue) => queue.close())); await t.close(); }
  }, 20_000);

  it("no_change 不落版；find 不唯一重试一次后 failed；重试能纠正 find", async () => {
    const attempts: Record<string, number> = {};
    const t = await fixture({ async generate(input) {
      attempts[input.body] = (attempts[input.body] ?? 0) + 1;
      if (input.body === "不必改") return { candidate: { edits: [], summary: "无需修改", noChange: "原文已不存在" } };
      const find = input.body === "重试可成功" && attempts[input.body] === 2 ? "今天开会。" : "不存在";
      return { candidate: { edits: [{ find, replace: "明天开会。" }], summary: "改日期", noChange: null } };
    } });
    try {
      for (const body of ["不必改", "一直失败", "重试可成功"]) await t.post("/annotations", request(body));
      await vi.waitFor(async () => expect((await t.detail()).annotations.map((row: { status: string }) => row.status))
        .toEqual(["applied", "failed", "no_change"]));
      expect(attempts).toEqual({ "不必改": 1, "一直失败": 2, "重试可成功": 2 });
      expect((await t.detail()).version).toBe(2);
      const rows = await t.sql("SELECT status,note,attempts FROM material_annotations WHERE material_id=$1 ORDER BY created_at", [t.id]);
      expect(rows).toMatchObject([{ status: "no_change", note: "原文已不存在", attempts: 1 },
        { status: "failed", note: expect.stringContaining("恰好出现一次"), attempts: 2 }, { status: "applied", attempts: 2 }]);
    } finally { await t.close(); }
  }, 20_000);

  it("启动恢复：超时 applying 重新排队；已有 annotation 修订直接 applied，不重复改", async () => {
    const t = await fixture();
    const q = t.pool.query.bind(t.pool);
    const a = await createMaterialAnnotation(q, t.ref, t.id, viewer, request("已经写过"), names);
    const b = await createMaterialAnnotation(q, t.ref, t.id, viewer, request("中断待恢复"), names);
    const client = await t.pool.connect();
    try {
      await client.query("BEGIN");
      await editObjectMaterial(t.pool, t.ref, t.id, viewer, 1, [{ find: "今天", replace: "明天" }], "按批注：已经写过", null,
        { query: client.query.bind(client), annotationId: a.id });
      await client.query("COMMIT");
    } finally { client.release(); }
    await t.sql("UPDATE material_annotations SET status='applying',updated_at=now()-interval '11 minutes' WHERE material_id=$1", [t.id]);
    try {
      const restarted = await t.restart({ async run(input) { return { assistantMessage: "已读", runtimeEntries: input.runtimeEntries }; } });
      await restarted.ready();
      await vi.waitFor(async () => expect((await t.sql("SELECT status FROM material_annotations WHERE id=$1", [b.id]))[0].status).toBe("no_change"));
      expect((await t.sql("SELECT status,applied_version,attempts FROM material_annotations WHERE id=$1", [a.id]))[0])
        .toMatchObject({ status: "applied", applied_version: 2, attempts: 0 });
      expect((await t.read()).version).toBe(2);
    } finally { await t.close(); }
  }, 20_000);

  it("模型异常自动重试一次，failed 原因不暴露 provider 错误内容", async () => {
    let calls = 0;
    const t = await fixture({ async generate() { calls++; throw new Error("provider diagnostic should stay private"); } });
    try {
      await t.post("/annotations", request());
      await vi.waitFor(async () => expect((await t.detail()).annotations[0].status).toBe("failed"));
      expect(calls).toBe(2);
      expect((await t.detail()).annotations[0].note).toBe("Co-Agent 修改失败，请重新批注后再试");
      expect((await t.read()).version).toBe(1);
    } finally { await t.close(); }
  });

  it("认领进程停顿，另一进程恢复完成后，旧进程不再运行 Agent 或覆盖 applied", async () => {
    const t = await fixture();
    const paused = gate(), resume = gate();
    let connections = 0, calls = 0;
    const delayedPool = { query: t.pool.query.bind(t.pool), async connect() {
      if (++connections === 2) { paused.release(); await resume.promise; }
      return t.pool.connect();
    } } as unknown as Pool;
    const agent: MaterialAnnotationAgent = { async generate() {
      calls++;
      return { candidate: { edits: [{ find: "今天", replace: "明天" }], summary: "改日期", noChange: null } };
    } };
    const errors: unknown[] = [];
    const queues = [delayedPool, t.pool].map((pool) => createMaterialAnnotationQueue({ pool, agent, viewer: () => viewer, onError: (cause) => errors.push(cause) }));
    try {
      await createMaterialAnnotation(t.pool.query.bind(t.pool), t.ref, t.id, viewer, request(), names);
      const delayed = queues[0].enqueue(t.id);
      await paused.promise;
      await t.sql("UPDATE material_annotations SET updated_at=now()-interval '11 minutes' WHERE material_id=$1", [t.id]);
      await queues[1].enqueue(t.id);
      resume.release();
      await delayed;
      expect(errors).toEqual([]);
      expect(calls).toBe(1);
      expect((await t.detail()).annotations[0]).toMatchObject({ status: "applied", appliedVersion: 2 });
      expect((await t.read()).version).toBe(2);
    } finally { resume.release(); await Promise.all(queues.map((queue) => queue.close())); await t.close(); }
  }, 20_000);
});

describe("材料历史、垃圾篓和提议", () => {
  it("history 跨过未改版本回溯，最多五条；历史版本不给 history/removed/proposals", async () => {
    const t = await fixture();
    try {
      await t.edit("今天", "明天");
      await editObjectMaterial(t.pool, t.ref, t.id, viewer, 2, [{ append: "新段落" }], "补一段", null);
      await t.edit("明天", "后天");
      let detail = await t.detail();
      expect(detail.blocks.find((block: { text: string }) => block.text === "后天开会。").history)
        .toMatchObject([{ version: 4, kind: "modified", before: "明天开会。" }, { version: 2, kind: "modified", before: "今天开会。" }]);
      expect(detail.blocks[0].history).toEqual([]);
      expect(detail.blocks.at(-1).history).toMatchObject([{ version: 3, kind: "added", before: "" }]);
      for (let index = 0; index < 5; index++) await t.edit(index ? `日期${index - 1}开会。` : "后天开会。", `日期${index}开会。`);
      detail = await t.detail();
      expect(detail.blocks[1].history.map((item: { version: number }) => item.version)).toEqual([9, 8, 7, 6, 5]);
      const old = (await t.app.inject({ method: "GET", url: `${t.url}?version=4`, headers: t.headers })).json();
      expect(old).toMatchObject({ latest: false, removed: [], proposals: [] });
      expect(old.blocks.every((block: { history: unknown[] }) => block.history.length === 0)).toBe(true);
    } finally { await t.close(); }
  }, 20_000);

  it("垃圾篓稳定 ID；恢复插回前一段之后、版本冲突 409、恢复后消失", async () => {
    const source = "# 标题\n\n开头说明\n\n被删内容甲\n\n结尾说明";
    const t = await fixture(noChange, source);
    try {
      await t.edit("被删内容甲\n\n", "");
      const removed = (await t.detail()).removed[0];
      expect(removed).toMatchObject({ id: "v2-2", text: "被删内容甲", version: 2, requestedBy: { personId: viewer.personId }, annotation: null });
      expect((await t.post("/restore", { version: 1, removedId: removed.id })).json().code).toBe("VERSION_CONFLICT");
      const response = await t.post("/restore", { version: 2, removedId: removed.id });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ version: 3, removed: [], revision: { summary: "从垃圾篓恢复", requestedBy: { personId: viewer.personId } } });
      expect((await t.read()).body).toBe(source);
      expect((await t.post("/restore", { version: 3, removedId: removed.id })).statusCode).toBe(404);
      await t.edit("被删内容甲\n\n", "");
      expect((await t.detail()).removed.map((item: { id: string }) => item.id)).toEqual(["v4-2"]);
    } finally { await t.close(); }
  });

  it("HTML 按行删除、仅标签不入垃圾篓、恢复保留源码结构、history 为空", async () => {
    const source = "<html>\n<body>\n<h1>标题</h1>\n<p>要删除的说明</p>\n<hr>\n<p>保留</p>\n</body>\n</html>";
    const t = await fixture(noChange, source);
    try {
      await t.sql("UPDATE object_materials SET format='html',origin='upload',storage_key='test-placeholder' WHERE id=$1", [t.id]);
      await t.edit("<p>要删除的说明</p>\n<hr>\n", "");
      const detail = await t.detail();
      expect(detail.removed).toHaveLength(1);
      expect(detail.removed[0].text).toBe("<p>要删除的说明</p>");
      expect(detail.blocks.every((block: { history: unknown[] }) => block.history.length === 0)).toBe(true);
      const response = await t.post("/restore", { version: 2, removedId: detail.removed[0].id });
      expect(response.json().removed).toEqual([]);
      expect((await t.read()).body).toBe(source.replace("<hr>\n", ""));
    } finally { await t.close(); }
  });

  it("被删块的前一块也已不存在时，恢复到原位置附近或文末", async () => {
    const t = await fixture(noChange, "# 标题\n\n原来前段\n\n待恢复内容\n\n末段");
    try {
      await t.edit("原来前段\n\n待恢复内容\n\n", "");
      const removed = (await t.detail()).removed.find((item: { text: string }) => item.text === "待恢复内容");
      const response = await t.post("/restore", { version: 2, removedId: removed.id });
      expect(response.statusCode).toBe(200);
      expect((await t.read()).body).toBe("# 标题\n\n末段\n\n待恢复内容");
      expect(response.json().removed.map((item: { text: string }) => item.text)).toEqual(["原来前段"]);
    } finally { await t.close(); }
  });

  it("提议只有本人可处理；apply/dismiss；变版后仍唯一则应用，否则 stale", async () => {
    const t = await fixture();
    try {
      await t.sql("INSERT INTO thread_members(object_type,object_id,person_id,added_by) VALUES('issue',$1,$2,$2),('issue',$1,$3,$2)",
        [t.ref.objectId, TEST_CEO.personId, TEST_MEMBER.personId]);
      const propose = () => proposeMaterialEdit(t.pool, t.ref, t.id, viewer, "改日期", [{ find: "今天", replace: "明天" }], names);
      const first = await propose(), second = await propose();
      expect((await t.detail()).proposals).toHaveLength(2);
      const memberHeaders = { cookie: await t.memberCookie(), origin: t.publicOrigin };
      expect((await t.app.inject({ method: "GET", url: t.url, headers: memberHeaders })).json().proposals).toEqual([]);
      expect((await t.app.inject({ method: "POST", url: `${t.url}/proposals/${first.id}`, headers: memberHeaders, payload: { decision: "apply" } })).statusCode).toBe(403);
      expect((await t.post(`/proposals/${second.id}`, { decision: "dismiss" })).statusCode).toBe(200);
      expect((await t.read()).version).toBe(1);
      await t.edit("# 计划", "# 新计划");
      expect((await t.post(`/proposals/${first.id}`, { decision: "apply" })).json()).toMatchObject({ version: 3, proposals: [], revision: { summary: "改日期" } });
      expect((await t.read()).body).toContain("明天开会。");
      const stale = await proposeMaterialEdit(t.pool, t.ref, t.id, viewer, "再改", [{ find: "明天", replace: "后天" }], names);
      await t.edit("明天", "下周");
      expect((await t.post(`/proposals/${stale.id}`, { decision: "apply" })).statusCode).toBe(409);
      expect((await t.sql("SELECT status FROM material_edit_proposals WHERE id=$1", [stale.id]))[0].status).toBe("stale");
      const staleOnRead = await proposeMaterialEdit(t.pool, t.ref, t.id, viewer, "再改", [{ find: "下周", replace: "后天" }], names);
      await t.edit("下周", "下周和下周");
      expect((await t.detail()).proposals).toEqual([]);
      expect((await t.sql("SELECT status FROM material_edit_proposals WHERE id=$1", [staleOnRead.id]))[0].status).toBe("stale");
      await expect(proposeMaterialEdit(t.pool, t.ref, t.id, viewer, "重复", [{ find: "下周", replace: "后天" }], names)).rejects.toMatchObject({ code: "MATERIAL_FIND_NOT_UNIQUE" });
    } finally { await t.close(); }
  }, 20_000);
});

/** 执行事项：测试乙是推进人，测试丙是协作者；测试乙、测试丙各上传一份材料。 */
const PEOPLE = fileURLToPath(new URL("./fixtures/company-people-candidate.json", import.meta.url));
const THIRD = { personId: "person-fixture-003", loginId: "ceshib", passcode: "3579" } as const;
const OWNER = { personId: TEST_MEMBER.personId, role: "member" as const, displayName: "测试乙" };
const COLLABORATOR = { personId: THIRD.personId, role: "member" as const, displayName: "测试丙" };
type Note = { id: string; status: string; stale: boolean; canDecide: boolean; canApply: boolean };
type Listed = { canEdit: boolean; pending: number };
async function taskFixture(agent: MaterialAnnotationAgent = noChange) {
  const t = await createTestApp({ companyPeopleSeed: PEOPLE }, undefined, { materialAnnotationAgent: agent });
  const ref = { objectType: "task" as const, objectId: randomUUID() };
  await t.sql("INSERT INTO tasks(id,title,status,owner_id,created_by) VALUES($1,'材料走查','not_started',$2,$2)", [ref.objectId, OWNER.personId]);
  await t.sql("INSERT INTO thread_members(object_type,object_id,person_id,added_by) VALUES('task',$1,$2,$2),('task',$1,$3,$2)",
    [ref.objectId, OWNER.personId, THIRD.personId]);
  await t.sql("INSERT INTO member_access (person_id, login_id, passcode_hash, must_change) VALUES ($1, $2, $3, FALSE)",
    [THIRD.personId, THIRD.loginId, hashSecret(THIRD.passcode)]);
  const login = await t.app.inject({ method: "POST", url: "/api/auth/login", headers: { origin: t.publicOrigin }, payload: { loginId: THIRD.loginId, passcode: THIRD.passcode } });
  const cookies = { owner: await t.memberCookie(), collaborator: (login.headers["set-cookie"] as string).split(";")[0], ceo: await t.loginCookie() };
  const ownerDoc = (await createObjectMaterial(t.pool, ref, OWNER, "方案", "# 方案\n\n今天开会。", "起草", null)).id;
  const collaboratorDoc = (await createObjectMaterial(t.pool, ref, COLLABORATOR, "补充", "# 补充\n\n周三交付。", "起草", null)).id;
  const base = `/api/materials/task/${ref.objectId}`;
  const as = (cookie: string) => ({
    list: async () => ((await t.app.inject({ method: "GET", url: base, headers: { cookie } })).json().materials as Listed[]).map((item) => [item.canEdit, item.pending]),
    detail: async (id: string) => (await t.app.inject({ method: "GET", url: `${base}/${id}`, headers: { cookie } })).json(),
    post: (id: string, path: string, payload: unknown) => t.app.inject({ method: "POST", url: `${base}/${id}${path}`, headers: { cookie, origin: t.publicOrigin }, payload }),
  });
  return { ...t, ref, ownerDoc, collaboratorDoc, owner: as(cookies.owner), collaborator: as(cookies.collaborator), ceo: as(cookies.ceo) };
}

describe("材料批注按谁写的区分", () => {
  it("协作者只能保存、正文不动；推进人采用后排队按批注改，修订记采用人和提出人；原文已改的批注标出来", async () => {
    const seen: string[] = [];
    const t = await taskFixture({ async generate(input) {
      seen.push(input.body);
      return { candidate: { edits: [{ find: "今天", replace: "明天" }], summary: "改日期", noChange: null } };
    } });
    try {
      expect((await t.collaborator.post(t.ownerDoc, "/annotations", request())).json().code).toBe("MATERIAL_FORBIDDEN");
      const saved: Note = (await t.collaborator.post(t.ownerDoc, "/annotations", request("改为明天", "note"))).json().annotation;
      expect(saved).toMatchObject({ status: "noted", decidedBy: null, canDecide: false, canApply: false });
      const later: Note = (await t.collaborator.post(t.ownerDoc, "/annotations", request("加上地点", "note"))).json().annotation;
      const title: Note = (await t.collaborator.post(t.ownerDoc, "/annotations", { ...request("标题改短", "note"), quote: "方案" })).json().annotation;
      expect((await t.collaborator.detail(t.ownerDoc)).version).toBe(1);
      expect(await t.collaborator.list()).toEqual([[false, 0], [true, 0]]);
      expect((await t.collaborator.post(t.ownerDoc, `/annotations/${saved.id}/decide`, { decision: "adopt" })).statusCode).toBe(403);
      expect(await t.owner.list()).toEqual([[true, 3], [true, 0]]);
      expect((await t.owner.detail(t.ownerDoc)).annotations.find((note: Note) => note.id === saved.id)).toMatchObject({ canDecide: true, canApply: false });
      const adopted = await t.owner.post(t.ownerDoc, `/annotations/${saved.id}/decide`, { decision: "adopt" });
      expect(adopted.json().annotation).toMatchObject({ status: "queued", decidedBy: { personId: OWNER.personId } });
      await vi.waitFor(async () => expect((await t.owner.detail(t.ownerDoc)).annotations.find((note: Note) => note.id === saved.id).status).toBe("applied"));
      const detail = await t.owner.detail(t.ownerDoc);
      expect(Value.Check(MaterialDetailResponse, detail)).toBe(true);
      expect(detail.revision).toMatchObject({ version: 2, summary: "按测试丙的批注：改为明天", requestedBy: { personId: OWNER.personId },
        annotation: { id: saved.id, author: { personId: THIRD.personId } } });
      expect(detail.annotations.map((note: Note) => [note.id, note.status, note.stale])).toEqual([
        [title.id, "noted", false], [later.id, "noted", true], [saved.id, "applied", false]]);
      expect(await t.owner.list()).toEqual([[true, 2], [true, 0]]);
      expect((await t.owner.post(t.ownerDoc, `/annotations/${saved.id}/decide`, { decision: "decline" })).json().code).toBe("MATERIAL_ANNOTATION_DECIDED");
      expect(seen).toEqual(["改为明天"]);
    } finally { await t.close(); }
  }, 20_000);

  it("上传者「立即修改」直接排队；推进人也能处理协作者材料上的批注；不采用记原因；自己保存的能改成立即修改", async () => {
    const t = await taskFixture();
    try {
      const edit: Note = (await t.collaborator.post(t.collaboratorDoc, "/annotations", request("周三改周五"))).json().annotation;
      expect(edit).toMatchObject({ status: "queued", decidedBy: { personId: THIRD.personId } });
      const kept: Note = (await t.collaborator.post(t.collaboratorDoc, "/annotations", request("先记下", "note"))).json().annotation;
      const mine: Note = (await t.owner.post(t.collaboratorDoc, "/annotations", request("推进人的意见", "note"))).json().annotation;
      expect((await t.owner.detail(t.collaboratorDoc)).annotations.filter((note: Note) => note.status === "noted")
        .map((note: Note) => [note.id, note.canDecide, note.canApply])).toEqual([[mine.id, false, true], [kept.id, true, false]]);
      const declined = await t.owner.post(t.collaboratorDoc, `/annotations/${kept.id}/decide`, { decision: "decline", reason: " 已经改过了 " });
      expect(declined.json().annotation).toMatchObject({ status: "declined", note: "已经改过了", decidedBy: { personId: OWNER.personId } });
      const applied = await t.owner.post(t.collaboratorDoc, `/annotations/${mine.id}/decide`, { decision: "adopt" });
      expect(applied.json().annotation).toMatchObject({ status: "queued", decidedBy: { personId: OWNER.personId } });
      await vi.waitFor(async () => expect((await t.owner.detail(t.collaboratorDoc)).annotations.map((note: Note) => note.status))
        .toEqual(["no_change", "declined", "no_change"]));
    } finally { await t.close(); }
  }, 20_000);

  it("不能改的人提的修改建议交给上传者，对象负责人也能处理；恢复删掉的段落也只给能改的人", async () => {
    const t = await taskFixture();
    try {
      await t.sql("INSERT INTO thread_members(object_type,object_id,person_id,added_by) VALUES('task',$1,$2,$3)", [t.ref.objectId, TEST_CEO.personId, OWNER.personId]);
      const proposal = await proposeMaterialEdit(t.pool, t.ref, t.collaboratorDoc, viewer, "改交付日", [{ find: "周三", replace: "周五" }],
        new Map([[THIRD.personId, "测试丙"]]));
      expect(proposal.message).toBe("已交给测试丙，测试丙在材料上方点『按这个改』才生效");
      expect((await t.collaborator.detail(t.collaboratorDoc)).proposals).toMatchObject([{ id: proposal.id,
        proposedBy: { personId: TEST_CEO.personId }, proposedFor: { personId: THIRD.personId } }]);
      expect((await t.ceo.detail(t.collaboratorDoc)).proposals).toEqual([]);
      expect((await t.ceo.post(t.collaboratorDoc, `/proposals/${proposal.id}`, { decision: "apply" })).statusCode).toBe(403);
      const applied = await t.owner.post(t.collaboratorDoc, `/proposals/${proposal.id}`, { decision: "apply" });
      expect(applied.json()).toMatchObject({ version: 2, proposals: [], revision: { summary: "改交付日", requestedBy: { personId: OWNER.personId } } });
      await editObjectMaterial(t.pool, t.ref, t.ownerDoc, OWNER, 1, [{ find: "\n\n今天开会。", replace: "" }], "删掉一段", null);
      const removed = (await t.collaborator.detail(t.ownerDoc)).removed[0];
      expect(removed).toMatchObject({ text: "今天开会。", restorable: false });
      expect((await t.collaborator.post(t.ownerDoc, "/restore", { version: 2, removedId: removed.id })).statusCode).toBe(403);
      expect((await t.owner.detail(t.ownerDoc)).removed[0].restorable).toBe(true);
    } finally { await t.close(); }
  }, 20_000);
});
