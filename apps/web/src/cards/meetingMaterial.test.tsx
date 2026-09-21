import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MeetingCard, MaterialReaderModal, materialMeta, materialStateLine, previewKind, splitMaterials, buildSupplementForm, truncateText } from "./MeetingCard";
import { meetingCard } from "./meetingWorkspace.test";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined, push: () => undefined }) }));

const noop = () => undefined;
const dialogRef = { current: null };

const materials = [
  { id: "m-1", fileName: "东南亚渠道预算申请（修订版）.pdf", mimeType: "application/pdf", sizeBytes: 12288, pageCount: 24, receivedBy: "p2", providedBy: "林晓", uploadedAt: "2026-09-20T01:00:00.000Z", storageKey: "meet/m-1", sha256: "a".repeat(64), extractedText: "预算" },
  { id: "m-2", fileName: "二期触发条件阈值草案.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", sizeBytes: 2048, receivedBy: "p2", providedBy: null, uploadedAt: "2026-09-21T01:00:00.000Z", storageKey: "meet/m-2", sha256: "b".repeat(64), extractedText: "阈值" },
  { id: "m-3", fileName: "履约反馈.md", mimeType: "text/markdown", sizeBytes: 512, receivedBy: "p2", providedBy: null, uploadedAt: "2026-09-22T01:00:00.000Z", storageKey: "meet/m-3", sha256: "c".repeat(64), extractedText: "反馈" },
];

