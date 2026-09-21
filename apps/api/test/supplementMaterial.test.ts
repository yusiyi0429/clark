import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTestApp, type TestApp } from "./helpers.js";
import { minimalPdf, multipartFiles } from "./materialPreview.test.js";
import { readdir } from "node:fs/promises";

const REQUEST_ID = "req-1";
const SUPPLEMENT_REQUEST = JSON.stringify([
  { id: REQUEST_ID, entryId: null, targetDriId: "person-fixture-002", text: "请补充二期触发条件阈值草案", exportStatus: "recorded", exportRef: null, error: null, createdAt: "2026-09-20T00:00:00.000Z" },
]);

function supplementBody(boundary: string, requestId: string | null, filename: string, contentType: string, content: Buffer): Buffer {
  const parts = [
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="requestId"\r\n\r\n${requestId ?? ""}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`),
    content,
    Buffer.from("\r\n"),
    Buffer.from(`--${boundary}--\r\n`),
  ];
  return Buffer.concat(parts);
}

async function scheduledMeeting(): Promise<{ t: TestApp; cookie: string; meetingId: string; storageDir: string }> {
  const storageDir = await mkdtemp(join(tmpdir(), "warmap-supplement-"));
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
  return { t, cookie, meetingId: created.json().cards[0].objectRef.id as string, storageDir };
}

async function postSupplement(t: TestApp, cookie: string, meetingId: string, requestId: string | null, content: Buffer, filename = "阈值草案.md", contentType = "text/markdown") {
  return t.app.inject({
    method: "POST",
    url: `/api/meetings/${meetingId}/materials/supplement`,
    headers: { cookie, origin: t.publicOrigin, "content-type": "multipart/form-data; boundary=----supp-boundary" },
    payload: supplementBody("----supp-boundary", requestId, filename, contentType, content),
  });
}

describe("补充材料文件组（kind=supplement）", () => {
  it("scheduled+ready 也可追加：preflight 不被重置、version+1、文件落盘可下载", async () => {
    const { t, cookie, meetingId, storageDir } = await scheduledMeeting();
    try {
      await t.sql("UPDATE meetings SET draft = jsonb_set(draft, '{supplementRequests}', $2::jsonb) WHERE id = $1", [meetingId, SUPPLEMENT_REQUEST]);
      await t.sql("UPDATE meetings SET preflight = jsonb_set(preflight, '{status}', '\"ready\"') WHERE id = $1", [meetingId]);
      const before = (await t.sql("SELECT version, preflight FROM meetings WHERE id = $1", [meetingId]))[0];

      const res = await postSupplement(t, cookie, meetingId, REQUEST_ID, Buffer.from("阈值：时效 ≤ 3 天\n"));
      expect(res.statusCode).toBe(200);
      const card = res.json().cards[0];
      const supplements = (await t.sql("SELECT materials FROM meetings WHERE id = $1", [meetingId]))[0].materials.filter((m: { kind?: string }) => m.kind === "supplement");
      expect(supplements).toHaveLength(1);
      expect(supplements[0]).toMatchObject({ supplementFor: REQUEST_ID, kind: "supplement", providedBy: null });
      expect(card.version).toBe(before.version + 1);
      // 不自动重置/不触发预审
      const after = (await t.sql("SELECT version, preflight FROM meetings WHERE id = $1", [meetingId]))[0];
      expect(after.preflight.status).toBe("ready");
      // 原件在 API-only volume 且可经鉴权端点下载
      const stored = await readFile(join(storageDir, supplements[0].storageKey));
      expect(stored.length).toBeGreaterThan(0);
      const download = await t.app.inject({ method: "GET", url: `/api/meetings/${meetingId}/materials/${supplements[0].id}/download`, headers: { cookie } });
      expect(download.statusCode).toBe(200);
    } finally {
      await t.close();
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  it("requestId 未记录 → 404；held → 409；未登录 → 401", async () => {
    const { t, cookie, meetingId } = await scheduledMeeting();
    try {
      await t.sql("UPDATE meetings SET draft = jsonb_set(draft, '{supplementRequests}', $2::jsonb) WHERE id = $1", [meetingId, SUPPLEMENT_REQUEST]);
      const unknown = await postSupplement(t, cookie, meetingId, "req-missing", Buffer.from("内容\n"));
      expect(unknown.statusCode).toBe(404);
      expect(unknown.json()).toMatchObject({ code: "SUPPLEMENT_REQUEST_NOT_FOUND" });

      await t.sql("UPDATE meetings SET status = 'held' WHERE id = $1", [meetingId]);
      const held = await postSupplement(t, cookie, meetingId, REQUEST_ID, Buffer.from("内容\n"));
      expect(held.statusCode).toBe(409);
      expect(held.json()).toMatchObject({ code: "MEETING_MATERIALS_READ_ONLY" });

      const unauth = await t.app.inject({
        method: "POST",
        url: `/api/meetings/${meetingId}/materials/supplement`,
        headers: { "content-type": "multipart/form-data; boundary=----supp-boundary" },
        payload: supplementBody("----supp-boundary", REQUEST_ID, "阈值草案.md", "text/markdown", Buffer.from("内容\n")),
      });
      expect(unauth.statusCode).toBe(401);
    } finally {
      await t.close();
    }
  });

  it("同 sha256+request 重复提交幂等：不重复落盘、不升版本；坏文件整次拒绝且无残留", async () => {
    const { t, cookie, meetingId, storageDir } = await scheduledMeeting();
    try {
      await t.sql("UPDATE meetings SET draft = jsonb_set(draft, '{supplementRequests}', $2::jsonb) WHERE id = $1", [meetingId, SUPPLEMENT_REQUEST]);
      const content = Buffer.from("阈值：时效 ≤ 3 天\n");
      const first = await postSupplement(t, cookie, meetingId, REQUEST_ID, content);
      expect(first.statusCode).toBe(200);
      const version = first.json().cards[0].version;

      const duplicate = await postSupplement(t, cookie, meetingId, REQUEST_ID, content);
      expect(duplicate.statusCode).toBe(200);
      expect(duplicate.json().cards[0].version).toBe(version);
      expect(duplicate.json().cards[0].payload.materials).toHaveLength(1);

      // 坏 PDF（无文字层）→ 整次拒绝：materials 不变、volume 无残留文件
      const bad = await postSupplement(t, cookie, meetingId, REQUEST_ID, minimalPdf(""), "空扫描.pdf", "application/pdf");
      expect(bad.statusCode).toBe(400);
      expect(bad.json()).toMatchObject({ code: "MATERIAL_NO_TEXT" });
      const row = (await t.sql("SELECT materials FROM meetings WHERE id = $1", [meetingId]))[0];
      expect(row.materials).toHaveLength(1);
      expect(await readFile(join(storageDir, row.materials[0].storageKey))).toBeTruthy();
    } finally {
      await t.close();
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  it("整批替换清空补充材料并重置 preflight；总数上限 10 份生效", async () => {
    const { t, cookie, meetingId, storageDir } = await scheduledMeeting();
    try {
      await t.sql("UPDATE meetings SET draft = jsonb_set(draft, '{supplementRequests}', $2::jsonb) WHERE id = $1", [meetingId, SUPPLEMENT_REQUEST]);
      const first = await postSupplement(t, cookie, meetingId, REQUEST_ID, Buffer.from("补充一\n"));
      expect(first.statusCode).toBe(200);

      // 上限：materials 已 1 份，塞满到 10 份后追加被 409
      const ten = Array.from({ length: 10 }, (_, i) => ({ id: `filler-${i}`, fileName: `f-${i}.md`, mimeType: "text/markdown", sizeBytes: 10, receivedBy: "p", providedBy: null, uploadedAt: "2026-09-20T00:00:00.000Z", storageKey: `${meetingId}/filler-${i}`, sha256: `${i}`.repeat(64), extractedText: "占位" }));
      await t.sql("UPDATE meetings SET materials = $2::jsonb WHERE id = $1", [meetingId, JSON.stringify(ten)]);
      const capped = await postSupplement(t, cookie, meetingId, REQUEST_ID, Buffer.from("超出上限\n"));
      expect(capped.statusCode).toBe(409);
      expect(capped.json()).toMatchObject({ code: "MATERIAL_BATCH_TOO_LARGE" });

      // 恢复为 1 份补充材料 + ready 预审；真实流程先「返回编辑材料」再整批替换
      const storedMaterials = (await t.sql("SELECT materials FROM meetings WHERE id = $1", [meetingId]))[0].materials;
      await t.sql("UPDATE meetings SET materials = $2::jsonb, preflight = jsonb_set(preflight, '{status}', '\"ready\"') WHERE id = $1", [meetingId, JSON.stringify(storedMaterials)]);
      const cardBefore = (await t.app.inject({ method: "GET", url: `/api/cards/meetings/${meetingId}`, headers: { cookie } })).json().cards[0];
      const edit = cardBefore.actions.find((action: { actionType: string }) => action.actionType === "meeting.edit_materials");
      expect(edit).toBeTruthy();
      const edited = await t.app.inject({ method: "POST", url: "/api/actions/execute", headers: { cookie, origin: t.publicOrigin }, payload: { actionId: edit.actionId, input: {} } });
      expect(edited.statusCode).toBe(200);
      expect(edited.json().cards[0].payload.draft).toMatchObject({ checkedEntryIds: [], editsByEntryId: {} });
      const boundary = "----primary-boundary";
      const primary = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="主材料.md"\r\nContent-Type: text/markdown\r\n\r\n主材料正文\r\n--${boundary}--\r\n`),
      ]);
      const replace = await t.app.inject({
        method: "POST",
        url: `/api/meetings/${meetingId}/materials`,
        headers: { cookie, origin: t.publicOrigin, "content-type": `multipart/form-data; boundary=${boundary}` },
        payload: primary,
      });
      expect(replace.statusCode).toBe(200);
      const card = replace.json().cards[0];
      expect(card.payload.materials).toHaveLength(1);
      expect(card.payload.materials[0].kind ?? "primary").toBe("primary");
      expect(card.payload.preflight.status).toBe("pending");
      expect(card.payload.draft).toMatchObject({ checkedEntryIds: [], editsByEntryId: {} });
      expect(card.payload.materials[0]).not.toHaveProperty("storageKey");
      expect(card.payload.materials[0]).not.toHaveProperty("sha256");
      expect(card.payload.materials[0]).not.toHaveProperty("extractedText");
    } finally {
      await t.close();
      await rm(storageDir, { recursive: true, force: true });
    }
  });
  it("multipart 上限映射：补充材料多文件 → 400 INVALID_MATERIAL；超大小 → 413；主材料超批 → 400；全部零 DB/volume 残留", async () => {
    const { t, cookie, meetingId, storageDir } = await scheduledMeeting();
    try {
      await t.sql("UPDATE meetings SET draft = jsonb_set(draft, '{supplementRequests}', $2::jsonb) WHERE id = $1", [meetingId, SUPPLEMENT_REQUEST]);

      // 恰好一份语义：两个文件 → FST_FILES_LIMIT → 400 INVALID_MATERIAL（非 500）
      const boundary = "----supp-multi";
      const multi = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="requestId"\r\n\r\n${REQUEST_ID}\r\n`),
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="a.md"\r\nContent-Type: text/markdown\r\n\r\n甲\r\n`),
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="b.md"\r\nContent-Type: text/markdown\r\n\r\n乙\r\n`),
        Buffer.from(`--${boundary}--\r\n`),
      ]);
      const multiRes = await t.app.inject({
        method: "POST",
        url: `/api/meetings/${meetingId}/materials/supplement`,
        headers: { cookie, origin: t.publicOrigin, "content-type": `multipart/form-data; boundary=${boundary}` },
        payload: multi,
      });
      expect(multiRes.statusCode).toBe(400);
      expect(multiRes.json().code).toBe("INVALID_MATERIAL");

      // 超大小：>20 MiB → FST_REQ_FILE_TOO_LARGE → 413 MATERIAL_FILE_TOO_LARGE
      const oversized = await postSupplement(t, cookie, meetingId, REQUEST_ID, Buffer.alloc(20 * 1024 * 1024 + 1, 0x61), "超大.md");
      expect(oversized.statusCode).toBe(413);
      expect(oversized.json()).toMatchObject({ code: "MATERIAL_FILE_TOO_LARGE" });

      // 主材料整批上限：11 份 → FST_FILES_LIMIT → 413 MATERIAL_BATCH_TOO_LARGE
      const batch = multipartFiles("----primary-multi", Array.from({ length: 11 }, (_, i) => ({
        filename: `f-${i}.md`, contentType: "text/markdown", content: Buffer.from(`第 ${i} 份\n`),
      })));
      const batchRes = await t.app.inject({
        method: "POST",
        url: `/api/meetings/${meetingId}/materials`,
        headers: { cookie, origin: t.publicOrigin, "content-type": "multipart/form-data; boundary=----primary-multi" },
        payload: batch,
      });
      expect(batchRes.statusCode).toBe(400);
      expect(batchRes.json()).toMatchObject({ code: "MATERIAL_BATCH_TOO_LARGE" });
      // 主材料单文件超 20 MiB：FST_REQ_FILE_TOO_LARGE → 413（映射不变）
      const primaryOversized = await t.app.inject({
        method: "POST",
        url: `/api/meetings/${meetingId}/materials`,
        headers: { cookie, origin: t.publicOrigin, "content-type": "multipart/form-data; boundary=----primary-multi" },
        payload: multipartFiles("----primary-multi", [{ filename: "big.md", contentType: "text/markdown", content: Buffer.alloc(20 * 1024 * 1024 + 1, 0x61) }]),
      });
      expect(primaryOversized.statusCode).toBe(413);
      expect(primaryOversized.json()).toMatchObject({ code: "MATERIAL_BATCH_TOO_LARGE" });

      // 零 DB/volume 残留
      const row = (await t.sql("SELECT materials FROM meetings WHERE id = $1", [meetingId]))[0];
      expect(row.materials).toHaveLength(0);
      expect(await readdir(storageDir)).toHaveLength(0);
    } finally {
      await t.close();
      await rm(storageDir, { recursive: true, force: true });
    }
  });
});
