import { afterEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// 与锁屏事件回归相同：Node 中保留真实点击处理器，仅代替状态、ref 和 DOM effect。
const hooks = vi.hoisted(() => {
  let active = false;
  let slots: unknown[] = [];
  let cursor = 0;
  return {
    get active() { return active; },
    begin() { active = true; cursor = 0; },
    reset() { active = false; slots = []; cursor = 0; },
    useState<T>(initial: T | (() => T)) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === "function" ? (initial as () => T)() : initial;
      return [slots[index] as T, (value: T | ((previous: T) => T)) => {
        slots[index] = typeof value === "function" ? (value as (previous: T) => T)(slots[index] as T) : value;
      }] as const;
    },
    useRef<T>(initial: T) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index] as { current: T };
    },
  };
});
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return {
    ...react,
    useState: (initial?: unknown) => hooks.active ? hooks.useState(initial) : react.useState(initial),
    useRef: (...args: Parameters<typeof react.useRef>) => hooks.active ? hooks.useRef(args[0]) : react.useRef(...args),
    useCallback: (...args: Parameters<typeof react.useCallback>) => hooks.active ? args[0] : react.useCallback(...args),
    useEffect: (...args: Parameters<typeof react.useEffect>) => hooks.active ? undefined : react.useEffect(...args),
  };
});

import { CompanySnapshot, WorkSnapshot, WelcomeFlow, monthTargetCopy, onboardingSteps, type OnboardingData } from "./WelcomeFlow";
import { OnboardingProgress } from "./OnboardingProgress";
import { browserApi } from "@/lib/api/client";

const base = { displayName: "测试", companyName: null, voiceprint: { configured: false, enrolled: false, updatedAt: null }, next: { text: "可以开始工作", action: "进入工作台", href: "/me" } };
const member: Extract<OnboardingData, { role: "member" }> = { ...base, role: "member", work: { period: "2026-10", planStatus: "none", battlefields: [], missions: [] } };
const ceo: Extract<OnboardingData, { role: "ceo" }> = { ...base, role: "ceo", company: { sixMonthGoal: "", battlefields: [], capabilities: [], people: [] } };

type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement(node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children as ReactNode)];
}
function text(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  return isValidElement(node) ? text((node as Element).props.children as ReactNode) : "";
}
function button(tree: ReactNode, label: string) {
  const match = elements(tree).find((element) => element.type === "button" && text(element.props.children as ReactNode) === label);
  expect(match, `应显示「${label}」按钮`).toBeDefined();
  return match!;
}
function renderFlow(data: OnboardingData, nextPath?: string) {
  hooks.begin();
  return WelcomeFlow({ data, nextPath });
}
function reachFinish(data: OnboardingData, nextPath?: string) {
  (button(renderFlow(data, nextPath), "开始").props.onClick as () => void)();
  (button(renderFlow(data, nextPath), "下一步").props.onClick as () => void)();
  return renderFlow(data, nextPath);
}

