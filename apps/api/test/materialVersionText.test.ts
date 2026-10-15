import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { collectObjectEvidence } from "../src/meetingEvidence.js";
import { materialParagraphs } from "../src/materialText.js";
import { createObjectMaterial, editObjectMaterial, type MaterialViewer } from "../src/objectMaterials.js";
import { TEST_CEO, createTestApp } from "./helpers.js";

/** 预审输入里的 `[p<n>] 正文` 切回段落数组，用来核对页面打开的段落与预审读到的一致。 */
function evidenceParagraphs(text: string | null): string[] {
  return (text ?? "").split(/\n\n(?=\[p\d+\] )/).map((block) => block.replace(/^\[p\d+\] /, "").trim()).filter(Boolean);
}

const CEO: MaterialViewer = { personId: TEST_CEO.personId, role: "ceo", displayName: "测试甲" };

describe("依据直达：材料某一版的正文段落（feedback 14）", () => {
  it("按引用的版本返回那一版正文，段落编号与预审证据的 [p<n>] 一致；旧版不是当前正文", async () => {
    const t = await createTestApp();
    try {
      const issue = await t.createIssue();
      const ref = { objectType: "issue" as const, objectId: issue.objectRef.id };
      const made = await createObjectMaterial(t.pool, ref, CEO, "交付周报", "# 交付周报\n\n第一段：旧结论。\n\n- 要点一\n- 要点二\n\n第三段：保持不变。", "新写周报", randomUUID());
      expect(await editObjectMaterial(t.pool, ref, made.id, CEO, 1, [{ find: "旧结论", replace: "新结论" }], "改结论", randomUUID())).toEqual({ version: 2, changed: 1 });
      const cookie = await t.loginCookie();
      const base = `/api/materials/issue/${ref.objectId}/${made.id}/text`;

      const v1 = await t.app.inject({ method: "GET", url: `${base}?version=1`, headers: { cookie } });
      expect(v1.statusCode, v1.body).toBe(200);
      expect(v1.json()).toMatchObject({ materialId: made.id, fileName: "交付周报.md", format: "markdown", version: 1, currentVersion: 2, readable: true });
      // 原生 splitMaterialBlocks：标题、段落、每个列表项各是一块。
      expect(v1.json().paragraphs).toEqual(["# 交付周报", "第一段：旧结论。", "- 要点一", "- 要点二", "第三段：保持不变。"]);

      const latest = await t.app.inject({ method: "GET", url: base, headers: { cookie } });
      expect(latest.json()).toMatchObject({ version: 2, currentVersion: 2 });
      expect(latest.json().paragraphs[1]).toBe("第一段：新结论。");

      // 与预审读取层同一套切段：第 k 段就是预审输入里的 [pk]。
      const evidence = await collectObjectEvidence(t.pool.query.bind(t.pool), [ref], CEO, { names: new Map() });
      const used = evidence.materials.find((material) => material.id === made.id);
      expect(used?.sourceRef).toBe(`material:${made.id}@v2`);
      expect(evidenceParagraphs(used?.text ?? null)).toEqual(latest.json().paragraphs);

      const missing = await t.app.inject({ method: "GET", url: `${base}?version=3`, headers: { cookie } });
      expect(missing.statusCode).toBe(404);
      expect(missing.json().code).toBe("MATERIAL_REVISION_NOT_FOUND");
    } finally { await t.close(); }
  }, 20_000);

  it("HTML 先转成文字再切段；PDF 用提取文字；链接没有正文；无权限的人看不到", async () => {
    const t = await createTestApp();
    try {
      const issue = await t.createIssue();
      const ref = { objectType: "issue" as const, objectId: issue.objectRef.id };
      const html = randomUUID(), pdf = randomUUID();
      await t.sql(`INSERT INTO object_materials(id,object_type,object_id,file_name,format,size_bytes,storage_key,origin,owner_id,created_at,updated_at)
        VALUES($1,'issue',$3,'方案.html','html',200,'objects/test/html','upload',$4,now(),now()),($2,'issue',$3,'合同.pdf','pdf',900,'objects/test/pdf','upload',$4,now(),now())`,
      [html, pdf, ref.objectId, TEST_CEO.personId]);
      await t.sql("INSERT INTO material_revisions(material_id,version,body,created_at) VALUES($1,1,$2,now()),($3,1,$4,now())", [
        html, "<html><head><style>p{color:red}</style><script>alert(1)</script></head><body><h1>方案</h1><p>甲方案：先签约。</p><p>乙方案：先验收&amp;后签约。</p></body></html>",
        pdf, "第一条 交付范围\n\n第二条 验收标准以附件为准",
      ]);
      const cookie = await t.loginCookie();
      const htmlText = (await t.app.inject({ method: "GET", url: `/api/materials/issue/${ref.objectId}/${html}/text`, headers: { cookie } })).json();
      expect(htmlText).toMatchObject({ format: "html", readable: true, paragraphs: ["方案", "甲方案：先签约。", "乙方案：先验收&后签约。"] });
      const pdfText = (await t.app.inject({ method: "GET", url: `/api/materials/issue/${ref.objectId}/${pdf}/text`, headers: { cookie } })).json();
      expect(pdfText).toMatchObject({ format: "pdf", readable: true, paragraphs: ["第一条 交付范围", "第二条 验收标准以附件为准"] });

      const evidence = await collectObjectEvidence(t.pool.query.bind(t.pool), [ref], CEO, { names: new Map() });
      expect(evidenceParagraphs(evidence.materials.find((material) => material.id === html)?.text ?? null)).toEqual(htmlText.paragraphs);
      expect(evidenceParagraphs(evidence.materials.find((material) => material.id === pdf)?.text ?? null)).toEqual(pdfText.paragraphs);

      // 普通成员不在这个议题的群里：和材料详情同一道门，404。
      const member = await t.memberCookie();
      expect((await t.app.inject({ method: "GET", url: `/api/materials/issue/${ref.objectId}/${html}/text`, headers: { cookie: member } })).statusCode).toBe(404);
    } finally { await t.close(); }
  }, 20_000);

  it("切段规则：链接与空正文没有段落", () => {
    expect(materialParagraphs("https://example.com/a", "link")).toEqual([]);
    expect(materialParagraphs("   ", "markdown")).toEqual([]);
    expect(materialParagraphs("<p>  </p>", "html")).toEqual([]);
    expect(materialParagraphs("一\n\n\n二", "docx")).toEqual(["一", "二"]);
  });
});
