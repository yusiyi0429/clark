import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CloudError } from "@/lib/board/cloud";
import { FailedLine, failureOf } from "./DecisionBox";

describe("动作没成（5.4.1 交互状态表）", () => {
  it("一般的错：原处「失败」加「重试」，原因在 title 里", () => {
    const failure = failureOf(new Error("网络断了"), vi.fn());
    expect(failure.note).toBeNull();
    const html = renderToStaticMarkup(<FailedLine {...failure} />);
    expect(html).toContain('title="网络断了"');
    expect(html).toMatch(/失败.*重试/);
  });

  it("推翻时合回结果还没报上来（409 MERGE_PENDING）：云端的话原样写出来，不给「重试」", () => {
    const failure = failureOf(new CloudError(409, "这张卡的合回结果还没报上来，等电脑上线以后再推翻", "MERGE_PENDING"), vi.fn());
    const html = renderToStaticMarkup(<FailedLine {...failure} />);
    expect(html).toContain("这张卡的合回结果还没报上来，等电脑上线以后再推翻");
    expect(html).not.toContain("重试");
    expect(html).not.toContain("失败");
  });

  it("登记「再改一轮」「我来补」的三种 409（主循环第 62 条）：各写一句现状，不给「重试」", () => {
    const say = (code: string) => renderToStaticMarkup(<FailedLine {...failureOf(new CloudError(409, "x", code), vi.fn())} />);
    expect(say("RELAY_PENDING")).toContain("已登记，等电脑在线");
    expect(say("NOTHING_TO_RELAY")).toContain("这次交回已经处理过了");
    expect(say("NOT_STARTED")).toContain("这张卡还没开过工");
    expect(say("NOT_STARTED")).not.toContain("重试");
  });
});
