import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { SessionEntry } from "@/lib/local/sessionView";
import { createMockRunner } from "@/lib/local/mock";
import { filesSignal, matchChangedFile } from "@/lib/local/sessionFiles";
import { FilePreview, PREVIEW_IMAGE_MAX, PREVIEW_TEXT_MAX, cloudOutputFile, localSessionFile, previewKind } from "./FilePreview";
import { SessionTranscript, type OpenFile } from "./SessionTranscript";

const at = "2026-11-10T01:00:00Z";
const transcript = (entries: SessionEntry[], onFile?: OpenFile) =>
  renderToStaticMarkup(<SessionTranscript entries={entries} agentName="Claude Code" canAct onDecide={vi.fn()} live={false} onFile={onFile} />);

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

  it("开工那句交代（source = initial）照回答的 Markdown 画：看不到 ##，标题、列表成形；本人后来插的话还是原样", async () => {
    const { foldEvents } = await import("@/lib/local/sessionView");
    const view = foldEvents([
      { seq: 1, at, type: "user_message", text: "## 交代\n\n- 做完\n- **验收**", source: "initial" },
      { seq: 2, at, type: "user_message", text: "**别加粗**", source: "web", messageId: "m1" },
    ] as never);
    expect(view.entries.map((entry) => entry.kind === "user" && !!entry.initial)).toEqual([true, false]);
    const html = transcript(view.entries);
    expect(html).not.toContain("## 交代");
    expect(html).toContain("<h2>交代</h2>");
    expect(html).toContain("<li>做完</li>");
    expect(html).toContain("<strong>验收</strong>");
    expect(html).toContain("**别加粗**");
  });

  it("「交出 文件名」：对得上交出的产出时文件名能点，对不上照旧是字", () => {
    const entries: SessionEntry[] = [{ kind: "artifact", seq: 1, at, title: "交回说明", fileName: "交回说明.md" }];
    expect(transcript(entries, () => vi.fn())).toMatch(/交出 <button[^>]*data-testid="artifact-open"[^>]*>交回说明\.md<\/button>/);
    expect(transcript(entries, () => null)).not.toContain("artifact-open");
    expect(transcript(entries)).not.toContain("artifact-open");
  });

  it("回答里提到的文件路径：行内代码和链接对得上才能点，对不上照原样；代码块里的不认", () => {
    const known = new Set(["apps/web/src/a.ts", "docs/说明.md"]);
    const asked: string[] = [];
    const onFile: OpenFile = (mention) => { asked.push(mention); return known.has(mention) ? vi.fn() : null; };
    const html = transcript([{ kind: "assistant", seq: 1, at, text: [
      "改了 `apps/web/src/a.ts`，没动 `apps/web/src/b.ts`。", "", "见 [说明](docs/%E8%AF%B4%E6%98%8E.md) 和 [官网](https://example.com)。", "",
      "```ts", "apps/web/src/a.ts", "```",
    ].join("\n") }], onFile);
    expect(html).toContain('<code><button type="button" class="' );
    expect(html).toMatch(/<code><button[^>]*data-testid="file-open"[^>]*>apps\/web\/src\/a\.ts<\/button><\/code>/);
    expect(html).toContain("<code>apps/web/src/b.ts</code>");
    expect(html).toMatch(/<button[^>]*data-testid="file-open"[^>]*>说明<\/button>/);
    expect(html).toContain('<a href="https://example.com" target="_blank" rel="noopener noreferrer">官网</a>');
    expect(html.match(/data-testid="file-open"/g)).toHaveLength(2);
    expect(asked).toContain("docs/说明.md");
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

  it("交出的产出读云端那份：文件名、大小照产出的，地址是本人的产出接口；认不出类型、太大的不用读，只给「打开」", async () => {
    const file = cloudOutputFile({ id: "o/1", title: "交回说明", fileName: "交回说明.md", mimeType: "text/markdown", sizeBytes: 2048 });
    expect(file).toMatchObject({ key: "output:o/1", name: "交回说明.md", size: 2048, openHref: "/api/me/local-outputs/o%2F1" });
    expect(file.instant).toBeUndefined();
    expect(cloudOutputFile({ id: "o2", title: "没文件名的", fileName: null, mimeType: null, sizeBytes: null }).name).toBe("没文件名的");
    const pdf = cloudOutputFile({ id: "o3", title: "报告", fileName: "报告.pdf", mimeType: "application/pdf", sizeBytes: 100 });
    expect(pdf.instant).toEqual({ kind: "other" });
    expect(await pdf.load()).toEqual({ kind: "other" });
  });

  it("本会话的文件向这台电脑的本机程序读：类型、大小、截没截断照它说的；图片拼成 data 地址；没有「打开」", async () => {
    const runner = createMockRunner({ stepMs: 1 });
    const session = await runner.createSession({ subject: { kind: "card", cardId: "c1" }, title: "卡", cwd: "C:\\work\\tianshu", firstMessage: "交代" });
    const md = localSessionFile(runner, session.id, "交回说明.md");
    expect(md).toMatchObject({ key: `local:${session.id}:交回说明.md`, name: "交回说明.md", size: null, openHref: null });
    expect(await md.load()).toMatchObject({ kind: "markdown", truncated: false });
    expect(localSessionFile(runner, session.id, "apps\\web\\src\\app\\manifest.ts").name).toBe("manifest.ts");
    expect(await localSessionFile(runner, session.id, "C:/work/tianshu/apps/web/src/app/manifest.ts").load()).toMatchObject({ kind: "text" });
    const image = await localSessionFile(runner, session.id, "apps/web/public/icon.png").load();
    expect(image).toMatchObject({ kind: "image" });
    expect(image.kind === "image" && image.url.startsWith("data:image/png;base64,")).toBe(true);
    await expect(localSessionFile(runner, session.id, "../外面.txt").load()).rejects.toMatchObject({ status: 403 });
    await expect(localSessionFile(runner, session.id, "没有.md").load()).rejects.toMatchObject({ status: 404 });
    // 截断的、读不出内容的照本机说的。
    const cut = { readSessionFile: async () => ({ path: "big.log", absolutePath: "C:/work/big.log", name: "big.log", size: 3_000_000, modifiedAt: at, kind: "text" as const, mimeType: "text/plain", encoding: "utf8" as const, content: "前 1 MB", truncated: true }) };
    expect(await localSessionFile(cut, "s1", "big.log").load()).toEqual({ kind: "text", text: "前 1 MB", truncated: true, size: 3_000_000 });
    const huge = { readSessionFile: async () => ({ path: "a.png", absolutePath: "C:/work/a.png", name: "a.png", size: 9_000_000, modifiedAt: at, kind: "image" as const, mimeType: "image/png", encoding: "base64" as const, content: null, truncated: true }) };
    expect(await localSessionFile(huge, "s1", "a.png").load()).toEqual({ kind: "other", size: 9_000_000 });
  });

  it("改动的文件：回答里的相对路径、绝对路径（反斜杠、带行号）对得上才算；只写文件名的、不在了的不算", async () => {
    const runner = createMockRunner({ stepMs: 1 });
    const session = await runner.createSession({ subject: { kind: "card", cardId: "c1" }, title: "卡", cwd: "C:\\work\\tianshu", firstMessage: "交代" });
    const { files } = await runner.listSessionFiles(session.id);
    expect(files.map((file) => [file.path, file.exists])).toEqual([["apps/web/public/icon.png", true], ["apps/web/src/app/manifest.ts", true], ["docs/install-old.md", false], ["README.md", true], ["交回说明.md", true]]);
    expect(matchChangedFile(files, "apps/web/src/app/manifest.ts")?.path).toBe("apps/web/src/app/manifest.ts");
    expect(matchChangedFile(files, "./apps/web/src/app/manifest.ts:12")?.path).toBe("apps/web/src/app/manifest.ts");
    expect(matchChangedFile(files, "c:\\work\\tianshu\\README.md:3-9")?.path).toBe("README.md");
    expect(matchChangedFile(files, "manifest.ts")).toBeNull();
    expect(matchChangedFile(files, "docs/install-old.md")).toBeNull();
    expect(matchChangedFile(files, "pnpm test")).toBeNull();
    // 什么时候重读清单：状态变了，或又做完一步改文件、写文件；读文件、跑命令不算。
    const step = (seq: number, title: string, done = true): SessionEntry => ({ kind: "step", seq, at, toolUseId: `t${seq}`, title, done, isError: false });
    expect(filesSignal("running", [step(1, "读文件 a.ts"), step(2, "运行 pnpm test")])).toBe("running|0|0");
    expect(filesSignal("running", [step(1, "改文件 a.ts"), step(2, "写 交回说明.md"), step(3, "写文件 b.ts", false)])).toBe("running|2|0");
    expect(filesSignal("idle", [])).toBe("idle|0|0");
    // 一轮末尾的 files_changed 比变空闲晚到（第 72 条）：来了再读一次。
    expect(filesSignal("idle", [{ kind: "files", seq: 9, at, turn: 1, files: [], more: 0 }])).toBe("idle|0|1");
  });

  it("顶上文件名、大小和关闭；不用读的直接是「打开」；要读的读到之前不出「打开」", () => {
    const load = vi.fn(async () => ({ kind: "other" as const }));
    const other = renderToStaticMarkup(<FilePreview onClose={vi.fn()} file={{ key: "k1", name: "报告.pdf", size: 3 * 1024 * 1024, openHref: "/api/me/local-outputs/o1", instant: { kind: "other" }, load }} />);
    expect(other).toContain('data-kind="other"');
    expect(other).toMatch(/<b title="报告\.pdf">报告\.pdf<\/b><small>3(\.0)? MB<\/small>/);
    expect(other).toContain('aria-label="关闭"');
    expect(other.match(/>打开<\/a>/g)).toHaveLength(1);
    expect(other).toContain('href="/api/me/local-outputs/o1" target="_blank"');
    const text = renderToStaticMarkup(<FilePreview onClose={vi.fn()} file={{ key: "k2", name: "index.html", size: 120, openHref: "/x", load }} />);
    expect(text).toContain('aria-busy="true"');
    expect(text).not.toContain(">打开</a>");
    expect(text).not.toContain("<iframe");
    // 文本太长只读到前面一截的，顶上多一个状态词。
    const cut = renderToStaticMarkup(<FilePreview onClose={vi.fn()} file={{ key: "k4", name: "big.log", size: null, openHref: null, instant: { kind: "text", text: "前面一截", truncated: true, size: 3_000_000 }, load }} />);
    expect(cut).toMatch(/<small>2\.9 MB<\/small><small[^>]*>已截断<\/small>/);
    expect(renderToStaticMarkup(<FilePreview onClose={vi.fn()} file={{ key: "k5", name: "a.log", size: 10, openHref: null, instant: { kind: "text", text: "全的" }, load }} />)).not.toContain("已截断");
    // 本机的文件没有「打开」的地址。
    expect(renderToStaticMarkup(<FilePreview onClose={vi.fn()} file={{ key: "k3", name: "a.bin", size: null, openHref: null, instant: { kind: "other", size: 2048 }, load }} />)).not.toContain(">打开</a>");
  });
});
