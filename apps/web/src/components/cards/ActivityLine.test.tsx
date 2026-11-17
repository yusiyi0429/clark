import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { TLocalPlanEntry } from "@warmap/contracts";
import { foldEvents, type SessionEntry } from "@/lib/local/sessionView";
import type { TLocalSessionEvent } from "@/lib/local/runner";
import type { ConversationData } from "@/conversation/useConversation";
import { WorkTimeline, conversationDoing } from "@/components/work/WorkTimeline";
import { PlanChecklist } from "./PlanChecklist";
import { SessionTranscript } from "./SessionTranscript";
import { ActivityLine, MARK_FRAMES, planDoing } from "./ActivityLine";

const css = readFileSync(new URL("../../styles/v2-session.module.css", import.meta.url), "utf8");
const text = (html: string) => html.replace(/<[^>]+>/g, "|").replace(/\|+/g, "|");
const since = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString();
const plan: TLocalPlanEntry[] = [
  { content: "确认工作树", status: "completed" },
  { content: "调查实现", status: "in_progress" },
  { content: "写测试", status: "in_progress" },
  { content: "提交", status: "pending" },
];

describe("计划清单：同时在做的几条一起转圈（本人 11/16）", () => {
  it("两条 in_progress 各画一个转圈，做完的一个勾，没开始的一个空圈", () => {
    const html = renderToStaticMarkup(<PlanChecklist entries={plan} />);
    expect(html.match(/data-state="running"/g)).toHaveLength(2);
    expect(html.match(/data-state="done"/g)).toHaveLength(1);
    expect(html.match(/data-state="queued"/g)).toHaveLength(1);
    expect(text(html)).toContain("|确认工作树|调查实现|写测试|提交|");
  });
});

