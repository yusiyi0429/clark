import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MeetingCard, MaterialPane, materialMeta, materialTab, previewKind, splitMaterials, buildSupplementForm, truncateText } from "./MeetingCard";
import { meetingCard } from "./meetingWorkspace.test";

// 会议页读取外壳的首页集合（关联议题的位置名）；单测里给一个空集合。
vi.mock("@/components/shell/WorkspaceContext", () => ({ useWorkspace: () => ({ homeCards: [], closing: false }) }));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined, push: () => undefined }) }));

const noop = () => undefined;

const materials = [
  { id: "m-1", fileName: "东南亚渠道预算申请（修订版）.pdf", mimeType: "application/pdf", sizeBytes: 12288, pageCount: 24, receivedBy: "p2", providedBy: "林晓", uploadedAt: "2026-09-20T01:00:00.000Z", storageKey: "meet/m-1", sha256: "a".repeat(64), extractedText: "预算" },
  { id: "m-2", fileName: "二期触发条件阈值草案.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", sizeBytes: 2048, receivedBy: "p2", providedBy: null, uploadedAt: "2026-09-21T01:00:00.000Z", storageKey: "meet/m-2", sha256: "b".repeat(64), extractedText: "阈值" },
  { id: "m-3", fileName: "履约反馈.md", mimeType: "text/markdown", sizeBytes: 512, receivedBy: "p2", providedBy: null, uploadedAt: "2026-09-22T01:00:00.000Z", storageKey: "meet/m-3", sha256: "c".repeat(64), extractedText: "反馈" },
];

describe("Meeting 原始材料预览工具", () => {
  it("previewKind 按 preview endpoint 的内容类型分流", () => {
    expect(previewKind("application/pdf")).toBe("pdf");
    expect(previewKind("text/html; charset=utf-8")).toBe("html");
    expect(previewKind("text/plain; charset=utf-8")).toBe("text");
    expect(previewKind("application/octet-stream")).toBeNull();
  });

  it("materialMeta 只拼接存在的元数据字段", () => {
    expect(materialMeta(materials[0])).toBe("24 页 · 林晓 · 2026-09-20 · 12 KB");
    expect(materialMeta(materials[1])).toBe("2026-09-21 · 2 KB");
    expect(materialMeta({ ...materials[2], sizeBytes: 512, uploadedAt: "" })).toBe("1 KB");
  });
});

describe("Meeting 补充材料文件组", () => {
  const supplementMaterials = [
    materials[0],
    { ...materials[1], kind: "supplement" as const, supplementFor: "sr-1" },
    { ...materials[2], kind: "supplement" as const, supplementFor: "sr-2" },
  ];
  const supplementRequests = [
    { id: "sr-1", text: "请补充二期触发条件的阈值依据与量化口径", targetDriId: "p1", exportStatus: "pending_export", createdAt: "2026-09-20T00:00:00.000Z" },
    { id: "sr-2", text: "补充履约反馈", targetDriId: "p1", exportStatus: "delivered", createdAt: "2026-09-21T00:00:00.000Z" },
  ];

  it("splitMaterials：缺省 kind = primary，supplement 单独分组（旧数据免迁移）", () => {
    expect(splitMaterials(supplementMaterials)).toEqual({
      primary: [materials[0]],
      supplements: [supplementMaterials[1], supplementMaterials[2]],
    });
    expect(splitMaterials(materials).supplements).toEqual([]);
  });

  it("补充材料的页签前面写「补充」，预览底下写出处「回应「…」」，仍无编辑控件", () => {
    expect(materialTab(supplementMaterials[1]).label).toBe("补充 · 二期触发条件阈值草案");
    expect(materialTab(materials[0]).label).toBe("东南亚渠道预算申请（修订版）");
    const html = renderToStaticMarkup(
      <MaterialPane meetingId="meet-1" material={supplementMaterials[1]} preview={{ state: "idle" }} provenance={` · 回应「${supplementRequests[0].text}」`} />,
    );
    expect(html).toContain("回应「请补充二期触发条件的阈值依据与量化口径」");
    expect(html).toContain('href="/api/meetings/meet-1/materials/m-2/download"');
    expect(html).not.toContain('type="file"');
  });

  it("buildSupplementForm 按 documented contract 携带 files + requestId", () => {
    const form = buildSupplementForm("sr-1", new File(["草稿"], "草案.docx", { type: "text/markdown" }));
    expect(form.get("requestId")).toBe("sr-1");
    expect((form.get("files") as File).name).toBe("草案.docx");
    expect(truncateText("请补充二期触发条件的阈值依据与量化口径", 18)).toBe("请补充二期触发条件的阈值依据与量化口…");
  });

  it("scheduled：每条已记录请求下提供单文件上传入口；held/reviewed 无任何上传入口", () => {
    const baseDraft = (meetingCard({}).payload as { draft: object }).draft;
    const scheduled = renderToStaticMarkup(
      <MeetingCard card={meetingCard({ draft: { ...baseDraft, supplementRequests } })} collection={[]} onCard={noop} onNavigate={noop} />,
    );
    expect(scheduled).toContain('aria-label="为请求上传补充材料：请补充二期触发条件的阈值依据与量化口径"');
    expect(scheduled).toContain('aria-label="为请求上传补充材料：补充履约反馈"');

    const held = renderToStaticMarkup(
      <MeetingCard
        card={meetingCard({
          status: "held",
          draft: { ...baseDraft, supplementRequests },
          materials,
          transcript: { schemaVersion: "warmap-transcript.v1", meetingId: "1", importedAt: "2026-09-20T02:00:00.000Z", turns: [] },
        })}
        collection={[]}
        onCard={noop} onNavigate={noop}
      />,
    );
    expect(held).not.toContain("为请求上传补充材料");
    expect(held).not.toContain("补充材料被拒绝");
  });
});

