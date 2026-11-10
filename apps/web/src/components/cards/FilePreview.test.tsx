import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { SessionEntry } from "@/lib/local/sessionView";
import { FilePreview, PREVIEW_IMAGE_MAX, PREVIEW_TEXT_MAX, cloudOutputFile, previewKind } from "./FilePreview";
import { SessionTranscript } from "./SessionTranscript";

const at = "2026-11-10T01:00:00Z";
const transcript = (entries: SessionEntry[], onArtifact?: (fileName: string) => (() => void) | null) =>
  renderToStaticMarkup(<SessionTranscript entries={entries} agentName="Claude Code" canAct onDecide={vi.fn()} live={false} onArtifact={onArtifact} />);

describe("子会话的回答按 Markdown 显示（41 条）", () => {
  it("粗体、列表、表格、代码排出来；链接新开一页；回答里的 HTML 当文字，不执行", () => {
    const html = transcript([{ kind: "assistant", seq: 1, at, text: [
      "## 结论", "", "**改好了**，见 `a.ts`。", "", "- 第一条", "- 第二条", "", "| 文件 | 行 |", "| --- | --- |", "| a.ts | 12 |", "",
      "```ts", "const a = 1;", "```", "", "[说明](https://example.com/doc)", "", "<script>alert(1)</script><b onclick=\"x()\">点我</b>",
    ].join("\n") }]);
    expect(html).toContain("<h2>结论</h2>");
    expect(html).toContain("<strong>改好了</strong>");
    expect(html).toContain("<code>a.ts</code>");
    expect(html).toMatch(/<ul>\s*<li>第一条<\/li>/);
    expect(html).toMatch(/<table>[\s\S]*<th>文件<\/th>[\s\S]*<td>a\.ts<\/td>/);
    expect(html).toMatch(/<pre><code class="language-ts">const a = 1;/);
    expect(html).toContain('<a href="https://example.com/doc" target="_blank" rel="noopener noreferrer">说明</a>');
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<b onclick");
    expect(html).toContain("&lt;script&gt;alert(1)");
  });

  it("本人说的话照原样，不按 Markdown 排", () => {
    const html = transcript([{ kind: "user", seq: 1, at, text: "**别加粗**" }]);
    expect(html).toContain("**别加粗**");
    expect(html).not.toContain("<strong>");
  });

  it("「交出 文件名」：对得上交出的产出时文件名能点，对不上照旧是字", () => {
    const entries: SessionEntry[] = [{ kind: "artifact", seq: 1, at, title: "交回说明", fileName: "交回说明.md" }];
    expect(transcript(entries, () => vi.fn())).toMatch(/交出 <button[^>]*data-testid="artifact-open"[^>]*>交回说明\.md<\/button>/);
    expect(transcript(entries, () => null)).not.toContain("artifact-open");
    expect(transcript(entries)).not.toContain("artifact-open");
  });
});

describe("右边看文件（41 条）", () => {
  it("按扩展名认，认不出看类型：Markdown、图片、文本和代码；HTML 归文本；别的类型和超过上限的只给「打开」", () => {
    expect(previewKind("交回说明.md", null)).toBe("markdown");
    expect(previewKind("notes", "text/markdown; charset=utf-8")).toBe("markdown");
    expect(previewKind("shot.PNG", "application/octet-stream")).toBe("image");
    expect(previewKind("a.tsx", null)).toBe("text");
    expect(previewKind("data", "application/json")).toBe("text");
    expect(previewKind("index.html", "text/html")).toBe("text");
    expect(previewKind("报告.pdf", "application/pdf")).toBe("other");
    expect(previewKind("包.zip", null)).toBe("other");
    expect(previewKind("big.log", null, PREVIEW_TEXT_MAX + 1)).toBe("other");
    expect(previewKind("big.png", null, PREVIEW_TEXT_MAX + 1)).toBe("image");
    expect(previewKind("huge.png", null, PREVIEW_IMAGE_MAX + 1)).toBe("other");
  });

  it("交出的产出读云端那份：文件名、大小、类型照产出的，地址是本人的产出接口", () => {
    const file = cloudOutputFile({ id: "o/1", title: "交回说明", fileName: "交回说明.md", mimeType: "text/markdown", sizeBytes: 2048 });
    expect(file).toMatchObject({ key: "output:o/1", name: "交回说明.md", size: 2048, mime: "text/markdown", openHref: "/api/me/local-outputs/o%2F1" });
    expect(cloudOutputFile({ id: "o2", title: "没文件名的", fileName: null, mimeType: null, sizeBytes: null }).name).toBe("没文件名的");
  });

  it("顶上文件名、大小和关闭；别的类型不读内容，只有「打开」；能看的类型读到之前不出「打开」", () => {
    const load = vi.fn(async () => new Blob());
    const other = renderToStaticMarkup(<FilePreview onClose={vi.fn()} file={{ key: "k1", name: "报告.pdf", size: 3 * 1024 * 1024, mime: "application/pdf", openHref: "/api/me/local-outputs/o1", load }} />);
    expect(other).toContain('data-kind="other"');
    expect(other).toMatch(/<b title="报告\.pdf">报告\.pdf<\/b><small>3(\.0)? MB<\/small>/);
    expect(other).toContain('aria-label="关闭"');
    expect(other.match(/>打开<\/a>/g)).toHaveLength(1);
    expect(other).toContain('href="/api/me/local-outputs/o1" target="_blank"');
    const text = renderToStaticMarkup(<FilePreview onClose={vi.fn()} file={{ key: "k2", name: "index.html", size: 120, mime: "text/html", openHref: "/x", load }} />);
    expect(text).toContain('data-kind="text"');
    expect(text).toContain('aria-busy="true"');
    expect(text).not.toContain(">打开</a>");
    expect(text).not.toContain("<iframe");
  });
});
