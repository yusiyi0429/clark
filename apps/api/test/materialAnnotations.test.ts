import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { MaterialDetailResponse } from "@warmap/contracts";
import { createObjectMaterial, editObjectMaterial, readObjectMaterial } from "../src/objectMaterials.js";
import { createMaterialAnnotation, proposeMaterialEdit } from "../src/materialFeedback.js";
import { createMaterialAnnotationQueue } from "../src/materialAnnotationQueue.js";
import type { MaterialAnnotationAgent } from "../src/materialAnnotationAgent.js";
import { TEST_CEO, TEST_MEMBER, createTestApp } from "./helpers.js";

const viewer = { personId: TEST_CEO.personId, role: "ceo" as const, displayName: "测试甲" };
const names = new Map([[TEST_CEO.personId, "测试甲"], [TEST_MEMBER.personId, "测试乙"]]);
const request = (body = "改为明天") => ({ clientId: randomUUID(), version: 1, quote: "今天开会。", prefix: "", suffix: "", body });
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

  it.each(["pdf", "docx"])("%s 只留 kept 批注，禁止恢复", async (format) => {
    const t = await fixture({ async generate() { throw new Error("read-only must not call agent"); } });
    try {
      await t.sql("UPDATE object_materials SET format=$2,origin='upload',storage_key='test-placeholder' WHERE id=$1", [t.id, format]);
      const response = await t.post("/annotations", request());
      expect(response.json().annotation).toMatchObject({ status: "kept", appliedVersion: null });
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
      const propose = () => proposeMaterialEdit(t.pool, t.ref, t.id, viewer, "改日期", [{ find: "今天", replace: "明天" }]);
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
      const stale = await proposeMaterialEdit(t.pool, t.ref, t.id, viewer, "再改", [{ find: "明天", replace: "后天" }]);
      await t.edit("明天", "下周");
      expect((await t.post(`/proposals/${stale.id}`, { decision: "apply" })).statusCode).toBe(409);
      expect((await t.sql("SELECT status FROM material_edit_proposals WHERE id=$1", [stale.id]))[0].status).toBe("stale");
      const staleOnRead = await proposeMaterialEdit(t.pool, t.ref, t.id, viewer, "再改", [{ find: "下周", replace: "后天" }]);
      await t.edit("下周", "下周和下周");
      expect((await t.detail()).proposals).toEqual([]);
      expect((await t.sql("SELECT status FROM material_edit_proposals WHERE id=$1", [staleOnRead.id]))[0].status).toBe("stale");
      await expect(proposeMaterialEdit(t.pool, t.ref, t.id, viewer, "重复", [{ find: "下周", replace: "后天" }])).rejects.toMatchObject({ code: "MATERIAL_FIND_NOT_UNIQUE" });
    } finally { await t.close(); }
  }, 20_000);
});
