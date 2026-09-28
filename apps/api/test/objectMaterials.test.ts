import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createObjectMaterial, editObjectMaterial, listObjectMaterials, readObjectMaterial } from "../src/objectMaterials.js";
import { parseMaterialBatch } from "../src/materialParser.js";
import { TEST_CEO, TEST_MEMBER, createTestApp } from "./helpers.js";

const multipart = (name: string, body: string, mime = "text/markdown") => {
  const boundary = "----object-material-test";
  return { headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${mime}\r\n\r\n${body}\r\n--${boundary}--\r\n`) };
};

describe("议题材料", () => {
  it("群成员上传、看旧版、本人删除；非成员和非主人被拒绝", async () => {
    const storage = await mkdtemp(join(tmpdir(), "object-material-test-"));
    let currentObject: Record<string, unknown> | null = null;
    const t = await createTestApp({ materialStorageDir: storage }, { async run(input) {
      currentObject = input.currentObject as Record<string, unknown>;
      return { assistantMessage: "已读", runtimeEntries: input.runtimeEntries };
    } });
    try {
      const issue = await t.createIssue();
      const id = issue.objectRef.id;
      const base = `/api/materials/issue/${id}`;
      const member = await t.memberCookie(), ceo = await t.loginCookie();
      const get = (cookie: string, url = base) => t.app.inject({ method: "GET", url, headers: { cookie } });
      expect((await get(member)).statusCode).toBe(404);
      expect((await get(ceo)).json()).toMatchObject({ materials: [], canUpload: true });
      await t.sql("INSERT INTO thread_members(object_type,object_id,person_id,added_by) VALUES('issue',$1,$2,$2),('issue',$1,$3,$2)",
        [id, TEST_CEO.personId, TEST_MEMBER.personId]);
      const upload = await t.app.inject({ method: "POST", url: base,
        headers: { cookie: member, origin: t.publicOrigin, ...multipart("计划.md", "# 计划\n\n今天开会。").headers },
        payload: multipart("计划.md", "# 计划\n\n今天开会。").payload });
      expect(upload.statusCode, upload.body).toBe(201);
      const materialId = upload.json().id as string;
      const turn = await t.app.inject({ method: "POST", url: `/api/conversations/issue:${id}/messages`,
        headers: { cookie: member, origin: t.publicOrigin, accept: "text/event-stream" },
        payload: { message: "看看这份", viewingMaterialId: materialId } });
      expect(turn.statusCode).toBe(200);
      expect(currentObject?.viewingMaterial).toMatchObject({ id: materialId, fileName: "计划.md", version: 1, editable: true });
      expect((await t.app.inject({ method: "POST", url: `/api/conversations/issue:${id}/messages`,
        headers: { cookie: member, origin: t.publicOrigin, accept: "text/event-stream" },
        payload: { message: "别的对象", viewingMaterialId: randomUUID() } })).statusCode).toBe(404);
      expect((await get(member)).json().materials[0]).toMatchObject({ id: materialId, canDelete: true, editable: true, version: 1 });
      expect((await get(ceo)).json().materials[0].canDelete).toBe(false);
      const ref = { objectType: "issue" as const, objectId: id };
      const viewer = { personId: TEST_MEMBER.personId, role: "member" as const, displayName: "测试乙" };
      expect(await editObjectMaterial(t.pool, ref, materialId, viewer, 1, [{ find: "今天", replace: "明天" }], "改开会日期", randomUUID()))
        .toEqual({ version: 2, changed: 1 });
      const latest = (await get(member, `${base}/${materialId}`)).json();
      expect(latest.blocks[1]).toMatchObject({ text: "明天开会。", change: { kind: "modified", before: "今天开会。" } });
      expect((await get(member, `${base}/${materialId}?version=1`)).json()).toMatchObject({ version: 1, latest: false });
      const file = await get(member, `${base}/${materialId}/file`);
      expect(file.body).toContain("今天开会");
      expect(file.headers["content-security-policy"]).toBe("sandbox");
      expect((await t.app.inject({ method: "DELETE", url: `${base}/${materialId}`, headers: { cookie: ceo, origin: t.publicOrigin } })).statusCode).toBe(403);
      expect((await t.app.inject({ method: "DELETE", url: `${base}/${materialId}`, headers: { cookie: member, origin: t.publicOrigin } })).statusCode).toBe(204);
      expect((await get(member)).json().materials).toEqual([]);
      await expect(readObjectMaterial(t.pool.query.bind(t.pool), ref, materialId, viewer)).rejects.toMatchObject({ status: 404 });
    } finally { await t.close(); await rm(storage, { recursive: true, force: true }); }
  }, 20_000);

  it("Agent 的版本和权限检查、唯一匹配、写入群消息与 30 份上限", async () => {
    const t = await createTestApp();
    try {
      const issue = await t.createIssue();
      const ref = { objectType: "issue" as const, objectId: issue.objectRef.id };
      const member = { personId: TEST_MEMBER.personId, role: "member" as const, displayName: "测试乙" };
      const ceo = { personId: TEST_CEO.personId, role: "ceo" as const, displayName: "测试甲" };
      await t.sql("INSERT INTO thread_members(object_type,object_id,person_id,added_by) VALUES('issue',$1,$2,$2),('issue',$1,$3,$2)",
        [ref.objectId, TEST_CEO.personId, TEST_MEMBER.personId]);
      const made = await createObjectMaterial(t.pool, ref, member, "版本规划", "甲甲", "新写规划", randomUUID());
      const edit = (version: number, find: string) => editObjectMaterial(t.pool, ref, made.id, member, version,
        [{ find, replace: "乙" }], "换字", randomUUID());
      await expect(edit(0, "甲")).rejects.toMatchObject({ code: "MATERIAL_VERSION_CONFLICT", version: 1 });
      await expect(edit(1, "甲")).rejects.toMatchObject({ code: "MATERIAL_FIND_NOT_UNIQUE", version: 1 });
      expect(await editObjectMaterial(t.pool, ref, made.id, member, 1, [{ find: "甲甲", replace: "乙" }], "换字", randomUUID()))
        .toEqual({ version: 2, changed: 1 });
      const messages = await t.sql("SELECT content FROM thread_messages WHERE object_type='issue' AND object_id=$1 ORDER BY id", [ref.objectId]);
      expect(messages.map((row) => row.content)).toEqual(["按测试乙的要求新写了《版本规划.md》：新写规划", "按测试乙的要求改了《版本规划.md》：换字"]);
      expect((await t.sql("SELECT version FROM material_revisions WHERE material_id=$1 ORDER BY version", [made.id])).map((row) => row.version)).toEqual([1, 2]);
      const downloaded = await t.app.inject({ method: "GET", url: `/api/materials/issue/${ref.objectId}/${made.id}/file`,
        headers: { cookie: await t.memberCookie() } });
      expect(downloaded.statusCode).toBe(200);
      expect(downloaded.body).toBe("乙");
      await t.sql("UPDATE thread_members SET left_at=now() WHERE object_type='issue' AND object_id=$1 AND person_id=$2", [ref.objectId, TEST_MEMBER.personId]);
      await expect(editObjectMaterial(t.pool, ref, made.id, member, 2, [{ append: "丙" }], "追加", randomUUID())).rejects.toMatchObject({ status: 404 });
      for (let index = 1; index < 30; index++) await t.sql(`INSERT INTO object_materials(id,object_type,object_id,file_name,format,size_bytes,origin,owner_id,created_at,updated_at)
        VALUES($1,'issue',$2,$3,'markdown',1,'agent',$4,now(),now())`, [randomUUID(), ref.objectId, `${index}.md`, ceo.personId]);
      await expect(createObjectMaterial(t.pool, ref, ceo, "超额", "正文", "说明", randomUUID())).rejects.toMatchObject({ code: "MATERIAL_LIMIT" });
      expect((await listObjectMaterials(t.pool.query.bind(t.pool), ref, ceo, new Map())).materials).toHaveLength(30);
    } finally { await t.close(); }
  }, 20_000);

  it("拒绝错误类型、超大文件和修改 PDF", async () => {
    const t = await createTestApp();
    try {
      const issue = await t.createIssue();
      const id = issue.objectRef.id;
      const ceo = await t.loginCookie();
      const upload = (name: string, content: string, mime: string) => {
        const part = multipart(name, content, mime);
        return t.app.inject({ method: "POST", url: `/api/materials/issue/${id}`,
          headers: { cookie: ceo, origin: t.publicOrigin, ...part.headers }, payload: part.payload });
      };
      expect((await upload("错误.txt", "文字", "text/plain")).statusCode).toBe(400);
      expect((await upload("过大.md", "x".repeat(20 * 1024 * 1024 + 1), "text/markdown")).statusCode).toBe(413);
      const pdfId = randomUUID();
      await t.sql(`INSERT INTO object_materials(id,object_type,object_id,file_name,format,size_bytes,storage_key,origin,owner_id,created_at,updated_at)
        VALUES($1,'issue',$2,'资料.pdf','pdf',10,$3,'upload',$4,now(),now())`,
      [pdfId, id, `objects/issue/${id}/${pdfId}`, TEST_CEO.personId]);
      await t.sql("INSERT INTO material_revisions(material_id,version,body,created_at) VALUES($1,1,'解析文字',now())", [pdfId]);
      await expect(editObjectMaterial(t.pool, { objectType: "issue", objectId: id }, pdfId,
        { personId: TEST_CEO.personId, role: "ceo", displayName: "测试甲" }, 1, [{ append: "更多" }], "补充", randomUUID()))
        .rejects.toMatchObject({ code: "MATERIAL_READ_ONLY", version: 1 });
    } finally { await t.close(); }
  }, 20_000);

  it("上传 HTML 源码，按版本预览和下载，Agent 能替换并在 body 末尾追加", async () => {
    const storage = await mkdtemp(join(tmpdir(), "object-html-test-"));
    const t = await createTestApp({ materialStorageDir: storage });
    try {
      const issue = await t.createIssue();
      const base = `/api/materials/issue/${issue.objectRef.id}`;
      const cookie = await t.loginCookie();
      const source = "<html>\n<head><style>p{color:blue}</style><script>secret()</script></head>\n<body>\n<p>旧方案</p>\n</body>\n</html>";
      const part = multipart("方案.html", source, "text/html");
      const upload = await t.app.inject({ method: "POST", url: base,
        headers: { cookie, origin: t.publicOrigin, ...part.headers }, payload: part.payload });
      expect(upload.statusCode, upload.body).toBe(201);
      expect(upload.json()).toMatchObject({ format: "html", editable: true, version: 1 });
      const materialId = upload.json().id as string;
      const ref = { objectType: "issue" as const, objectId: issue.objectRef.id as string };
      const viewer = { personId: TEST_CEO.personId, role: "ceo" as const, displayName: "测试甲" };
      expect((await readObjectMaterial(t.pool.query.bind(t.pool), ref, materialId, viewer)).body).toBe(source);
      expect((await t.app.inject({ method: "GET", url: `${base}/${materialId}`, headers: { cookie } })).json().blocks).toEqual([]);
      const edit = await editObjectMaterial(t.pool, ref, materialId, viewer, 1,
        [{ find: "旧方案", replace: "新方案" }, { append: "<p>新增内容</p>" }], "更新方案", randomUUID());
      expect(edit).toEqual({ version: 2, changed: 2 });
      const detail = (await t.app.inject({ method: "GET", url: `${base}/${materialId}`, headers: { cookie } })).json();
      expect(detail.blocks).toEqual(expect.arrayContaining([
        expect.objectContaining({ text: "<p>新方案</p>", change: expect.objectContaining({ kind: "modified", before: "<p>旧方案</p>" }) }),
        expect.objectContaining({ text: "<p>新增内容</p>", change: { kind: "added" } }),
      ]));
      expect(detail.blocks).toHaveLength(2);
      const preview = await t.app.inject({ method: "GET", url: `${base}/${materialId}/preview`, headers: { cookie } });
      expect(preview.statusCode).toBe(200);
      expect(preview.headers["content-type"]).toBe("text/html; charset=utf-8");
      expect(preview.headers["x-content-type-options"]).toBe("nosniff");
      expect(preview.headers["content-security-policy"]).toBe("sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' https:; style-src 'unsafe-inline' https:; img-src https: data: blob:; font-src https: data:; media-src https: data: blob:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'");
      expect(preview.body).toContain("<p>新方案</p>\n<p>新增内容</p>\n</body>");
      const old = await t.app.inject({ method: "GET", url: `${base}/${materialId}/preview?version=1`, headers: { cookie } });
      expect(old.body).toBe(source);
      const download = await t.app.inject({ method: "GET", url: `${base}/${materialId}/file`, headers: { cookie } });
      expect(download.body).toBe(preview.body);
      expect(download.headers["content-security-policy"]).toBe("sandbox");
      expect((await t.app.inject({ method: "GET", url: `${base}/${materialId}?version=1`, headers: { cookie } })).json()).toMatchObject({ version: 1, latest: false });
      for (const response of [
        await t.app.inject({ method: "GET", url: `${base}/${materialId}/preview` }),
        await t.app.inject({ method: "GET", url: `${base}/${materialId}/preview?version=99`, headers: { cookie } }),
        await t.app.inject({ method: "GET", url: `${base}/${materialId}/preview?version=0`, headers: { cookie } }),
      ]) {
        expect([401, 404, 400]).toContain(response.statusCode);
        expect(response.headers["x-content-type-options"]).toBe("nosniff");
        expect(response.headers["content-security-policy"]).toBe("sandbox");
      }
      const replacement = "$& $$ $' $`";
      await editObjectMaterial(t.pool, ref, materialId, viewer, 2, [{ find: "新方案", replace: replacement }], "保留美元符", randomUUID());
      expect((await readObjectMaterial(t.pool.query.bind(t.pool), ref, materialId, viewer)).body).toContain(`<p>${replacement}</p>`);
      for (const edits of [[{ find: "\u0000", replace: "字" }], [{ find: "新增内容", replace: "\u0000" }], [{ append: "\u0000" }]]) {
        await expect(editObjectMaterial(t.pool, ref, materialId, viewer, 3, edits, "非法空字符", randomUUID()))
          .rejects.toMatchObject({ code: "INVALID_MATERIAL_EDIT", version: 3 });
      }
    } finally { await t.close(); await rm(storage, { recursive: true, force: true }); }
  }, 20_000);

  it("允许 .htm 八位流，拒绝过长 HTML，会议解析仍拒绝 HTML", async () => {
    const t = await createTestApp();
    try {
      const issue = await t.createIssue();
      const cookie = await t.loginCookie();
      const upload = (name: string, body: string, mime: string) => {
        const part = multipart(name, body, mime);
        return t.app.inject({ method: "POST", url: `/api/materials/issue/${issue.objectRef.id}`,
          headers: { cookie, origin: t.publicOrigin, ...part.headers }, payload: part.payload });
      };
      const htm = await upload("图表.htm", "<html><canvas></canvas></html>", "application/octet-stream");
      expect(htm.statusCode).toBe(201);
      await editObjectMaterial(t.pool, { objectType: "issue", objectId: issue.objectRef.id as string }, htm.json().id,
        { personId: TEST_CEO.personId, role: "ceo", displayName: "测试甲" }, 1, [{ append: "<p>后补</p>" }], "补充", randomUUID());
      const appended = await t.app.inject({ method: "GET", url: `/api/materials/issue/${issue.objectRef.id}/${htm.json().id}/preview`, headers: { cookie } });
      expect(appended.body).toBe("<html><canvas></canvas></html>\n<p>后补</p>");
      const download = await t.app.inject({ method: "GET", url: `/api/materials/issue/${issue.objectRef.id}/${htm.json().id}/file`, headers: { cookie } });
      expect(download.headers["content-disposition"]).toContain("%E5%9B%BE%E8%A1%A8.html");
      expect(download.body).toBe(appended.body);
      const large = await upload("过长.html", "<p>" + "x".repeat(2_000_000) + "</p>", "text/html");
      expect(large.statusCode).toBe(400);
      expect(large.json()).toMatchObject({ code: "MATERIAL_HTML_TOO_LARGE", message: "HTML 超过 2,000,000 字符，不能上传" });
      for (const [name, mime] of [["空.html", "text/html"], ["空.md", "text/markdown"]]) {
        const invalid = await upload(name, "正文\u0000尾巴", mime);
        expect(invalid.statusCode).toBe(400);
        expect(invalid.json()).toMatchObject({ code: "MATERIAL_INVALID_TEXT", message: "文件里有无法保存的空字符" });
      }
      await expect(parseMaterialBatch([{ filename: "会议.html", mimetype: "text/html", buffer: Buffer.from("<p>会议</p>") }]))
        .rejects.toMatchObject({ code: "UNSUPPORTED_MATERIAL_TYPE" });
    } finally { await t.close(); }
  }, 20_000);
});
