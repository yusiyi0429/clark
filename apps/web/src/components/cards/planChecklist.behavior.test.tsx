import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import type { TBuddyPlan } from "@warmap/contracts";
import type { ConversationData, Message } from "@/conversation/useConversation";

/** 伙伴的计划清单（本人 11/18）：挂在已写完回答上的不转，正在写的这一轮照旧转。 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
// 直接调组件（不经 React 渲染）看它给下去的东西、点开 PlanChecklist 时：useMemo 就地算，useState 记在这里；其余照常走 React。
const direct = vi.hoisted(() => ({ on: false, position: 0, values: [] as unknown[] }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return { ...react, useMemo: (compute: () => unknown, deps: readonly unknown[]) => (direct.on ? compute() : react.useMemo(compute, deps)), useState: (initial: unknown) => {
    if (!direct.on) return react.useState(initial);
    const key = direct.position++;
    if (!(key in direct.values)) direct.values[key] = initial;
    return [direct.values[key], (next: unknown) => { direct.values[key] = next; }];
  } };
});

import { PlanChecklist } from "./PlanChecklist";
import { WorkTimeline } from "@/components/work/WorkTimeline";
import { ConversationTimeline } from "@/conversation/ConversationTimeline";

const entries: TBuddyPlan["entries"] = [{ content: "查天枢项目最新进展", status: "completed" }, { content: "联网查上市信息", status: "in_progress" },
  { content: "汇总两件事的结论", status: "pending" }];
const answered = (plan: TBuddyPlan): Message[] => [{ sequence: 1, role: "user", content: "查两件事" },
  { sequence: 2, role: "assistant", content: "两件事都查好了。", plan }];
const data = (messages: Message[], patch: Partial<ConversationData> = {}) => ({ scope: "global", messages, status: "complete", streaming: false, thinking: false,
  partial: "", stage: "answering", startedAt: 0, steps: [], send: vi.fn(), rescope: vi.fn(), ...patch }) as unknown as ConversationData;
const both = (value: ConversationData) => [renderToStaticMarkup(<WorkTimeline data={value} blocks={[]} />), renderToStaticMarkup(<ConversationTimeline data={value} />)];
const spinning = (html: string) => /data-state="running"/.test(html);
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

type Element = ReactElement<Record<string, unknown>>;
const nodes = (node: ReactNode): Element[] => Children.toArray(node).flatMap((child) => isValidElement(child)
  ? [child as Element, ...nodes((child.props as { children?: ReactNode }).children)] : []);

describe("伙伴计划清单：答完不转", () => {
  it("挂在已写完回答上的清单，进行中的条目不转", () => {
    for (const html of both(data(answered({ entries, collapsed: false })))) {
      expect(html).toContain('data-testid="plan-checklist"');
      expect(spinning(html)).toBe(false);
      // 进行中的那条画成不动的空圈，字照旧加粗（data-status 不变）。
      expect(html).toMatch(/data-status="in_progress"><span[^>]*data-state="queued"[^>]*>.*?<\/span><span>联网查上市信息<\/span>/);
    }
  });

  it("正在写的这一轮的清单照旧转", () => {
    for (const html of both(data([{ sequence: 1, role: "user", content: "查两件事" }], { streaming: true, status: "streaming", plan: { entries, collapsed: false } }))) {
      expect(html).toMatch(/data-status="in_progress"><span[^>]*data-state="running"[^>]*aria-label="进行中">.*?<\/span><span>联网查上市信息<\/span>/);
    }
  });

  it("收起的清单显示一行，点开后也不转", () => {
    for (const html of both(data(answered({ entries, collapsed: true })))) {
      expect(html).toContain('data-testid="plan-folded"');
      expect(html).not.toContain('data-testid="plan-checklist"');
      expect(text(html)).toContain("计划 1/3");
    }
    // 点开：照时间线给它的参数（挂在已写完的回答上）。
    const element = nodes(renderTree(answered({ entries, collapsed: true }))).find((node) => node.type === PlanChecklist)!;
    expect(element.props).toMatchObject({ collapsed: true });
    direct.on = true;
    try {
      const folded = PlanChecklist(element.props as Parameters<typeof PlanChecklist>[0]) as Element;
      (folded.props.onClick as () => void)();
      direct.position = 0;
      const opened = renderToStaticMarkup(PlanChecklist(element.props as Parameters<typeof PlanChecklist>[0]) as Element);
      expect(opened).toContain('data-testid="plan-checklist"');
      expect(spinning(opened)).toBe(false);
    } finally {
      direct.on = false;
    }
  });
});

/** ConversationTimeline 挂在回答后面的那一块（after 回调给的元素）。 */
function renderTree(messages: Message[]): ReactNode {
  direct.on = true;
  try {
    const timeline = ConversationTimeline({ data: data(messages) }) as Element;
    const turns = nodes(timeline).find((node) => typeof node.props.after === "function")!;
    return (turns.props.after as (index: number) => ReactNode)(messages.length - 1);
  } finally {
    direct.on = false;
  }
}
