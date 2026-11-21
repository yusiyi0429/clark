import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ComponentProps } from "react";
import type { RoleView } from "@/lib/team/roles";
import { sizeText } from "@/lib/home/attachments";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/me/work/settings/materials" }));

import { MaterialsView } from "./MaterialsPage";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const file = (index: number) => ({ id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`, fileName: `资料${index}.md`, size: 2048 * index, chars: 100, createdAt: "2026-11-18T02:00:00.000Z" });
const role = (name: string, shared: boolean): RoleView => ({
  id: `role-${name}`, name, kind: "worker", dutiesMd: "", practiceMd: "", acceptanceMd: "", tools: [], modelTier: "normal", version: 1,
  family: "general", presetKey: null, presetVersion: null, updatedAt: "2026-11-18T02:00:00.000Z", updatedBy: null, ...(shared ? { shared: true as const } : {}),
});
const props: ComponentProps<typeof MaterialsView> = {
  materials: { note: "我负责报价", noteUpdatedAt: "2026-11-18T02:00:00.000Z", files: [file(1)] },
  roles: [role("写报价", true), role("做排期", false)],
  note: "我负责报价", busy: null, findings: null, failed: null,
  onNote: () => undefined, onSaveNote: () => undefined, onUpload: () => undefined, onRemove: () => undefined, onShare: () => undefined,
};

describe("对外资料页", () => {
  it("三块：说明、文件、技能，没有别的字", () => {
    const html = renderToStaticMarkup(<MaterialsView {...props} />);
    expect([...html.matchAll(/<h2[^>]*>([^<]+)<\/h2>/g)].map((match) => match[1])).toEqual(["说明", "文件", "技能"]);
    expect(html).not.toMatch(/…|\.\.\./);
    expect(html).toMatch(/<textarea[^>]*aria-label="说明"[^>]*maxLength="20000"|<textarea[^>]*maxLength="20000"[^>]*aria-label="说明"/);
  });

  it("文件一行写名字、大小和时间，带删除；没有文件写「还没有文件」；满 20 份上传禁用", () => {
    const html = renderToStaticMarkup(<MaterialsView {...props} />);
    expect(text(html)).toContain(`资料1.md ${sizeText(2048)} · `);
    expect(text(html)).toContain("删除");
    expect(html).toMatch(/<input[^>]*type="file"[^>]*accept="\.md,\.pdf,\.docx"/);
    const upload = (markup: string) => markup.match(/<button[^>]*>上传<\/button>/)?.[0] ?? "";
    expect(upload(html)).not.toBe("");
    expect(upload(html)).not.toMatch(/\sdisabled=""/);

    const empty = renderToStaticMarkup(<MaterialsView {...props} materials={{ ...props.materials, files: [] }} />);
    expect(text(empty)).toContain("还没有文件");
    expect(text(empty)).not.toContain("删除");

    const full = renderToStaticMarkup(<MaterialsView {...props} materials={{ ...props.materials, files: Array.from({ length: 20 }, (_, index) => file(index + 1)) }} />);
    expect(upload(full)).toMatch(/\sdisabled=""/);
  });

  it("技能一行一个开关，标了同事可用的是开", () => {
    const html = renderToStaticMarkup(<MaterialsView {...props} />);
    expect([...html.matchAll(/role="switch" aria-checked="(true|false)"/g)].map((match) => match[1])).toEqual(["true", "false"]);
    expect(text(html)).toContain("写报价");
    expect(text(html)).toContain("做排期");
    expect(text(renderToStaticMarkup(<MaterialsView {...props} roles={[]} />))).toContain("还没有技能");
  });

  it("每份资料下面写谁、哪天；对不上说明、文件、技能的收在『其他』", () => {
    const reads = [
      { itemId: "note", title: "说明", reader: "测试乙", readOn: "2026-11-06" },
      { itemId: `file:${file(1).id}`, title: "资料1.md", reader: "测试丁", readOn: "2026-11-05" },
      { itemId: "skill:role-做排期", title: "做排期", reader: "测试甲", readOn: "2026-11-04" },
      { itemId: "task:t1", title: "部署天枢", reader: "测试乙", readOn: "2026-11-07" },
    ];
    const html = renderToStaticMarkup(<MaterialsView {...props} materials={{ ...props.materials, reads }} />);
    expect(html).toContain("测试乙 · 11/6");
    expect(html).toMatch(/其他[\s\S]*部署天枢 · 测试乙 · 11\/7/);
    expect(html.indexOf("测试乙 · 11/6")).toBeLessThan(html.indexOf(">文件<"));
    expect(html.indexOf("测试丁 · 11/5")).toBeGreaterThan(html.indexOf("资料1.md"));
    expect(html.indexOf("测试丁 · 11/5")).toBeLessThan(html.indexOf(">技能<"));
    expect(html.indexOf("测试甲 · 11/4")).toBeGreaterThan(html.indexOf("做排期"));
    expect(html.indexOf("测试甲 · 11/4")).toBeLessThan(html.indexOf(">其他<"));
    expect(renderToStaticMarkup(<MaterialsView {...props} materials={{ ...props.materials, reads: [] }} />)).not.toContain("其他");
  });

  it("像密钥的值：在出事的地方逐条写第几行", () => {
    const typed = "报价规则\nkey sk-abc123456";
    const html = renderToStaticMarkup(<MaterialsView {...props} note={typed}
      findings={{ at: "note", items: [{ where: "说明", line: 2, sample: "sk-abc••••" }] }} />);
    expect(html).toContain("第 2 行像密钥（sk-abc••••）");
    expect(text(html)).not.toContain("说明 第 2 行");
    expect(html).toContain("key sk-abc123456");
    // 写在说明下面，不在文件、技能那两块里。
    expect(html.indexOf("第 2 行像密钥")).toBeLessThan(html.indexOf(">文件<"));

    const onFile = renderToStaticMarkup(<MaterialsView {...props} findings={{ at: "file", items: [{ where: "a.md", line: 3, sample: "AKIA12••••" }] }} />);
    expect(text(onFile)).toContain("a.md 第 3 行像密钥（AKIA12••••）");
    expect(onFile.indexOf("第 3 行像密钥")).toBeGreaterThan(onFile.indexOf(">文件<"));
    expect(onFile.indexOf("第 3 行像密钥")).toBeLessThan(onFile.indexOf(">技能<"));

    const onRole = renderToStaticMarkup(<MaterialsView {...props} findings={{ at: "role-做排期", items: [{ where: "技能 · 做法", line: 4, sample: "ghp_ab••••" }] }} />);
    expect(text(onRole)).toContain("技能 · 做法 第 4 行像密钥（ghp_ab••••）");
    expect(onRole.indexOf("第 4 行像密钥")).toBeGreaterThan(onRole.indexOf("做排期"));
  });
});
