import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { admit, attachmentKind, sizeText } from "@/lib/home/attachments";
import { InputBar } from "./InputBar";

const file = (name: string, size = 10, type = "") => new File([new Uint8Array(size)], name, { type });

describe("输入框附件（14.5）", () => {
  it("认图片、文档、代码和日志；没扩展名的 Dockerfile 按整个名字认；别的不认", () => {
    expect(["a.PNG", "b.pdf", "c.tsx", "Dockerfile", "d.exe", "e"].map(attachmentKind)).toEqual(["image", "document", "code", "code", null, null]);
  });

  it("加不上的写成一句：一个写「文件名：原因」，几个写「N 个没加上：第一个的原因」；最多 20 个", () => {
    expect(admit(0, [file("a.exe")])).toEqual({ ok: [], error: "a.exe：格式不支持" });
    const big = file("b.pdf");
    Object.defineProperty(big, "size", { value: 31 * 1024 * 1024 });
    expect(admit(0, [big]).error).toBe("b.pdf：超过 30 MB");
    const result = admit(19, [file("c.md"), file("d.md"), file("e.exe")]);
    expect(result.ok.map((entry) => entry.name)).toEqual(["c.md"]);
    expect(result.error).toBe("2 个没加上：最多 20 个");
    // 粘贴的截图没有名字也认（按类型）。
    expect(admit(0, [file("", 10, "image/png")]).ok).toHaveLength(1);
  });

  it("大小写成 KB / MB", () => {
    expect([sizeText(300), sizeText(12 * 1024), sizeText(3.4 * 1024 * 1024)]).toEqual(["1 KB", "12 KB", "3.4 MB"]);
  });
});

describe("输入框（14.5）", () => {
  it("空着时一行：左「+」、右麦克风，没有发送；「关于」胶囊在框里；「发给」在框下面", () => {
    const html = renderToStaticMarkup(<InputBar placeholder="说点什么…" onSend={async () => true}
      context={{ label: "关于：会议回流", onClear: () => undefined }} under={<span>发给</span>} />);
    expect(html).toMatch(/aria-label="添加文件或图片".*<textarea[^>]*placeholder="说点什么…".*aria-label="说话"/);
    expect(html).not.toContain('data-testid="input-send"');
    expect(html).toMatch(/data-testid="input-bar".*关于：会议回流.*<\/div><div[^>]*>.*发给/);
  });

  it("回答进行中：右边是停止", () => {
    const html = renderToStaticMarkup(<InputBar placeholder="与伙伴讨论…" busy onStop={() => undefined} onSend={async () => true} />);
    expect(html).toContain('aria-label="停止本次回答"');
  });
});
