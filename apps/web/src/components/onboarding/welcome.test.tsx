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

import { WorkSnapshot, WelcomeFlow, monthTargetCopy, onboardingSteps, radarSummaryLine, type OnboardingData } from "./WelcomeFlow";
import { WorkspaceSchematic } from "./WorkspaceSchematic";
import { MissionFlow } from "./MissionFlow";
import { OnboardingProgress } from "./OnboardingProgress";
import { RadarSettingsEditor, type RadarSavedSummary } from "@/components/radar/RadarSettingsEditor";
import { browserApi } from "@/lib/api/client";

const base = { displayName: "测试", companyName: null, voiceprint: { configured: false, enrolled: false, updatedAt: null }, next: { text: "可以开始工作", action: "进入工作台", href: "/me" } };
const member: Extract<OnboardingData, { role: "member" }> = { ...base, role: "member", radar: { configured: false, enabled: false, directions: 0 }, work: { period: "2026-10", planStatus: "none", battlefields: [], missions: [], missionCards: [] } };
// CEO 的雷达就是公司雷达，不能关闭（enabled 恒为 true）。
const ceo: Extract<OnboardingData, { role: "ceo" }> = { ...base, role: "ceo", radar: { configured: false, enabled: true, directions: 0 }, company: { sixMonthGoal: "", battlefields: [], capabilities: [], people: [] } };
const missionCard = {
  cardId: "my-card", roundId: "my-round", period: "2026-10", battlefieldId: "bf", battlefieldName: "灯塔项目",
  phase: "open" as const, status: "草稿 · 讨论中", closesAt: "2026-10-03T10:00:00.000Z", serverNow: "2026-10-01T10:00:00.000Z",
  missionCount: 2, placeholder: true, href: "/me/mission-cards/my-card",
};

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
type RadarEditorProps = { mode: "person" | "company"; submitLabel?: string; onSaved?: (summary: RadarSavedSummary) => void; onLater?: () => void; actionsTarget?: unknown };
function radarEditor(tree: ReactNode) {
  const match = elements(tree).find((element) => element.type === RadarSettingsEditor);
  expect(match, "雷达这一步应嵌入共享的雷达设置编辑器").toBeDefined();
  return match!.props as unknown as RadarEditorProps;
}
function reachRadar(data: OnboardingData, nextPath?: string) {
  for (let index = 0; index < onboardingSteps(data).indexOf("radar"); index++) {
    (button(renderFlow(data, nextPath), index === 0 ? "开始" : "下一步").props.onClick as () => void)();
  }
  return renderFlow(data, nextPath);
}
/** 雷达这一步由编辑器负责前进：默认按「稍后」跳过；传 summary 时当作保存成功。 */
function reachFinish(data: OnboardingData, nextPath?: string, summary?: RadarSavedSummary) {
  const editor = radarEditor(reachRadar(data, nextPath));
  if (summary) editor.onSaved!(summary);
  else editor.onLater!();
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
  const memberMission = { ...member, next: { text: "10 月 Mission Card 讨论开放到 10/3 18:00", action: "查看我的 10 月卡", href: "/me/mission-cards/my-card" } };
  const ceoMission = { ...ceo, next: { text: "10 月个人卡草稿已就绪，可以统一开放讨论", action: "查看 10 月个人卡", href: "/mission-cards/first-card" } };
  it.each([
    { name: "CEO 默认首页", data: ceoNext, nextPath: "/", label: "核对 9 月目标", destination: "/plans/2026-09" },
    { name: "成员默认首页", data: memberNext, nextPath: "/me", label: "查看我的执行事项", destination: "/me/tasks/task-1" },
    { name: "无 next", data: ceoNext, nextPath: undefined, label: "核对 9 月目标", destination: "/plans/2026-09" },
    { name: "CEO 真原链接", data: ceoNext, nextPath: "/radar?tab=all#new", label: "继续刚才的页面", destination: "/radar?tab=all#new" },
    { name: "成员真原链接", data: memberNext, nextPath: "/me/tasks/task-2", label: "继续刚才的页面", destination: "/me/tasks/task-2" },
    { name: "无效外链", data: ceoNext, nextPath: "https://example.com/", label: "核对 9 月目标", destination: "/plans/2026-09" },
    { name: "无效跨角色链接", data: memberNext, nextPath: "/plans/2026-09", label: "查看我的执行事项", destination: "/me/tasks/task-1" },
    { name: "无效引导循环", data: ceoNext, nextPath: "/welcome", label: "核对 9 月目标", destination: "/plans/2026-09" },
    { name: "成员本轮个人卡", data: memberMission, nextPath: "/me", label: "查看我的 10 月卡", destination: "/me/mission-cards/my-card" },
    { name: "CEO 本轮个人卡", data: ceoMission, nextPath: "/", label: "查看 10 月个人卡", destination: "/mission-cards/first-card" },
    { name: "CEO 整理入口", data: { ...ceoMission, next: { text: "10 月目标已签发，可以整理个人卡草稿", action: "整理 10 月个人卡", href: "/?missionRoundDraft=01%3A2026-10" } }, nextPath: "/", label: "整理 10 月个人卡", destination: "/?missionRoundDraft=01%3A2026-10&_entry=unlock" },
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
  it("成员先导览、再看 Mission 和本月工作；CEO 步骤保持原样", () => {
    expect(onboardingSteps(member)).toEqual(["hello", "tour-notifications", "tour-board", "mission-flow", "work", "radar", "start"]);
    expect(onboardingSteps({ ...member, voiceprint: { ...base.voiceprint, configured: true } })).toEqual(["hello", "tour-notifications", "tour-board", "mission-flow", "work", "radar", "voiceprint", "start"]);
    expect(onboardingSteps(ceo)).toEqual(["hello", "tour-notifications", "tour-board", "radar", "start"]);
    expect(onboardingSteps({ ...ceo, voiceprint: { ...base.voiceprint, configured: true } })).toEqual(["hello", "tour-notifications", "tour-board", "radar", "voiceprint", "start"]);
  });
  it("成员导览复用同一示意图，高亮通知后转向工作", () => {
    let tree = renderFlow(member);
    expect(text(tree)).toContain("先花一分钟看看工作台，再看看每个月的 Mission 怎么定下来。");
    (button(tree, "开始").props.onClick as () => void)();
    tree = renderFlow(member);
    expect(text(tree)).toContain("左边是通知栏");
    expect(text(tree)).toContain("最上面是通知");
    expect(elements(tree).find((element) => element.type === WorkspaceSchematic)?.props).toMatchObject({ role: "member", focus: "notifications" });
    (button(tree, "下一步").props.onClick as () => void)();
    tree = renderFlow(member);
    expect(text(tree)).toContain("右边是你的工作");
    expect(text(tree)).toContain("往下是你的工作");
    expect(elements(tree).find((element) => element.type === WorkspaceSchematic)?.props).toMatchObject({ role: "member", focus: "board" });
    const diagram = renderToStaticMarkup(<WorkspaceSchematic role="member" focus="board" />);
    for (const label of ["新的执行事项", "执行事项", "+", "等上一步", "我的 Agent"]) expect(diagram).toContain(label);
  });
  it("Mission 六步按顺序呈现，之后才能看本月工作，也能返回", () => {
    let tree = renderFlow(member);
    for (let index = 0; index < 3; index++) {
      (button(tree, index === 0 ? "开始" : "下一步").props.onClick as () => void)();
      tree = renderFlow(member);
    }
    expect(text(tree)).toContain("每个月的 Mission，这样定下来");
    expect(elements(tree).find((element) => element.type === MissionFlow)).toBeDefined();
    const diagram = renderToStaticMarkup(<MissionFlow />);
    expect(diagram.match(/<li\b/g)).toHaveLength(6);
    const titles = ["本月目标", "个人卡草稿", "48 小时讨论", "集中处理", "确定", "拆成执行事项"];
    let position = -1;
    for (const title of titles) {
      const next = diagram.indexOf(`<strong>${title}</strong>`);
      expect(next).toBeGreaterThan(position);
      position = next;
    }
    expect(diagram.slice(diagram.indexOf("之后 · 你来推进"))).toContain("拆成执行事项");
    (button(tree, "下一步").props.onClick as () => void)();
    tree = renderFlow(member);
    expect(text(tree)).toContain("你这个月的工作");
    (button(tree, "上一步").props.onClick as () => void)();
    expect(text(renderFlow(member))).toContain("每个月的 Mission，这样定下来");
  });
  it("空态只说没有登记，不推断没有工作", () => {
    const html = renderToStaticMarkup(<WorkSnapshot data={member} />);
    expect(html).toContain("这个月还没有登记你参与的战场");
    expect(html).toContain("这个月还没有登记你的 Mission");
    expect(html).not.toContain("没有工作");
  });
  it("CEO 两页导览各高亮对应区域，文案说明打开、返回和 Agent", () => {
    let tree = renderFlow(ceo);
    expect(text(tree)).toContain("先花一分钟看看工作台。");
    expect(text(tree)).not.toContain("我先带你看看这个月和你有关的工作");
    (button(tree, "开始").props.onClick as () => void)();
    tree = renderFlow(ceo);
    expect(text(tree)).toContain("左边是通知栏");
    expect(text(tree)).toContain("点开一条，右边展开详情；看完关掉，回到原处。");
    expect(elements(tree).find((element) => element.type === WorkspaceSchematic)?.props).toMatchObject({ role: "ceo", focus: "notifications" });
    (button(tree, "下一步").props.onClick as () => void)();
    tree = renderFlow(ceo);
    expect(text(tree)).toContain("右边是公司全局");
    expect(text(tree)).toContain("底部是你的 Agent：问公司的事，它查了再答。");
    expect(text(tree)).toContain("详情全屏展开，左上角返回");
    expect(elements(tree).find((element) => element.type === WorkspaceSchematic)?.props).toMatchObject({ role: "ceo", focus: "board" });
    expect(text(tree)).not.toContain("这是天枢里登记的");
    (button(tree, "上一步").props.onClick as () => void)();
    expect(elements(renderFlow(ceo)).find((element) => element.type === WorkspaceSchematic)?.props).toMatchObject({ focus: "notifications" });
    const diagram = renderToStaticMarkup(<WorkspaceSchematic role="ceo" focus="notifications" />);
    expect(diagram).toContain('data-region="notifications"');
    expect(diagram).toContain('data-region="board"');
    expect(diagram).toContain("战略决策更新");
    expect(diagram).toContain("公司战略议题");
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
  it("先读目标和本月卡状态，再展开具体 Mission；多个战场的归属仍可辨认", () => {
    const data = { ...member, work: { ...member.work, planStatus: "confirmed" as const,
      battlefields: [{ id: "bf", name: "灯塔项目", monthTarget: "完成客户验证" }, { id: "bf2", name: "另一战场", monthTarget: "第二项月度目标" }],
      missionCards: [missionCard],
      missions: [{ id: "m1", code: "m1", title: "首项具体工作", battlefieldIds: ["bf"] }, { id: "m2", code: "m2", title: "另一项具体工作", battlefieldIds: ["bf2"] }, { id: "m3", code: "m3", title: "未关联具体工作", battlefieldIds: [] }],
    } };
    const html = renderToStaticMarkup(<WorkSnapshot data={data} />);
    expect(html.indexOf("第二项月度目标")).toBeLessThan(html.indexOf("我的本月卡"));
    expect(html.indexOf("10/3 18:00 截止")).toBeLessThan(html.indexOf("首项具体工作"));
    expect(html).toContain("另一项具体工作");
    expect(html).toContain("未关联具体工作");
    const details = html.slice(html.indexOf("我的 Mission"));
    expect(details).toContain("灯塔项目");
    expect(details).toContain("另一战场");
  });
  it.each([
    { phase: "draft", status: "草稿", closesAt: null, deadline: "本轮未开放" },
    { phase: "open", status: "草稿 · 讨论中", closesAt: missionCard.closesAt, deadline: "10/3 18:00 截止" },
    { phase: "closed", status: "草稿 · 已截止，待汇总", closesAt: missionCard.closesAt, deadline: "讨论截止于 10/3 18:00" },
    { phase: "reviewing", status: "候选版本 · 等刘明华拍板", closesAt: missionCard.closesAt, deadline: "讨论截止于 10/3 18:00" },
    { phase: "confirmed", status: "已确定 · 刘明华 10/4 18:00", closesAt: missionCard.closesAt, deadline: "讨论截止于 10/3 18:00" },
  ] as const)("我的本月卡在 $phase 阶段保留服务端状态与公司时区的截止", ({ phase, status, closesAt, deadline }) => {
    const data = { ...member, work: { ...member.work, missionCards: [{ ...missionCard, phase, status, closesAt }] } };
    const html = renderToStaticMarkup(<WorkSnapshot data={data} />);
    expect(html).toContain("我的本月卡");
    expect(html).toContain("10 月 Mission Card");
    expect(html).toContain(status);
    expect(html).toContain(deadline);
    expect(html).toContain("灯塔项目 · 2 项个人任务");
    expect(html).toContain("占位");
    expect(html).not.toContain("这个月还没有你的卡");
  });
  it("没有本月卡时清楚说明入口稍后出现；有多战场卡时逐张展示", () => {
    const empty = renderToStaticMarkup(<WorkSnapshot data={{ ...member, work: { ...member.work, missionCards: [] } }} />);
    expect(empty).toContain("这个月还没有你的卡；定下来之后，会出现在首页。");
    const data = { ...member, work: { ...member.work, missionCards: [missionCard, { ...missionCard, cardId: "other-card", battlefieldName: "另一战场", placeholder: false }] } };
    const html = renderToStaticMarkup(<WorkSnapshot data={data} />);
    expect(html).toContain("灯塔项目 · 2 项个人任务");
    expect(html).toContain("另一战场 · 2 项个人任务");
    expect(html.match(/>占位</g)).toHaveLength(1);
  });
  it("服务端首屏包含问候与晨光，胶囊不可操作；读屏进度有文本", () => {
    const html = renderToStaticMarkup(<WelcomeFlow data={member} />);
    expect(html).toContain("你好，测试");
    expect(html).toContain("欢迎使用天枢。");
    expect(html).not.toContain("我是你的 Co-Agent");
    expect(html).toContain("先进入工作台");
    expect(html).toContain("data-morning-canvas");
    expect(html).not.toContain("声纹，可以现在录");
    expect(renderToStaticMarkup(<OnboardingProgress current={2} total={3} />)).toContain("第 2 步，共 3 步");
  });
  it("第 1 步照 spec 说雷达和声纹都可以稍后；声纹没开通时只说雷达", () => {
    expect(renderToStaticMarkup(<WelcomeFlow data={member} />)).toContain("先花一分钟看看工作台，再看看每个月的 Mission 怎么定下来。<br/>雷达，可以现在设，也可以以后再说。");
    const withVoice = renderToStaticMarkup(<WelcomeFlow data={{ ...member, voiceprint: { ...base.voiceprint, configured: true } }} />);
    expect(withVoice).toContain("雷达和声纹，可以现在设，也可以以后再说。");
  });
});

describe("雷达步骤", () => {
  it("成员：标题问关注哪些变化，嵌本人雷达编辑器；主按钮与「稍后」由编辑器放进底栏，不再有引导自己的「下一步」", () => {
    const tree = reachRadar(member);
    expect(text(tree)).toContain("你想关注哪些变化？");
    const editor = radarEditor(tree);
    expect(editor).toMatchObject({ mode: "person", submitLabel: "保存并继续" });
    expect(editor.onLater).toBeTypeOf("function");
    expect(editor.actionsTarget).toBeDefined();
    const footerButtons = elements(tree).filter((element) => element.type === "button").map((element) => text(element.props.children as ReactNode));
    expect(footerButtons).not.toContain("下一步");
    expect(footerButtons).toContain("上一步");
  });
  it("CEO：写明按签发的本月目标自动关注，编辑的是公司雷达", () => {
    const tree = reachRadar(ceo);
    expect(text(tree)).toContain("公司雷达，还要看什么？");
    expect(text(tree)).toContain("我会按你签发的本月目标自动关注；你还可以补充方向和来源。");
    expect(radarEditor(tree)).toMatchObject({ mode: "company", submitLabel: "保存并继续" });
  });
  it("结束页设置摘要加雷达一行：成员按开没开，CEO 按补充的方向数；本步保存后立刻换成新的", () => {
    expect(radarSummaryLine("member", { enabled: true, directions: 2 })).toBe("雷达 · 已开启");
    expect(radarSummaryLine("member", { enabled: false, directions: 0 })).toBe("雷达 · 未开启");
    expect(radarSummaryLine("ceo", { enabled: true, directions: 0 })).toBe("雷达 · 按本月目标自动关注");
    expect(radarSummaryLine("ceo", { enabled: true, directions: 3 })).toBe("雷达 · 已补充 3 个方向");
    expect(text(reachFinish(member))).toContain("雷达 · 未开启");
    hooks.reset();
    const saved = text(reachFinish(member, undefined, { enabled: true, directions: 1, sources: 0 }));
    expect(saved).toContain("雷达 · 已开启");
    expect(saved).toContain("都可以在个人菜单里改");
    expect(saved).not.toContain("声纹 ·");
    hooks.reset();
    expect(text(reachFinish(ceo))).toContain("雷达 · 按本月目标自动关注");
    hooks.reset();
    expect(text(reachFinish({ ...ceo, radar: { configured: true, enabled: true, directions: 2 } }))).toContain("雷达 · 已补充 2 个方向");
    hooks.reset();
    expect(text(reachFinish(ceo, undefined, { enabled: true, directions: 4, sources: 1 }))).toContain("雷达 · 已补充 4 个方向");
  });
});