describe("「在做什么」那一行（照 Claude Code，本人 11/16）", () => {
  it("计划里在做的那句：第一条 in_progress；没有就没有", () => {
    expect(planDoing(plan)).toBe("调查实现");
    expect(planDoing([{ content: "提交", status: "pending" }])).toBeNull();
    expect(planDoing(undefined)).toBeNull();
  });

  it("一行：字符动画（读屏念状态）、在做什么、这一轮的用时；有细节才有 ›，点开才看", () => {
    const html = renderToStaticMarkup(<ActivityLine text="看方案 A 测试具体哪一行没过" since={since(75)} detail={<p>细节</p>} />);
    expect(html).toMatch(/data-testid="activity-line"/);
    expect(html).toMatch(/role="img"[^>]*aria-label="进行中"/);
    for (const frame of MARK_FRAMES) expect(html).toContain(frame);
    expect(text(html)).toMatch(/\|看方案 A 测试具体哪一行没过\|1 分 15 秒\|/);
    expect(html).toMatch(/aria-expanded="false"/);
    expect(html).toMatch(/inert=""/);
    const bare = renderToStaticMarkup(<ActivityLine text={null} since={since(3)} />);
    expect(bare).not.toContain("aria-expanded");
    expect(text(bare)).toContain("|3 秒|");
  });

  it("样式：动画用站内强调色，减少动态效果时停下；字号走 --type-size: 15px，不直接写 font-size；深浅只用 ink 三档", () => {
    const rule = (name: string) => css.match(new RegExp(`\\.${name} \\{[^}]*\\}`))?.[0] ?? "";
    expect(rule("mark")).toContain("var(--accent)");
    expect(css).toMatch(/@keyframes markTurn/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{[^}]*\.mark > span \{ animation: none; \}/);
    expect(rule("activity")).toContain("--type-size: 15px");
    const block = css.slice(css.indexOf("/* 「在做什么」"), css.indexOf("/* 「在做什么」完 */"));
    expect(block).not.toMatch(/font-size/);
    expect(block.match(/#[0-9a-f]{3,8}\b|rgb\(/gi)).toBeNull();
  });
});

describe("子会话：「在做什么」那一行", () => {
  const step = (seq: number, title: string, at: string, done = true, description?: string): SessionEntry =>
    ({ kind: "step", seq, at, toolUseId: `t${seq}`, title, done, isError: false, ...(description ? { description } : {}) });
  const render = (entries: SessionEntry[], extra: { draft?: string; plan?: TLocalPlanEntry[] } = {}) =>
    renderToStaticMarkup(<SessionTranscript entries={entries} agentName="Claude Code" canAct onDecide={vi.fn()} live {...extra} />);

  it("本机的工具调用带 description（执行方写给人看的那句）：折进步骤里", () => {
    const at = "2026-11-16T02:00:00Z";
    const view = foldEvents([
      { seq: 1, at, type: "tool_call", toolUseId: "a", name: "Bash", title: "运行 pnpm test", input: { command: "pnpm test", description: "看方案 A 测试具体哪一行没过" } },
      { seq: 2, at, type: "tool_call", toolUseId: "b", name: "Read", title: "读文件 a.ts", input: { file_path: "a.ts" } },
    ] as unknown as TLocalSessionEvent[]);
    const steps = view.entries.filter((entry) => entry.kind === "step");
    expect(steps.map((entry) => entry.kind === "step" && entry.description)).toEqual(["看方案 A 测试具体哪一行没过", undefined]);
  });

  it("在跑的那一段：字符动画 + 当前那一步的 description（没有就写标题）+ 这一轮的用时 + ›", () => {
    const html = render([{ kind: "user", seq: 1, at: since(80), text: "跑一下" }, step(2, "读文件 a.ts", since(70)), step(3, "运行 pnpm test", since(60), false, "看方案 A 测试具体哪一行没过")]);
    expect(html).toMatch(/class="[^"]*_activity_/);
    expect(html).toMatch(/role="img"[^>]*aria-label="进行中"/);
    expect(text(html)).toMatch(/\|看方案 A 测试具体哪一行没过\|1 分 20 秒\|/);
    expect(html).toContain('aria-label="看方案 A 测试具体哪一行没过，展开"');
    // 点开还是这一段一步一行（标题），不重复画一行在跑。
    expect(text(html)).toContain("|读文件 a.ts|运行 pnpm test|");
    expect(html).not.toContain("session-working");
  });

  it("两步之间在想：最下面一行写计划里在做的那条；写回答的草稿时也在（这一轮还没完）", () => {
    const thinking: SessionEntry[] = [{ kind: "user", seq: 1, at: since(5), text: "接着做" }];
    const html = render(thinking, { plan });
    expect(html).toMatch(/data-testid="session-working"><span[^>]*aria-label="在跑"/);
    expect(text(html)).toContain("|调查实现|5 秒|");
    const drafting = render(thinking, { plan, draft: "好，按你说的改" });
    expect(drafting.indexOf("session-working")).toBeGreaterThan(drafting.indexOf("session-draft"));
  });
});

describe("伙伴对话、项目对话：「在做什么」写哪句（写在页头的状态胶囊里）", () => {
  const data = (extra: Partial<ConversationData>) => ({
    scope: "global", messages: [{ sequence: 1, role: "user", content: "帮我排一下" }], partial: "", streaming: true, thinking: true, stage: "thinking",
    startedAt: Date.now() - 12_000, steps: [], send: vi.fn(), rescope: vi.fn(), stop: vi.fn(), ...extra,
  }) as unknown as ConversationData;
  const render = (extra: Partial<ConversationData>) => renderToStaticMarkup(<WorkTimeline data={data(extra)} blocks={[]} />);

  it("那句话按 Claude 的先后：连不上 > 在跑的那一步 > 在查什么 > 计划里在做的 > 阶段词", () => {
    const steps = [{ id: "1", label: "读本月目标", status: "done" as const }, { id: "2", label: "对一下日程", status: "active" as const }];
    const buddyPlan = { entries: plan, collapsed: false };
    expect(conversationDoing({ stage: "offline", steps, progress: undefined, plan: buddyPlan })).toBe("等待网络");
    expect(conversationDoing({ stage: "researching", steps, progress: { label: "查日程", thought: null, checked: 0 }, plan: buddyPlan })).toBe("对一下日程");
    expect(conversationDoing({ stage: "researching", steps: [], progress: { label: "查日程", thought: null, checked: 0 }, plan: buddyPlan })).toBe("查日程");
    expect(conversationDoing({ stage: "thinking", steps: [], progress: undefined, plan: buddyPlan })).toBe("调查实现");
    expect(conversationDoing({ stage: "answering", steps: [], progress: undefined, plan: null })).toBe("正在整理回答");
    expect(conversationDoing({ stage: "thinking", steps: [], progress: undefined, plan: null })).toBeNull();
  });

  it("「在做什么」不在对话里", () => {
    // 挪进页头的状态胶囊（设计 6.3.1）；计划清单还在这一轮下面，原来那一行的阶段和用时也不另画。
    const html = render({ plan: { entries: plan, collapsed: false }, steps: [{ id: "1", label: "读本月目标", status: "active" }] });
    expect(html).toContain("plan-checklist");
    expect(html).not.toContain("activity-line");
    expect(html).not.toContain('data-testid="conversation-thinking"');
    expect(text(html)).not.toContain("读本月目标");
    expect(render({})).not.toContain("activity-line");
  });
});
