import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { createTestApp, type TestApp } from "./helpers.js";

/** 最小可解析 PDF：单页 + 有效文字层（pdfjs-dist 可抽取文本）。 */
export function minimalPdf(text: string): Buffer {
  const stream = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const startxref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

/** 最小合法 DOCX：OOXML 必要入口 + 无图片/外部资源，可通过上传 ZIP 预检。 */
async function minimalDocx(body: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
  );
  zip.file(
    "word/document.xml",
    `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

export function multipartFiles(boundary: string, files: { filename: string; contentType: string; content: Buffer }[]): Buffer {
  return Buffer.concat([
    ...files.flatMap((file) => [
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`),
      file.content,
      Buffer.from("\r\n"),
    ]),
    Buffer.from(`--${boundary}--\r\n`),
  ]);
}

async function meetingWithMaterials(): Promise<{ t: TestApp; cookie: string; meetingId: string; materialIds: string[]; storageDir: string; pdfBytes: Buffer }> {
  const storageDir = await mkdtemp(join(tmpdir(), "warmap-material-preview-"));
  const t = await createTestApp({ materialStorageDir: storageDir });
  const issue = await t.createIssue();
  const cookie = await t.loginCookie();
  const issueId = issue.objectRef.id as string;
  const card = (await t.app.inject({ method: "GET", url: `/api/cards/issues/${issueId}`, headers: { cookie } })).json().cards[0];
  const create = card.actions.find((action: { actionType: string }) => action.actionType === "issue.create_meeting");
  const created = await t.app.inject({
    method: "POST",
    url: "/api/actions/execute",
    headers: { cookie, origin: t.publicOrigin },
    payload: { actionId: create.actionId, input: { title: "渠道投入决策会", scheduledAt: "2026-06-01T10:00:00.000+08:00", leadDriId: "person-fixture-002", ceoParticipantId: "person-fixture-001", participants: ["person-fixture-002"], issueIds: [issueId] } },
  });
  expect(created.statusCode).toBe(200);
  const meetingId = created.json().cards[0].objectRef.id as string;
  const pdfBytes = minimalPdf("Warmap preview fixture");
  const upload = await t.app.inject({
    method: "POST",
    url: `/api/meetings/${meetingId}/materials`,
    headers: { cookie, origin: t.publicOrigin, "content-type": "multipart/form-data; boundary=----warmap-material-boundary" },
    payload: multipartFiles("----warmap-material-boundary", [
      { filename: "brief.pdf", contentType: "application/pdf", content: pdfBytes },
      { filename: "brief.docx", contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", content: await minimalDocx("<w:p><w:r><w:t>渠道投放材料正文</w:t></w:r></w:p>") },
      { filename: "notes.md", contentType: "text/markdown", content: Buffer.from("# 渠道方案\n<script>alert(1)</script>\n") },
    ]),
  });
  expect(upload.statusCode).toBe(200);
  const materialIds = (upload.json().cards[0].payload.materials as { id: string; fileName: string }[]).map((material) => material.id);
  expect(materialIds).toHaveLength(3);
  return { t, cookie, meetingId, materialIds, storageDir, pdfBytes };
}

describe("Meeting Material preview", () => {
  it("previews PDF inline with the original bytes", async () => {
    const { t, cookie, meetingId, materialIds, pdfBytes, storageDir } = await meetingWithMaterials();
    try {
      const res = await t.app.inject({ method: "GET", url: `/api/meetings/${meetingId}/materials/${materialIds[0]}/preview`, headers: { cookie } });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toBe("application/pdf");
      expect(res.headers["content-disposition"]).toBe("inline");
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.rawPayload.equals(pdfBytes)).toBe(true);
    } finally {
      await t.close();
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  it("previews Markdown as inert plain text without a cookie", async () => {
    const { t, cookie, meetingId, materialIds, storageDir } = await meetingWithMaterials();
    try {
      const unauthorized = await t.app.inject({ method: "GET", url: `/api/meetings/${meetingId}/materials/${materialIds[2]}/preview` });
      expect(unauthorized.statusCode).toBe(401);
      const res = await t.app.inject({ method: "GET", url: `/api/meetings/${meetingId}/materials/${materialIds[2]}/preview`, headers: { cookie } });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toBe("text/plain; charset=utf-8");
      expect(res.body).toContain("<script>alert(1)</script>");
    } finally {
      await t.close();
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  it("previews DOCX as sanitized on-demand HTML and persists no HTML in the volume", async () => {
    const { t, cookie, meetingId, materialIds, storageDir } = await meetingWithMaterials();
    try {
      const res = await t.app.inject({ method: "GET", url: `/api/meetings/${meetingId}/materials/${materialIds[1]}/preview`, headers: { cookie } });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toBe("text/html; charset=utf-8");
      expect(res.body).toContain("<p>渠道投放材料正文</p>");
      expect(res.body).not.toMatch(/<script|<img|<style|style=|on\w+=/i);
      const missing = await t.app.inject({ method: "GET", url: `/api/meetings/${meetingId}/materials/${randomUUID()}/preview`, headers: { cookie } });
      expect(missing.statusCode).toBe(404);
      // 不持久化 HTML：volume 只保留 3 份原件
      const stored = (await readdir(storageDir, { recursive: true })).filter((entry) => /[\\/]/.test(entry));
      expect(stored).toHaveLength(3);
      expect(stored.some((entry) => entry.endsWith(".html"))).toBe(false);
    } finally {
      await t.close();
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  it("sanitizes malicious DOCX HTML through the allowlist", async () => {
    const { renderMaterialPreview } = await import("../src/materialPreview.js");
    const malicious = await minimalDocx(
      "<w:p><w:r><w:t>正常段落</w:t></w:r></w:p>" +
        `<w:p><w:r><w:t><![CDATA[<script>alert(1)</script><img src="http://evil/x">]]></w:t></w:r></w:p>` +
        `<w:hyperlink r:id="rId5"><w:r><w:t>链接文字</w:t></w:r></w:hyperlink>`,
    );
    const zip = await JSZip.loadAsync(malicious);
    zip.file(
      "word/_rels/document.xml.rels",
      `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="javascript:alert(1)" TargetMode="External"/></Relationships>`,
    );
    const buffer = await zip.generateAsync({ type: "nodebuffer" });
    const preview = await renderMaterialPreview(buffer, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(preview.contentType).toBe("text/html; charset=utf-8");
    expect(preview.body.toString()).toContain("<p>正常段落</p>");
    expect(preview.body.toString()).not.toMatch(/<script|<img|style=|javascript:/i);
  });
});
