import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { createMockRunner } from "@/lib/local/mock";
import { LocalRunnerError } from "@/lib/local/runner";

/** 没有 jsdom：HeroUI 的 Modal 换成直接把内容画出来的桩，看弹窗里有什么。 */
vi.mock("@heroui/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@heroui/react")>();
  const pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return { ...actual, Modal: Object.assign(pass, { Backdrop: pass, Container: pass, Dialog: pass }) };
});

import { TokenHubDialog, tokenHubFailure } from "./TokenHubDialog";

const text = (html: string) => html.replace(/<[^>]+>/g, "|").replace(/\|+/g, "|");

describe("连 TokenHub 的小弹窗（17.2 第 51 条）", () => {
  it("标题、API Key 密码框（进来就聚焦、行尾小眼睛）、取消、连接；不加说明句；没填 Key「连接」点不了", () => {
    const html = renderToStaticMarkup(<TokenHubDialog onConnect={async () => undefined} onClose={() => undefined} />);
    expect(text(html)).toBe("|连接 TokenHub|取消|连接|");
    expect(html).toMatch(/<input[^>]*autofocus=""[^>]*type="password"[^>]*aria-label="API Key"[^>]*placeholder="API Key"/);
    expect(html).toMatch(/<button[^>]*aria-label="显示"[^>]*aria-pressed="false"/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-testid="tokenhub-connect"|data-testid="tokenhub-connect"[^>]*disabled=""/);
  });

  it("没连上的原因：Key 不对、连不上 TokenHub 照写，连不上本机程序另写，别的照本机回的", () => {
    expect(tokenHubFailure(new LocalRunnerError("tokenhub_key_rejected", "x", 422))).toBe("Key 不对");
    expect(tokenHubFailure(new LocalRunnerError("tokenhub_unreachable", "x", 502))).toBe("连不上 TokenHub");
    expect(tokenHubFailure(new LocalRunnerError("network", "Failed to fetch"))).toBe("连不上本机程序");
    expect(tokenHubFailure(new LocalRunnerError("not_found", "没有这个接口", 404))).toBe("没有这个接口");
  });

  it("假本机程序：Key 不对、连不上照样报；连上多两个 th- 模型；断开就没了", async () => {
    const runner = createMockRunner({ stepMs: 0 });
    const th = async () => (await runner.listModels()).filter((model) => model.id.startsWith("th-")).map((model) => model.modelName);
    await expect(runner.connectTokenHub("bad-key")).rejects.toMatchObject({ code: "tokenhub_key_rejected" });
    await expect(runner.connectTokenHub("offline-key")).rejects.toMatchObject({ code: "tokenhub_unreachable" });
    expect(await th()).toEqual([]);
    await runner.connectTokenHub("good-key");
    expect(await th()).toEqual(["Opus 5.5", "deepseek-v4.1-flash"]);
    await runner.disconnectTokenHub();
    expect(await th()).toEqual([]);
  });
});
