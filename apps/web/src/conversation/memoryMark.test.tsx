import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CitationSurfaceProvider } from "./citations";
import { MemoryBody } from "./MemoryMark";
import { ConversationTurn } from "./Transcript";

/** 回答里用到个人记忆的地方（已定设计第 6 节第 5 条）：一个小标记；点开只有这条记忆和「修改」。 */
const ID = "5f0e8c1a-0000-4000-8000-000000000001";
const render = (content: string, linked = false, memoryUsed: string[] | null = [ID], streaming = false) => renderToStaticMarkup(
  createElement(CitationSurfaceProvider, { linked, surface: "rail", children: null },
    createElement(ConversationTurn, { message: { sequence: 1, role: "assistant", content, ...(memoryUsed ? { memoryUsed } : {}) }, streaming })));
const visible = (html: string) => html.replace(/<[^>]+>/g, "");
const item = { id: ID, kind: "stance" as const, title: "渠道下沉", text: "先做县城样板，一线获客太贵。", status: "active" as const, supersededBy: null,
  anchors: [], references: [], createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" };

describe("记忆小标记", () => {
  it("句末、句中、放大时都是同一个小图标标记，带记忆 id；正文里不出现「记忆」两个字，也不是出处圆点", () => {
    for (const html of [
      render(`渠道下沉先做县城样板[记忆](cite:pmem:${ID})。`),
      render(`按你的想法[记忆](cite:pmem:${ID})，先做县城样板。`),
      render(`渠道下沉先做县城样板[记忆](cite:pmem:${ID})。`, true),
    ]) {
      expect(html).toContain(`data-memory-mark="${ID}"`);
      expect(html).toContain('aria-label="个人记忆"');
      expect(html).not.toContain("data-cite-mark");
      expect(html).not.toContain("cite:");
      expect(visible(html)).not.toContain("记忆");
    }
  });

  it("只显示本轮实际用到的记忆（memoryUsed）：不在里面的 id、历史里没有 memoryUsed、正在写的回答，都不显示标记，也不露出文字", () => {
    for (const html of [
      render(`渠道下沉先做县城样板[记忆](cite:pmem:made-up-id)。`),
      render(`渠道下沉先做县城样板[记忆](cite:pmem:${ID})。`, false, null),
      render(`渠道下沉先做县城样板[记忆](cite:pmem:${ID})。`, false, [ID], true),
    ]) {
      expect(html).not.toContain("data-memory-mark");
      expect(html).not.toContain("data-cite-mark");
      expect(visible(html)).toContain("渠道下沉先做县城样板");
      expect(visible(html)).not.toContain("记忆");
    }
  });

  it("点开：这条记忆的标题和正文，加一个「修改」；已被替代、已忘掉的只标状态，不能改；没读到的只标「没读到」", () => {
    const active = renderToStaticMarkup(<MemoryBody id={ID} initial={{ state: "ready", item }} />);
    expect(visible(active)).toBe("渠道下沉先做县城样板，一线获客太贵。");
    expect(active).toContain('aria-label="修改"');
    const superseded = renderToStaticMarkup(<MemoryBody id={ID} initial={{ state: "ready", item: { ...item, status: "superseded", supersededBy: "x" } }} />);
    expect(visible(superseded)).toBe("渠道下沉已替代先做县城样板，一线获客太贵。");
    expect(superseded).not.toContain('aria-label="修改"');
    expect(visible(renderToStaticMarkup(<MemoryBody id={ID} initial={{ state: "ready", item: { ...item, status: "forgotten" } }} />))).toContain("已忘掉");
    expect(visible(renderToStaticMarkup(<MemoryBody id={ID} initial={{ state: "missing" }} />))).toBe("没读到");
  });
});