describe("材料页签里的只读预览", () => {
  it("写出类型徽标、元数据与下载链接，没有任何编辑入口", () => {
    const html = renderToStaticMarkup(<MaterialPane meetingId="meet-1" material={materials[0]} preview={{ state: "idle" }} />);
    expect(html).toContain("PDF</span>");
    expect(html).toContain("24 页 · 林晓 · 2026-09-20 · 12 KB");
    expect(html).toContain('href="/api/meetings/meet-1/materials/m-1/download"');
    expect(html).toContain('aria-label="下载 东南亚渠道预算申请（修订版）.pdf"');
    expect(html).toContain("预览加载中");
    expect(html).not.toContain('type="file"');
  });

  it("预览体按 kind 渲染：PDF iframe、DOCX 沙箱 iframe、MD 纯文本、失败提示", () => {
    const pane = (material: (typeof materials)[number], preview: Parameters<typeof MaterialPane>[0]["preview"]) =>
      renderToStaticMarkup(<MaterialPane meetingId="meet-1" material={material} preview={preview} />);
    const pdf = pane(materials[0], { state: "ready", kind: "pdf", url: "blob:audit" });
    expect(pdf).toContain('src="blob:audit"');
    expect(pdf).not.toContain("sandbox");
    const docx = pane(materials[1], { state: "ready", kind: "html", content: "<p>阈值草案</p>" });
    expect(docx).toContain('sandbox=""');
    expect(docx).toContain("&lt;p&gt;阈值草案&lt;/p&gt;");
    expect(pane(materials[2], { state: "ready", kind: "text", content: "# 反馈" })).toContain("# 反馈");
    const failed = pane(materials[0], { state: "error", error: "材料预览加载失败" });
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("材料预览加载失败");
  });
});

describe("MeetingCard 材料", () => {
  it("下拉单里每份会前材料的名字：短名去扩展名，完整名给读屏", () => {
    expect(materialTab(materials[0])).toEqual({ id: "m-1", label: "东南亚渠道预算申请（修订版）", title: "会议材料：东南亚渠道预算申请（修订版）.pdf" });
    expect(materialTab(materials[2]).label).toBe("履约反馈");
    const html = renderToStaticMarkup(<MeetingCard card={meetingCard({ materials })} collection={[]} onCard={noop} onNavigate={noop} />);
    expect(html).toContain("data-header-tools");
    expect(html).toContain("AI 预审");
  });

  it("held 会后默认打开会议记录", () => {
    const held = renderToStaticMarkup(
      <MeetingCard
        card={meetingCard({
          status: "held",
          materials,
          transcript: { schemaVersion: "warmap-transcript.v1", meetingId: "1", importedAt: "2026-09-20T02:00:00.000Z", turns: [] },
        })}
        collection={[]}
        onCard={noop}
        onNavigate={noop}
      />,
    );
    expect(held).toContain('aria-label="会议记录：妙记或逐字稿与会后复核"');
    expect(held).toContain("会后事项从逐字稿整理");
    expect(held).not.toContain("Transcript");
  });
});