afterEach(() => {
  hooks.reset();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("收尾按钮文案与实际落点一致", () => {
  const ceoNext = { ...ceo, next: { text: "9 月的目标等你核对和签发", action: "核对 9 月目标", href: "/plans/2026-09" } };
  const memberNext = { ...member, next: { text: "先处理你的执行事项", action: "查看我的执行事项", href: "/me/tasks/task-1" } };
  it.each([
    { name: "CEO 默认首页", data: ceoNext, nextPath: "/", label: "核对 9 月目标", destination: "/plans/2026-09" },
    { name: "成员默认首页", data: memberNext, nextPath: "/me", label: "查看我的执行事项", destination: "/me/tasks/task-1" },
    { name: "无 next", data: ceoNext, nextPath: undefined, label: "核对 9 月目标", destination: "/plans/2026-09" },
    { name: "CEO 真原链接", data: ceoNext, nextPath: "/radar?tab=all#new", label: "继续刚才的页面", destination: "/radar?tab=all#new" },
    { name: "成员真原链接", data: memberNext, nextPath: "/me/tasks/task-2", label: "继续刚才的页面", destination: "/me/tasks/task-2" },
    { name: "无效外链", data: ceoNext, nextPath: "https://example.com/", label: "核对 9 月目标", destination: "/plans/2026-09" },
    { name: "无效跨角色链接", data: memberNext, nextPath: "/plans/2026-09", label: "查看我的执行事项", destination: "/me/tasks/task-1" },
    { name: "无效引导循环", data: ceoNext, nextPath: "/welcome", label: "核对 9 月目标", destination: "/plans/2026-09" },
  ])("$name：点击写完完成记录，再去按钮承诺的页面", async ({ data, nextPath, label, destination }) => {
    const replace = vi.fn();
    vi.stubGlobal("window", { location: { replace } });
    const complete = vi.spyOn(browserApi, "POST").mockResolvedValue({ data: { onboarded: true }, response: new Response(null, { status: 200 }) });
    const tree = reachFinish(data, nextPath);
    expect(text(tree)).toContain(data.next.text);
    (button(tree, label).props.onClick as () => void)();
    expect(complete).toHaveBeenCalledExactlyOnceWith("/api/me/onboarding/complete");
    expect(replace).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(replace).toHaveBeenCalledExactlyOnceWith(destination));
  });
});

describe("真实数据的首次引导", () => {
  it("角色决定快照，声纹不可用时不占步骤，不包含未交付的雷达", () => {
    expect(onboardingSteps(member)).toEqual(["hello", "work", "start"]);
    expect(onboardingSteps({ ...ceo, voiceprint: { ...base.voiceprint, configured: true } })).toEqual(["hello", "company", "voiceprint", "start"]);
  });
  it("空态只说没有登记，不推断没有工作", () => {
    const html = renderToStaticMarkup(<WorkSnapshot data={member} />);
    expect(html).toContain("这个月还没有登记你参与的战场");
    expect(html).toContain("这个月还没有登记你的 Mission");
    expect(html).not.toContain("没有工作");
    expect(renderToStaticMarkup(<CompanySnapshot data={ceo} />)).toContain("公司的目标和战场还没登记");
  });
  it("目标的三种状态有独立文案，已签发但无对应目标仍说明缺失", () => {
    expect(monthTargetCopy("none", null)).toBe("本月目标还没出来");
    expect(monthTargetCopy("draft", null)).toBe("本月目标还在协商");
    expect(monthTargetCopy("negotiating", null)).toBe("本月目标还在协商");
    expect(monthTargetCopy("confirmed", "客户验证")).toBe("客户验证");
    expect(monthTargetCopy("confirmed", null)).toContain("还没有登记");
  });
  it("本人的 Mission 按战场列出三条并注明余数；未关联的也能看见", () => {
    const data = { ...member, work: { ...member.work, battlefields: [{ id: "bf", name: "灯塔", monthTarget: null }], missions: Array.from({ length: 5 }, (_, i) => ({ id: String(i), code: String(i), title: `结果${i}`, battlefieldIds: i === 4 ? [] : ["bf"] })) } };
    const html = renderToStaticMarkup(<WorkSnapshot data={data} />);
    expect(html).toContain("灯塔");
    expect(html).toContain("另 1 条");
    expect(html).not.toContain("结果3");
    expect(html).toContain("结果4");
  });
  it("服务端首屏包含问候与晨光，胶囊不可操作；读屏进度有文本", () => {
    const html = renderToStaticMarkup(<WelcomeFlow data={member} />);
    expect(html).toContain("你好，测试");
    expect(html).toContain("先进入工作台");
    expect(html).toContain("data-morning-canvas");
    expect(html).not.toContain("声纹，可以现在录");
    expect(renderToStaticMarkup(<OnboardingProgress current={2} total={3} />)).toContain("第 2 步，共 3 步");
  });
});