const readerProps = {
  dialogRef,
  meetingId: "meet-1",
  materials,
  selectedId: "m-1",
  preview: { state: "idle" } as const,
  stateLine: "会前预审 · 已就绪 · 材料只读 · 3 份 · 最近更新 2026-09-22",
  transcriptMeta: null,
  note: "材料集当前只读；替换需先「返回编辑材料」，替换后旧预审结论失效。",
  onClose: noop,
  onSelect: noop,
};

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

  it("materialStateLine 按会议状态给出 Header 状态行", () => {
    expect(materialStateLine("scheduled", "ready", materials)).toBe("会前预审 · 已就绪 · 材料只读 · 3 份 · 最近更新 2026-09-22");
    expect(materialStateLine("scheduled", "revise", materials)).toBe("会前预审 · 修改后提交 · 材料可替换 · 3 份 · 最近更新 2026-09-22");
    expect(materialStateLine("held", undefined, [materials[0]])).toBe("Outcome 复核 · 材料已归档只读 · 1 份 · 最近更新 2026-09-20");
    expect(materialStateLine("reviewed", undefined, [])).toBe("Outcome 复核 · 材料已归档只读 · 0 份");
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

  it("reader 补充材料组含请求出处「回应「…」」，主材料组不受影响，仍无编辑控件", () => {
    const html = renderToStaticMarkup(
      <MaterialReaderModal {...readerProps} materials={supplementMaterials} supplementRequests={supplementRequests} />,
    );
    expect(html).toContain("补充材料");
    expect(html).toContain("2 份");
    expect(html).toContain("会前材料");
    expect(html).toContain("回应「请补充二期触发条件的阈值依据与量化口径」");
    expect(html).toContain("回应「补充履约反馈」");
    expect(html).toContain('href="/api/meetings/meet-1/materials/m-2/download"');
    // reader 仍严格只读
    expect(html).not.toContain('type="file"');
    expect(html).not.toContain("返回编辑材料</button>");
    // 无补充材料时不渲染补充组
    const without = renderToStaticMarkup(<MaterialReaderModal {...readerProps} />);
    expect(without).not.toContain("补充材料");
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

describe("原始材料只读弹窗", () => {
  it("列出类型徽标、元数据与下载链接，预审/Outcome 均无编辑控件", () => {
    const html = renderToStaticMarkup(<MaterialReaderModal {...readerProps} />);
    expect(html).toContain("会议原始材料");
    expect(html).toContain("只读依据 · 不参与判断与抽取");
    expect(html).toContain("PDF</span>");
    expect(html).toContain("DOCX</span>");
    expect(html).toContain("MD</span>");
    expect(html).toContain("24 页 · 林晓 · 2026-09-20 · 12 KB");
    expect(html).toContain('href="/api/meetings/meet-1/materials/m-1/download"');
    expect(html).toContain('aria-label="下载 东南亚渠道预算申请（修订版）.pdf"');
    expect(html).toContain('aria-current="true"');
    expect(html).toContain("材料集当前只读；替换需先「返回编辑材料」");
    // 折叠分组（tp8t9）：会前材料组带计数；scheduled 无逐字稿组
    expect(html).toContain("会前材料");
    expect(html).toContain("3 份");
    expect(html).not.toContain("会议逐字稿");
    // reader 内不允许出现任何编辑入口
    expect(html).not.toContain("返回编辑材料</button>");
    expect(html).not.toContain('type="file"');
  });

  it("Outcome 阅读器包含逐字稿只读条目（rJlIZ），且无下载/选中入口", () => {
    const html = renderToStaticMarkup(
      <MaterialReaderModal
        {...readerProps}
        stateLine="Outcome 复核 · 材料已归档只读 · 3 份 · 最近更新 2026-09-22"
        transcriptMeta={{ count: 12, schemaVersion: "warmap-transcript.v1" }}
        note="Outcome 只以 Transcript 为输入；材料仅供查看。"
      />,
    );
    expect(html).toContain("会议逐字稿");
    expect(html).toContain("12 条发言 · 会后采集 · 仅页面内查看，无独立下载");
    expect(html).toContain("warmap-transcript.v1");
    // 逐字稿条目是静态信息：不可选中、无下载链接
    const transcriptSection = html.split("会议逐字稿")[1] ?? "";
    expect(transcriptSection).not.toContain("aria-current");
    expect(transcriptSection).not.toContain("/download");
  });

  it("预览体按 kind 渲染：PDF iframe、DOCX 沙箱 iframe、MD 纯文本、失败提示", () => {
    const pdf = renderToStaticMarkup(<MaterialReaderModal {...readerProps} preview={{ state: "ready", kind: "pdf", url: "blob:audit" }} />);
    expect(pdf).toContain('src="blob:audit"');
    expect(pdf).not.toContain("sandbox");
    const docx = renderToStaticMarkup(
      <MaterialReaderModal {...readerProps} selectedId="m-2" preview={{ state: "ready", kind: "html", content: "<p>阈值草案</p>" }} />,
    );
    expect(docx).toContain('sandbox=""');
    expect(docx).toContain("&lt;p&gt;阈值草案&lt;/p&gt;");
    const md = renderToStaticMarkup(
      <MaterialReaderModal {...readerProps} selectedId="m-3" preview={{ state: "ready", kind: "text", content: "# 反馈" }} />,
    );
    expect(md).toContain("# 反馈");
    const failed = renderToStaticMarkup(
      <MaterialReaderModal {...readerProps} preview={{ state: "error", error: "材料预览加载失败" }} />,
    );
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("材料预览加载失败");
  });
});

describe("MeetingCard 原始材料入口", () => {
  it("scheduled 会前材料区提供查看原始材料入口；空材料集不提供", () => {
    const withMaterials = renderToStaticMarkup(
      <MeetingCard card={meetingCard({ materials })} collection={[]} onCard={noop} onNavigate={noop} />,
    );
    expect(withMaterials).toContain("查看原始材料");
    const empty = renderToStaticMarkup(
      <MeetingCard card={meetingCard({})} collection={[]} onCard={noop} onNavigate={noop} />,
    );
    expect(empty).not.toContain("查看原始材料");
  });

  it("held Outcome 复核同样提供只读查看入口", () => {
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
    expect(held).toContain("查看原始材料");
    expect(held).toContain("材料仅供查看；Outcome 只以 Transcript 为输入");
  });
});
