import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CitationLink, CitationSurfaceProvider, citationRef, citationUrlTransform } from "./citations";
import { ConversationTurn } from "./Transcript";
import { registerCitationPanel, resetCitationBridge } from "./citationBridge";

// 深度讨论 v2：Agent 把内部依据写成 [名称](cite:<ref>)；放大时是轻量链接，平时、解析失败都只显示名称。
const answer = "交付先于扩张。来源：[《经营原则》第 2 节](cite:memory:kd-principles.md#s2)；外部：[路透报道](https://example.com/a)；坏的：[某材料](cite:bogus:1)。";
const turn = (linked: boolean, content = answer, surface: "rail" | "sheet" = "rail") => renderToStaticMarkup(
  createElement(CitationSurfaceProvider, { linked, surface, children: null }, createElement(ConversationTurn, { message: { sequence: 1, role: "assistant", content } })));

afterEach(() => resetCitationBridge());

describe("回答里的来源解析", () => {
  it("cite: 地址解析出 ref：企业知识、群材料段落、议题研究都认；不是 cite:、认不出、解码失败都是 null", () => {
    expect(citationRef("cite:memory:kd-principles.md#s2")).toBe("memory:kd-principles.md#s2");
    expect(citationRef("cite:material:9b1c3b1e-7c55-4c4c-9a8e-2f1d4b7a6c10@v2#p3")).toBe("material:9b1c3b1e-7c55-4c4c-9a8e-2f1d4b7a6c10@v2#p3");
    expect(citationRef("cite:research%3Ai-1")).toBe("research:i-1");
    expect(citationRef("https://example.com")).toBeNull();
    expect(citationRef("cite:bogus:1")).toBeNull();
    expect(citationRef("cite:")).toBeNull();
    expect(citationRef("cite:%E0%A4%A")).toBeNull();
    expect(citationRef(undefined)).toBeNull();
  });

  it("cite: 地址不被默认清洗清空；其他地址照默认规则（javascript: 仍被清掉）", () => {
    expect(citationUrlTransform("cite:memory:a.md#s1")).toBe("cite:memory:a.md#s1");
    expect(citationUrlTransform("https://example.com/a")).toBe("https://example.com/a");
    expect(citationUrlTransform("javascript:alert(1)")).toBe("");
  });
});

describe("回答里的来源渲染", () => {
  it("放大时：认得的来源是一颗轻量按钮（带 ref），不显示原始标记；外部来源仍是普通链接；认不出的只是文字", () => {
    const html = turn(true);
    expect(html).toMatch(/<button type="button" class="[^"]*" data-cite-ref="memory:kd-principles.md#s2" title="在左侧查看这条依据">/);
    expect(html).toContain("《经营原则》第 2 节");
    expect(html).toContain('href="https://example.com/a"');
    expect(html).toContain('data-cite="invalid"');
    expect(html).toContain("某材料");
    expect(html).not.toContain("cite:");
    expect(html).not.toContain("bogus");
  });

  it("平时：来源只显示名称，不可点（同一字号，切换时正文不跳）", () => {
    const html = turn(false);
    expect(html).not.toContain("<button");
    expect(html).toContain('data-cite="plain"');
    expect(html).toContain("《经营原则》第 2 节");
    expect(html).not.toContain("cite:");
  });

  it("流式中没写完的来源链接只显示文字，不露出半截标记", () => {
    const html = renderToStaticMarkup(createElement(CitationSurfaceProvider, { linked: true, surface: "rail", children: null },
      createElement(ConversationTurn, { message: { sequence: -1, role: "assistant", content: "依据：[《经营原则》第 2 节](cite:memory:kd-princ" }, streaming: true })));
    expect(html).not.toContain("cite:");
    expect(html).not.toContain("<button");
  });

  it("点下去交给依据导航：带上 ref 与所在那一面（首页对话层是 sheet）", () => {
    const panel = vi.fn();
    registerCitationPanel(panel);
    const element = CitationLink({ citeRef: "memory:kd-principles.md#s2", surface: "sheet", children: "《经营原则》第 2 节" }) as ReactElement<{ onClick: (event: unknown) => void }>;
    element.props.onClick({ currentTarget: "trigger" });
    expect(panel).toHaveBeenCalledWith("memory:kd-principles.md#s2", { surface: "sheet", trigger: "trigger" });
    expect(turn(true, answer, "sheet")).toContain("data-cite-ref");
  });
});
