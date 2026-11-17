import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import type { ConversationData, Message } from "./useConversation";

/** 回答末尾的选项：原文不进 DOM、不进到达淡入的分段；只在最新一条回答下；新首页的两种对话里点了直接发，别处只填输入框。 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
// 直接调 WorkTimeline 看它给下去的东西时，useMemo 就地算（不经 React 渲染）。
const direct = vi.hoisted(() => ({ on: false }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return { ...react, useMemo: (compute: () => unknown, deps: readonly unknown[]) => (direct.on ? compute() : react.useMemo(compute, deps)) };
});

import { ConversationTimeline } from "./ConversationTimeline";
import { ConversationTurn } from "./Transcript";
import { AnswerOptions, QuickReplyContext } from "./AnswerOptionRow";
import { ANSWER_OPTION_EVENT } from "./answerOptions";
import { WorkTimeline } from "@/components/work/WorkTimeline";

const ANSWER = "## 备选方案\n- 维持现状：按现有排期\n- 正式采用：本周发出 PO";
const BLOCK = '```options\n[{"label":"维持现状"},{"label":"正式采用"},{"label":"暂不决定"}]\n```';
const withBlock = `${ANSWER}\n\n${BLOCK}`;
const RAW = /```|options|&quot;label|"label/;
const data = (messages: Message[], patch: Partial<ConversationData> = {}) =>
  ({ scope: "battlefield:aidc", messages, status: "complete", streaming: false, partial: "", ...patch }) as unknown as ConversationData;
const ask = (sequence: number, content: string): Message => ({ sequence, role: "user", content });
const reply = (sequence: number, content: string): Message => ({ sequence, role: "assistant", content });
const optionRow = (html: string) => html.match(/data-testid="answer-options"[\s\S]*?<\/div>/g) ?? [];

describe("选项块不显示原文", () => {
  it("读回的历史消息：正文里没有选项块，选项按钮在回答下方", () => {
    const html = renderToStaticMarkup(<ConversationTimeline data={data([ask(1, "要不要正式采用？"), reply(2, withBlock)])} />);
    expect(html.replace(/<div[^>]*data-testid="answer-options"[\s\S]*$/, "")).not.toMatch(RAW);
    expect(html).toContain("按现有排期");
    expect(optionRow(html)).toHaveLength(1);
    expect(html.indexOf("answer-options")).toBeGreaterThan(html.indexOf("本周发出 PO"));
    for (const label of ["维持现状", "正式采用", "暂不决定"]) expect(optionRow(html)[0]).toContain(`>${label}</button>`);
  });

  it("流式中每一个前缀：DOM 与到达淡入的分段里都没有选项块的字", () => {
    for (let end = ANSWER.length; end <= withBlock.length; end++) {
      const html = renderToStaticMarkup(<ConversationTurn message={{ sequence: -1, role: "assistant", content: withBlock.slice(0, end) }} streaming />);
      expect(html).not.toMatch(RAW);
      for (const segment of html.match(/<span data-arrival="">[^<]*<\/span>/g) ?? []) expect(segment).not.toMatch(/`|options|label|\[|\{/);
    }
  });

  it("流式中不显示选项；解析失败的块不显示选项也不显示原文", () => {
    const streaming = renderToStaticMarkup(<ConversationTimeline data={data([ask(1, "要不要？")], { streaming: true, status: "streaming", partial: withBlock })} />);
    expect(streaming).not.toContain("answer-options");
    expect(streaming).not.toMatch(RAW);
    const broken = renderToStaticMarkup(<ConversationTimeline data={data([ask(1, "要不要？"), reply(2, `${ANSWER}\n\n\`\`\`options\n[维持现状, 正式采用]\n\`\`\``)])} />);
    expect(broken).not.toContain("answer-options");
    expect(broken).not.toMatch(RAW);
  });
});

describe("只在最新一条回答下", () => {
  it("较早的回答不显示；下一条消息发出后（最后一条是提问）消失", () => {
    const history = [ask(1, "要不要？"), reply(2, withBlock), ask(3, "再说说风险"), reply(4, "风险在交期。")];
    expect(renderToStaticMarkup(<ConversationTimeline data={data(history)} />)).not.toContain("answer-options");
    const sent = renderToStaticMarkup(<ConversationTimeline data={data([ask(1, "要不要？"), reply(2, withBlock), ask(3, "选择：正式采用")], { streaming: true, status: "streaming" })} />);
    expect(sent).not.toContain("answer-options");
    const latest = renderToStaticMarkup(<ConversationTimeline data={data([...history, ask(5, "再判断一次"), reply(6, withBlock)])} />);
    expect(optionRow(latest)).toHaveLength(1);
  });

  it("没有备选方案的普通回答没有选项", () => {
    expect(renderToStaticMarkup(<ConversationTimeline data={data([ask(1, "交付怎样？"), reply(2, "交付按计划。")])} />)).not.toContain("answer-options");
  });
});

describe("点击", () => {
  it("只派发「选择：{方案名}」给这条对话的输入框，不发送", () => {
    const dispatch = vi.fn();
    vi.stubGlobal("window", { dispatchEvent: dispatch });
    const row = AnswerOptions({ scope: "battlefield:aidc", options: ["维持现状", "暂不决定"] }) as ReactElement<{ children: ReactElement<{ onClick: () => void; type: string }>[] }>;
    const [first, second] = row.props.children;
    expect(first.props.type).toBe("button");
    second.props.onClick();
    expect(dispatch).toHaveBeenCalledOnce();
    const event = dispatch.mock.calls[0][0] as CustomEvent;
    expect(event.type).toBe(ANSWER_OPTION_EVENT);
    expect(event.detail).toEqual({ scope: "battlefield:aidc", text: "选择：暂不决定" });
    vi.unstubAllGlobals();
  });
});

describe("快捷回复（设计 6.4）", () => {
  const PLAIN = `两个都行，看你。\n\n${BLOCK}`;
  type Element = ReactElement<Record<string, unknown>>;
  const elements = (node: ReactNode): Element[] => (Array.isArray(node) ? node.flatMap(elements)
    : isValidElement(node) ? [node as Element, ...elements((node as Element).props.children as ReactNode)] : []);
  /** 从 at 处那个 <div 起，到和它配对的 </div> 为止。 */
  const divAt = (html: string, at: number) => {
    const tags = /<div\b[^>]*>|<\/div>/g;
    tags.lastIndex = at;
    let depth = 0;
    for (let tag = tags.exec(html); tag; tag = tags.exec(html)) {
      depth += tag[0].startsWith("</") ? -1 : 1;
      if (depth === 0) return html.slice(at, tags.lastIndex);
    }
    return html.slice(at);
  };

  it("气泡里的快捷回复点了直接发出", () => {
    const send = vi.fn(async () => true);
    const history = data([ask(1, "先做哪个？"), reply(2, PLAIN)], { send, rescope: vi.fn() });
    const html = renderToStaticMarkup(<WorkTimeline data={history} blocks={[]} />);
    // 一排小胶囊，在这条回复里、最后一个气泡下面（「用时」那一排之前），不在这条回复外面。
    const article = html.slice(html.lastIndexOf("<article"));
    const row = article.indexOf('data-testid="answer-options"');
    expect(row).toBeGreaterThan(article.lastIndexOf('data-bubble="buddy"'));
    expect(row).toBeLessThan(article.indexOf("</article>"));
    expect(divAt(article, article.lastIndexOf("<div", row))).toMatch(/data-pills=""/);
    expect(optionRow(html)).toHaveLength(1);
    // 点了：选项的字原样作为本人的话发出去，不填输入框。
    const dispatch = vi.fn();
    vi.stubGlobal("window", { dispatchEvent: dispatch });
    direct.on = true;
    const tree = WorkTimeline({ data: history, blocks: [] });
    direct.on = false;
    const quick = elements(tree).find((element) => element.type === QuickReplyContext || element.type === QuickReplyContext.Provider)!.props.value as
      { sequence: number; send: (text: string) => void };
    expect(quick.sequence).toBe(history.messages[1]!.sequence);
    const pills = AnswerOptions({ options: ["维持现状", "正式采用"], send: quick.send }) as ReactElement<{ children: ReactElement<{ onClick: () => void }>[] }>;
    pills.props.children[1].props.onClick();
    expect(send).toHaveBeenCalledWith("正式采用", []);
    expect(dispatch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("别处的快捷回复照旧只填输入框", () => {
    const html = renderToStaticMarkup(<ConversationTimeline data={data([ask(1, "先做哪个？"), reply(2, PLAIN)])} />);
    // 在这条回答外面（下面），不是胶囊。
    expect(html.indexOf('data-testid="answer-options"')).toBeGreaterThan(html.lastIndexOf("</article>"));
    expect(optionRow(html)[0]).not.toContain("data-pills");
    const dispatch = vi.fn();
    vi.stubGlobal("window", { dispatchEvent: dispatch });
    const row = AnswerOptions({ scope: "battlefield:aidc", options: ["维持现状", "正式采用"] }) as ReactElement<{ children: ReactElement<{ onClick: () => void }>[] }>;
    row.props.children[1].props.onClick();
    expect((dispatch.mock.calls[0][0] as CustomEvent).detail).toEqual({ scope: "battlefield:aidc", text: "选择：正式采用" });
    vi.unstubAllGlobals();
  });
});
