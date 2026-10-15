import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkspaceContext, type WorkspaceApi } from "@/components/shell/WorkspaceContext";
import { fetchKnowledgeSource, KnowledgeSource } from "./SourceViewer";

const reply = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

afterEach(() => vi.unstubAllGlobals());

describe("依据面板直接读企业知识原文", () => {
  it("取一节：经同源 /api 带上编码后的引用，返回章节与段落", async () => {
    const sections = [{ id: "经营原则.md#s2", title: "交付先于扩张", updatedAt: "2026-10-01T02:00:00.000Z", passages: [{ id: "p1", text: "先交付再扩张。" }] }];
    const fetchMock = vi.fn(async (_url: string) => reply(200, { ref: "memory:经营原则.md#s2", file: "经营原则.md", sections }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchKnowledgeSource("经营原则.md", 2)).resolves.toEqual(sections);
    expect(fetchMock.mock.calls[0][0]).toBe(`/api/knowledge/source?ref=${encodeURIComponent("memory:经营原则.md#s2")}`);
  });

  it("不带节号取整份文件", async () => {
    const fetchMock = vi.fn(async (_url: string) => reply(200, { sections: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await fetchKnowledgeSource("经营原则.md", null);
    expect(fetchMock.mock.calls[0][0]).toBe(`/api/knowledge/source?ref=${encodeURIComponent("memory:经营原则.md")}`);
  });

  it("找不到、读失败时给平实说明；未登录回登录页", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply(404, { code: "KNOWLEDGE_NOT_FOUND" })));
    await expect(fetchKnowledgeSource("x.md", 9)).rejects.toThrow("企业知识中未找到该节，可能已改版。");
    vi.stubGlobal("fetch", vi.fn(async () => reply(500, {})));
    await expect(fetchKnowledgeSource("x.md", 1)).rejects.toThrow("该节原文暂未读取成功。");
    const assign = vi.fn();
    vi.stubGlobal("window", { location: { assign } });
    vi.stubGlobal("fetch", vi.fn(async () => reply(401, {})));
    await expect(fetchKnowledgeSource("x.md", 1)).resolves.toBeNull();
    expect(assign).toHaveBeenCalledWith("/access");
  });

  it("打开时先写「正在读取…」，不再说原文不能在这里打开", () => {
    const api = { compose: vi.fn(), quote: vi.fn() } as unknown as WorkspaceApi;
    const html = renderToStaticMarkup(createElement(WorkspaceContext.Provider, { value: api },
      createElement(KnowledgeSource, { file: "经营原则.md", section: 2, label: "《经营原则》" })));
    expect(html).toContain("正在读取该节原文…");
    expect(html).not.toMatch(/不能直接打开|天枢知识库提供/);
  });
});
