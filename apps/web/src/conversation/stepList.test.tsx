import { describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StepList, StepToggle, type Step } from "@/components/steps/StepList";
import { ConversationThinking, ConversationTurn } from "./Transcript";

/** 当前步骤（已定设计第 6 节第 2 条）：做完打勾、当前高亮、没开始置灰，有结果直接显示；有步骤时替代进度行的单行文字和计数。 */
const noop = () => undefined;
const steps: Step[] = [
  { id: "s1", label: "读 Mission 卡", status: "done" },
  { id: "s2", label: "查企业知识", status: "done", result: "企业知识里找到 2 处相关：《经营原则》" },
  { id: "s3", label: "查个人记忆", status: "active" },
  { id: "s4", label: "整理问题", status: "pending" },
];
const visible = (html: string) => html.replace(/<[^>]+>/g, "");

describe("步骤列表", () => {
  it("按顺序列出步骤：做完的带勾、当前的标为当前步骤、没开始的单独一种状态；结果跟在那一步后面", () => {
    const html = renderToStaticMarkup(<StepList steps={steps} />);
    expect([...html.matchAll(/data-status="(\w+)"/g)].map((match) => match[1])).toEqual(["done", "done", "active", "pending"]);
    expect(html.match(/lucide-check/g)).toHaveLength(2);
    expect(html).toMatch(/data-status="active" aria-current="step"/);
    expect(visible(html)).toBe("读 Mission 卡查企业知识企业知识里找到 2 处相关：《经营原则》查个人记忆整理问题");
    expect(renderToStaticMarkup(<StepList steps={[]} />)).toBe("");
  });

  it("有步骤时：进度行不再显示单行在查什么和「已查几项」，步骤列表接在进度行下面", () => {
    const html = renderToStaticMarkup(<ConversationThinking stage="researching" startedAt={Date.now()} onStop={noop}
      progress={{ label: "查找企业知识「渠道」", checked: 2 }} steps={steps} />);
    expect(html).not.toContain('data-testid="conversation-progress"');
    expect(html).not.toContain("已查 2 项");
    expect(html.indexOf('data-testid="conversation-thinking"')).toBeLessThan(html.indexOf('data-testid="step-list"'));
  });

  it("正文开始后步骤收起：进度行里不再有步骤，这条回答的「用时」一行多一个「✓ N 步」，默认收起", () => {
    const thinking = renderToStaticMarkup(<ConversationThinking stage="answering" startedAt={Date.now()} onStop={noop} steps={steps} />);
    expect(thinking).not.toContain("step-list");
    expect(thinking).not.toContain("step-toggle");
    const turn = renderToStaticMarkup(<ConversationTurn message={{ sequence: 2, role: "assistant", content: "先做县城样板。" }} streaming steps={steps} />);
    expect(turn).toMatch(/data-testid="step-toggle"[^>]*>.*2 步<\/button>/);
    expect(turn).toMatch(/aria-expanded="false"[^>]*data-testid="step-toggle"/);
    expect(turn).not.toContain('data-testid="step-list"');
    expect(renderToStaticMarkup(<ConversationTurn message={{ sequence: 2, role: "assistant", content: "先做县城样板。" }} />)).not.toContain("step-toggle");
  });

  it("「✓ N 步」点一下展开、再点收起；一步都没做完时不出现", () => {
    const onToggle = vi.fn();
    const element = StepToggle({ steps, open: false, onToggle }) as ReactElement<{ onClick: () => void; "aria-expanded": boolean }>;
    expect(element.props["aria-expanded"]).toBe(false);
    element.props.onClick();
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect((StepToggle({ steps, open: true, onToggle }) as ReactElement<{ "aria-expanded": boolean }>).props["aria-expanded"]).toBe(true);
    expect(StepToggle({ steps: [{ id: "s1", label: "查企业知识", status: "active" }], open: false, onToggle })).toBeNull();
  });

  it("没有步骤事件时，进度行与原来一样", () => {
    const html = renderToStaticMarkup(<ConversationThinking stage="researching" startedAt={Date.now()} onStop={noop} progress={{ label: "查找企业知识「渠道」", checked: 2 }} />);
    expect(html).toContain("查找企业知识「渠道」 · 已查 2 项");
    expect(html).not.toContain("step-list");
  });
});
