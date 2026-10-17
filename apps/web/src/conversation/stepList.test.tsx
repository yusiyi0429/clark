import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { StepList, type Step } from "@/components/steps/StepList";
import { ConversationThinking } from "./Transcript";

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

  it("正文开始后步骤收起，进度行里只留一个勾和做完的步数", () => {
    const html = renderToStaticMarkup(<ConversationThinking stage="answering" startedAt={Date.now()} onStop={noop} steps={steps} />);
    expect(html).not.toContain('data-testid="step-list"');
    expect(html).toMatch(/data-testid="step-count" aria-label="已完成 2 步">.*2<\/span>/);
  });

  it("没有步骤事件时，进度行与原来一样", () => {
    const html = renderToStaticMarkup(<ConversationThinking stage="researching" startedAt={Date.now()} onStop={noop} progress={{ label: "查找企业知识「渠道」", checked: 2 }} />);
    expect(html).toContain("查找企业知识「渠道」 · 已查 2 项");
    expect(html).not.toContain("step-list");
  });
});
