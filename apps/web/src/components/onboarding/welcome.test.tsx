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

import { WelcomeFlow, onboardingSteps, radarSummaryLine, type OnboardingData } from "./WelcomeFlow";
import { WorkspaceSchematic } from "./WorkspaceSchematic";
import { MissionFlow } from "./MissionFlow";
import { OnboardingProgress } from "./OnboardingProgress";
import { RadarSettingsEditor, type RadarSavedSummary } from "@/components/radar/RadarSettingsEditor";
import { ConnectAgentForm } from "@/components/ConnectAgentForm";
import { DelegationPanel } from "./DelegationPanel";
import { browserApi } from "@/lib/api/client";
import { BuddyNameInput } from "@/components/buddy/BuddyPicker";
import { BuddyCarousel, BuddyFigure } from "./BuddyCarousel";
import { BUDDY_PERSONALITIES } from "@/components/buddy/PersonalityPicker";
import { PresenceCapsule } from "@/components/coagent/PresenceCapsule";
import { CoAgentCapsule } from "./CoAgentCapsule";

const base = { displayName: "测试", companyName: null, delegationStep: false, voiceprint: { configured: false, enrolled: false, updatedAt: null }, next: { text: "可以开始工作", action: "进入工作台", href: "/me" } };
const member: Extract<OnboardingData, { role: "member" }> = { ...base, role: "member", radar: { configured: false, enabled: false, directions: 0 }, work: { period: "2026-10", planStatus: "none", battlefields: [], missions: [], missionCards: [] } };
// CEO 的雷达就是公司雷达，不能关闭（enabled 恒为 true）。
const ceo: Extract<OnboardingData, { role: "ceo" }> = { ...base, role: "ceo", radar: { configured: false, enabled: true, directions: 0 }, company: { sixMonthGoal: "", battlefields: [], capabilities: [], people: [] } };

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
  // 雷达之后是「连接外部工具」：选「稍后」，进入结束页。
  (button(renderFlow(data, nextPath), "稍后").props.onClick as () => void)();
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
  it.each([
    { name: "CEO 默认首页", nextPath: "/", label: "进入工作台", destination: "/plans/2026-09" },
    { name: "CEO 无 next", nextPath: undefined, label: "进入工作台", destination: "/plans/2026-09" },
    { name: "CEO 真原链接", nextPath: "/radar?tab=all#new", label: "继续刚才的页面", destination: "/radar?tab=all#new" },
    { name: "CEO 无效外链", nextPath: "https://example.com/", label: "进入工作台", destination: "/plans/2026-09" },
    { name: "CEO 无效引导循环", nextPath: "/welcome", label: "进入工作台", destination: "/plans/2026-09" },
  ])("$name：CEO 看完三页直接进工作台，不再说本月目标待签发", async ({ nextPath, label, destination }) => {
    const replace = vi.fn();
    vi.stubGlobal("window", { location: { replace } });
    const complete = vi.spyOn(browserApi, "POST").mockResolvedValue({ data: { onboarded: true }, response: new Response(null, { status: 200 }) });
    (button(renderFlow(ceoNext, nextPath), "开始").props.onClick as () => void)();
    (button(renderFlow(ceoNext, nextPath), "下一步").props.onClick as () => void)();
    const tree = renderFlow(ceoNext, nextPath);
    expect(text(tree)).not.toContain(ceoNext.next.text);
    expect(text(tree)).not.toContain("先进入工作台");
    (button(tree, label).props.onClick as () => void)();
    expect(complete).toHaveBeenCalledExactlyOnceWith("/api/me/onboarding/complete");
    await vi.waitFor(() => expect(replace).toHaveBeenCalledExactlyOnceWith(destination));
  });
  it.each([
    { name: "成员默认首页", data: memberNext, nextPath: "/me", label: "查看我的执行事项", destination: "/me/tasks/task-1" },
    { name: "成员真原链接", data: memberNext, nextPath: "/me/tasks/task-2", label: "继续刚才的页面", destination: "/me/tasks/task-2" },
    { name: "无效跨角色链接", data: memberNext, nextPath: "/plans/2026-09", label: "查看我的执行事项", destination: "/me/tasks/task-1" },
    { name: "成员本轮任务卡", data: memberMission, nextPath: "/me", label: "查看我的 10 月卡", destination: "/me/mission-cards/my-card" },
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
  it("成员先导览、再看 Mission 怎么定下来；CEO 只看工作台三页", () => {
    const tail = ["connect", "start"];
    expect(onboardingSteps(member)).toEqual(["hello", "tour-notifications", "tour-board", "mission-flow", "radar", ...tail]);
    expect(onboardingSteps({ ...member, voiceprint: { ...base.voiceprint, configured: true } })).toEqual(["hello", "tour-notifications", "tour-board", "mission-flow", "radar", "voiceprint", ...tail]);
    expect(onboardingSteps(ceo)).toEqual(["hello", "tour-notifications", "tour-board"]);
    expect(onboardingSteps({ ...ceo, voiceprint: { ...base.voiceprint, configured: true }, delegationStep: true })).toEqual(["hello", "tour-notifications", "tour-board"]);
    // 委托授权这一步由配置打开，放在结束页之前。
    expect(onboardingSteps({ ...member, delegationStep: true }).slice(-3)).toEqual(["connect", "delegation", "start"]);
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
    // 首页第六版：顶行月历 · Mission · 快捷，下面 Mission 详情（Task、三栏），再下面最近进展。
    for (const copy of ["日历、你的 Mission 和约会议、等回复", "Task 和执行事项，分已完成、本周、之后三栏", "最近进展"]) expect(text(tree)).toContain(copy);
    for (const gone of ["参与的战场", "本月任务卡", "执行事项点「+」", "最上面一行"]) expect(text(tree)).not.toContain(gone);
    expect(elements(tree).find((element) => element.type === WorkspaceSchematic)?.props).toMatchObject({ role: "member", focus: "board" });
    const diagram = renderToStaticMarkup(<WorkspaceSchematic role="member" focus="board" />);
    for (const label of ["新的执行事项", "10 月", "Mission", "全部", "约会议", "等回复", "战场进展", "雷达", "已完成", "本周", "之后", "+", "最近进展", "我的 Agent"]) expect(diagram).toContain(label);
    // 和首页同序：顶行月历、Mission、快捷，下面详情（Task 列在三栏左边），再下面最近进展。
    const at = (name: string) => diagram.indexOf(`_${name}_`);
    const order = [at("miniCalendar"), at("miniMissions"), at("miniQuick"), at("taskColumn"), at("columns"), at("progressCard")];
    expect(order.every((index) => index > -1)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    for (const gone of ["我的本月卡", "参与的战场", "等你验收", "_days_", "_missionRow_", "我的工作台"]) expect(diagram).not.toContain(gone);
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
    const titles = ["本月目标", "任务卡草稿", "本人确认", "统一核对", "DRI 确认", "拆成执行事项"];
    let position = -1;
    for (const title of titles) {
      const next = diagram.indexOf(`<strong>${title}</strong>`);
      expect(next).toBeGreaterThan(position);
      position = next;
    }
    expect(diagram.slice(diagram.indexOf("之后 · 你来推进"))).toContain("拆成执行事项");
    (button(tree, "下一步").props.onClick as () => void)();
    tree = renderFlow(member);
    expect(text(tree)).toContain("你想关注哪些变化？");
    (button(tree, "上一步").props.onClick as () => void)();
    expect(text(renderFlow(member))).toContain("每个月的 Mission，这样定下来");
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
    expect(text(tree)).toContain("底部是你的 Agent：问公司的事，它查了再答；要约会议，也直接跟它说。");
    // 手机首页是一条滚动：通知下面就是公司全局；详情铺满屏幕，返回在左上角。
    expect(text(tree)).toContain("往下是公司全局");
    expect(text(tree)).toContain("详情铺满屏幕，左上角返回");
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
  it("服务端首屏包含问候、实心底（不画晨光），胶囊不可操作；读屏进度有文本", () => {
    const html = renderToStaticMarkup(<WelcomeFlow data={member} />);
    expect(html).toContain("你好，测试");
    expect(html).toContain("欢迎使用天枢。");
    expect(html).not.toContain("我是你的 Co-Agent");
    expect(html).toContain("先进入工作台");
    // 新首页的样子：实心底、不画晨光。后面的旧步骤还是写死的浅色，整段引导先不开深色。
    expect(html).not.toContain("data-morning-canvas");
    expect(html).toContain(`data-scheme="light"`);
    expect(html).not.toContain("声纹，可以现在录");
    expect(renderToStaticMarkup(<OnboardingProgress current={2} total={3} />)).toContain("第 2 步，共 3 步");
  });
  it("第 1 步照 spec 说雷达和声纹都可以稍后；声纹没开通时只说雷达", () => {
    expect(renderToStaticMarkup(<WelcomeFlow data={member} />)).toContain("先花一分钟看看工作台，再看看每个月的 Mission 怎么定下来。<br/>雷达和外部工具，可以现在设，也可以以后再说。");
    const withVoice = renderToStaticMarkup(<WelcomeFlow data={{ ...member, voiceprint: { ...base.voiceprint, configured: true } }} />);
    expect(withVoice).toContain("雷达、声纹和外部工具，可以现在设，也可以以后再说。");
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
  it("结束页设置摘要加雷达一行：按开没开；本步保存后立刻换成新的", () => {
    expect(radarSummaryLine({ enabled: true })).toBe("雷达 · 已开启");
    expect(radarSummaryLine({ enabled: false })).toBe("雷达 · 未开启");
    const skipped = text(reachFinish(member));
    expect(skipped).toContain("雷达 · 未开启");
    expect(skipped).toContain("外部工具 · 稍后在个人菜单里连");
    hooks.reset();
    const saved = text(reachFinish(member, undefined, { enabled: true, directions: 1, sources: 0 }));
    expect(saved).toContain("雷达 · 已开启");
    expect(saved).toContain("都可以在个人菜单里改");
    expect(saved).not.toContain("声纹 ·");
  });
  it("连接外部工具在雷达之后、结束之前：同一张表单预填名字，主按钮放进底栏（不再是「下一步」），可以「稍后」跳过", () => {
    radarEditor(reachRadar(member)).onLater!();
    const tree = renderFlow(member);
    expect(text(tree)).toContain("连上你自己的 AI 工具");
    const form = elements(tree).find((element) => element.type === ConnectAgentForm);
    expect(form?.props).toMatchObject({ role: "member", defaultName: "我的电脑" });
    expect(elements(tree).find((element) => element.type === "button" && text(element.props.children as ReactNode) === "下一步")).toBeUndefined();
    expect(button(tree, "稍后")).toBeDefined();
  });
  it("连上 AI 工具之后直接到最后一页（本机采集器已下线，没有安装、扫描和确认清单），结束页也不再提采集器", () => {
    radarEditor(reachRadar(member)).onLater!();
    (button(renderFlow(member), "稍后").props.onClick as () => void)();
    const end = renderFlow(member);
    expect(text(end)).toContain("可以开始了");
    expect(text(end)).not.toContain("采集器");
  });
  it("委托授权一步只在配置打开时出现，排在连上 AI 工具之后", () => {
    const flagged = { ...member, delegationStep: true };
    radarEditor(reachRadar(flagged)).onLater!();
    (button(renderFlow(flagged), "稍后").props.onClick as () => void)();
    const delegation = renderFlow(flagged);
    expect(text(delegation)).toContain("授权天枢替你记进本体");
    expect(elements(delegation).some((element) => element.type === DelegationPanel)).toBe(true);
    expect(button(delegation, "稍后")).toBeDefined();
  });
});

describe("选择你的伙伴（设计稿 17.1）", () => {
  const flow = (data: OnboardingData, options: { nextPath?: string; buddyOnly?: boolean } = {}) => {
    hooks.begin();
    return WelcomeFlow({ data, nextPath: options.nextPath, buddy: null, buddyOnly: options.buddyOnly });
  };
  /** 减少动态效果：「选定」直接翻页，不等那一下动效。 */
  const stubWindow = (extra: object = {}) => vi.stubGlobal("window", Object.assign(new EventTarget(), { matchMedia: () => ({ matches: true }) }, extra));
  /** 两个 PUT：授权（/api/me/buddy-authority）存上返回 full；伙伴（/api/me/buddy）按传进来的结果。 */
  const mockPut = (buddy: { data?: unknown; error?: unknown; status?: number } = { data: { name: "团团", form: "panda", personality: "steady" } }) =>
    vi.spyOn(browserApi, "PUT").mockImplementation((async (path: string) => path === "/api/me/buddy-authority"
      ? { data: { authority: "full", grantedAt: "2026-11-08T08:00:00.000Z" }, response: new Response(null, { status: 200 }) }
      : { data: buddy.data, error: buddy.error, response: new Response(null, { status: buddy.status ?? 200 }) }) as never);
  const carousel = (tree: ReactNode) => {
    const match = elements(tree).find((element) => element.type === BuddyCarousel);
    expect(match, "应有左右切换的选择").toBeDefined();
    return match!.props as unknown as { kind: string; value: string; items: { id: string }[]; sealing: boolean; onChange: (next: string) => void };
  };
  const nameInput = (tree: ReactNode) => {
    const match = elements(tree).find((element) => element.type === BuddyNameInput);
    expect(match, "起名字这一页应有伙伴的名字框").toBeDefined();
    return match!.props as unknown as { value: string; onChange: (name: string) => void; onEnter: () => void };
  };
  const progress = (tree: ReactNode) => elements(tree).find((element) => element.type === OnboardingProgress)?.props;
  const figure = (tree: ReactNode) => elements(tree).find((element) => element.type === BuddyFigure && element.props.size === "hero")?.props;
  const press = (tree: ReactNode, label: string) => (button(tree, label).props.onClick as () => void)();
  /** 授权页点「同意」，等授权存上、翻到起名字。 */
  const agree = async (data: OnboardingData, options: { nextPath?: string; buddyOnly?: boolean } = {}) => {
    press(flow(data, options), "同意");
    await vi.waitFor(() => expect(text(flow(data, options))).toContain("给伙伴起个名字"));
  };

  it("还没有伙伴时四页排在最前面（选形象 → 选性格 → 授权 → 起名字），CEO 和成员都走；已经引导过的只走这四页；有伙伴的不走", () => {
    const buddySteps = ["buddy-form", "buddy-personality", "buddy-consent", "buddy-name"];
    expect(onboardingSteps(ceo, "first")).toEqual([...buddySteps, "hello", "tour-notifications", "tour-board"]);
    expect(onboardingSteps(member, "first").slice(0, 5)).toEqual([...buddySteps, "hello"]);
    expect(onboardingSteps(member, "only")).toEqual(buddySteps);
    expect(onboardingSteps(member)[0]).toBe("hello");
    hooks.begin();
    expect(elements(WelcomeFlow({ data: ceo, buddy: { name: "团团", form: "panda" } })).some((element) => element.type === BuddyCarousel)).toBe(false);
  });

  it("步骤点一页一个：只差伙伴的人底下是 4 个点、一页往前走一个（回归：原来四页只算 1 步，只剩一颗拉长的当前点）", async () => {
    stubWindow();
    mockPut();
    const options = { buddyOnly: true };
    expect(progress(flow(ceo, options))).toMatchObject({ current: 1, total: 4 });
    // 只有伙伴四页：深色跟系统。
    expect(elements(flow(ceo, options))[0].props["data-scheme"]).toBe("auto");
    press(flow(ceo, options), "选定");
    expect(progress(flow(ceo, options))).toMatchObject({ current: 2, total: 4 });
    press(flow(ceo, options), "选定");
    expect(progress(flow(ceo, options))).toMatchObject({ current: 3, total: 4 });
    await agree(ceo, options);
    expect(progress(flow(ceo, options))).toMatchObject({ current: 4, total: 4 });
    const markup = renderToStaticMarkup(OnboardingProgress({ current: 2, total: 4 }));
    expect(markup).toContain("第 2 步，共 4 步");
    expect(markup.match(/data-current=/g)).toHaveLength(4);
    // 第一次引导：伙伴四页之后接着原来的步骤，总数一起算。
    hooks.reset();
    expect(progress(flow(member))).toMatchObject({ current: 1, total: 4 + onboardingSteps(member).length });
  });

  it("选形象：一次一个、左右切换（首尾相接），没有「在听 / 在说」，没有「先进入工作台」和「上一步」", () => {
    const tree = flow(ceo);
    expect(text(tree)).toContain("选择你的伙伴");
    expect(text(tree)).not.toContain("在听");
    expect(text(tree)).not.toContain("先进入工作台");
    expect(elements(tree).some((element) => element.type === "button" && text(element.props.children as ReactNode) === "上一步")).toBe(false);
    expect(carousel(tree)).toMatchObject({ kind: "figure", value: "classic", sealing: false });
    expect(carousel(tree).items.map((item) => item.id)).toEqual(["classic", "alive", "panda", "miles", "cmei"]);
    carousel(tree).onChange("miles");
    expect(carousel(flow(ceo)).value).toBe("miles");

    hooks.reset(); hooks.begin();
    const onChange = vi.fn();
    const items = [{ id: "a", label: "A" }, { id: "b", label: "B" }, { id: "c", label: "C" }, { id: "d", label: "D" }, { id: "e", label: "E" }];
    const strip = BuddyCarousel({ items, value: "a", onChange, label: "形象", kind: "figure", children: (id) => id });
    const slides = elements(strip).filter((element) => element.props.role === "radio");
    expect(slides.map((slide) => [slide.props["aria-label"], slide.props["data-offset"]])).toEqual([["A", 0], ["B", 1], ["C", 2], ["D", -2], ["E", -1]]);
    (elements(strip).find((element) => element.props["aria-label"] === "上一个")!.props.onClick as () => void)();
    expect(onChange).toHaveBeenLastCalledWith("e");
    (elements(strip).find((element) => element.props["aria-label"] === "下一个")!.props.onClick as () => void)();
    expect(onChange).toHaveBeenLastCalledWith("b");
    (slides[4].props.onClick as () => void)();
    expect(onChange).toHaveBeenLastCalledWith("e");
  });

  it("「选定」那一下：两边退开、中间应一声，播完才翻到选性格；播的时候不能再按", () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal("window", Object.assign(new EventTarget(), { matchMedia: () => ({ matches: false }) }));
      press(flow(ceo), "选定");
      let tree = flow(ceo);
      expect(carousel(tree).sealing).toBe(true);
      expect(button(tree, "选定").props.disabled).toBe(true);
      vi.advanceTimersByTime(560);
      tree = flow(ceo);
      expect(text(tree)).toContain("选择性格");
    } finally {
      vi.useRealTimers();
    }
  });

  it("选性格是 11/08 定的四种（沉稳靠谱默认），每种显示「进度落后」那一句，不用表情", () => {
    stubWindow();
    press(flow(ceo), "选定");
    const tree = flow(ceo);
    expect(carousel(tree)).toMatchObject({ kind: "card", value: "steady" });
    expect(carousel(tree).items.map((item) => item.id)).toEqual(["steady", "direct", "warm", "coach"]);
    expect(BUDDY_PERSONALITIES.map((item) => item.label)).toEqual(["沉稳靠谱", "直言不讳", "温和体贴", "启发追问"]);
    expect(BUDDY_PERSONALITIES.find((item) => item.id === "steady")!.sample).toBe("全链路这条比计划晚两天。能先交的我拆出来了，周三前补齐，你看行不行。");
    for (const item of BUDDY_PERSONALITIES) expect(item.sample, item.label).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it("选性格 → 授权（同意就把授权存成 full）→ 起名字：台上一直是选好的形象；名字空着不能完成；存好再往下走", async () => {
    stubWindow();
    const put = mockPut();
    carousel(flow(ceo)).onChange("miles");
    press(flow(ceo), "选定");
    let tree = flow(ceo);
    expect(text(tree)).toContain("选择性格");
    expect(figure(tree)).toMatchObject({ skin: "miles", pose: "speaking" });
    carousel(tree).onChange("coach");
    press(flow(ceo), "选定");
    tree = flow(ceo);
    expect(text(tree)).toContain("伙伴可以替你做你能做的事");
    expect(button(tree, "稍后")).toBeDefined();
    expect(put).not.toHaveBeenCalled();
    await agree(ceo);
    expect(put).toHaveBeenCalledExactlyOnceWith("/api/me/buddy-authority", { body: { authority: "full" } });
    tree = flow(ceo);
    expect(nameInput(tree).value).toBe("");
    expect(button(tree, "完成").props.disabled).toBe(true);
    nameInput(tree).onEnter();
    expect(put).toHaveBeenCalledTimes(1);
    nameInput(tree).onChange(" 团团 ");
    tree = flow(ceo);
    expect(figure(tree)).toMatchObject({ skin: "miles", name: "团团", pose: "listening" });
    expect(button(tree, "完成").props.disabled).toBe(false);
    press(tree, "完成");
    await vi.waitFor(() => expect(text(flow(ceo))).toContain("你好，测试"));
    expect(put).toHaveBeenLastCalledWith("/api/me/buddy", { body: { name: "团团", form: "miles", personality: "coach" } });
  });

  it("授权可以「稍后」：不调接口（保持 none），直接到起名字；存不上就留在授权页并说明", async () => {
    stubWindow();
    let put = mockPut();
    press(flow(ceo), "选定");
    press(flow(ceo), "选定");
    press(flow(ceo), "稍后");
    expect(text(flow(ceo))).toContain("给伙伴起个名字");
    expect(put).not.toHaveBeenCalled();

    hooks.reset();
    put.mockRestore();
    put = vi.spyOn(browserApi, "PUT").mockResolvedValue({ data: undefined, error: { message: "授权没有存上" }, response: new Response(null, { status: 500 }) } as never);
    press(flow(ceo), "选定");
    press(flow(ceo), "选定");
    press(flow(ceo), "同意");
    await vi.waitFor(() => expect(text(flow(ceo))).toContain("授权没有存上"));
    expect(text(flow(ceo))).toContain("伙伴可以替你做你能做的事");
  });

  it("「上一步」一页页退回，选过的都留着", async () => {
    stubWindow();
    mockPut();
    carousel(flow(ceo)).onChange("panda");
    press(flow(ceo), "选定");
    carousel(flow(ceo)).onChange("direct");
    press(flow(ceo), "选定");
    await agree(ceo);
    nameInput(flow(ceo)).onChange("团团");
    press(flow(ceo), "上一步");
    expect(text(flow(ceo))).toContain("伙伴可以替你做你能做的事");
    press(flow(ceo), "上一步");
    expect(carousel(flow(ceo)).value).toBe("direct");
    press(flow(ceo), "上一步");
    expect(carousel(flow(ceo))).toMatchObject({ kind: "figure", value: "panda" });
  });

  it("伙伴几页之后的每一页，顶上一直是本人选的那颗（刚选的、以前选好的都算）；选的是默认那颗就还是原来的大胶囊", async () => {
    stubWindow();
    mockPut();
    carousel(flow(member)).onChange("panda");
    press(flow(member), "选定");
    press(flow(member), "选定");
    await agree(member);
    nameInput(flow(member)).onChange("团团");
    press(flow(member), "完成");
    await vi.waitFor(() => expect(text(flow(member))).toContain("你好，测试"));
    const hero = (tree: ReactNode) => elements(tree).find((element) => element.type === PresenceCapsule)?.props;
    expect(hero(flow(member))).toMatchObject({ skin: "panda", name: "团团", pose: "idle" });
    press(flow(member), "开始");
    expect(text(flow(member))).toContain("左边是通知栏");
    expect(hero(flow(member))).toMatchObject({ skin: "panda" });
    expect(elements(flow(member)).some((element) => element.type === CoAgentCapsule)).toBe(false);

    hooks.reset(); hooks.begin();
    expect(hero(WelcomeFlow({ data: member, buddy: { name: "Christopher", form: "miles" } }))).toMatchObject({ skin: "miles", name: "Christopher" });
    hooks.reset(); hooks.begin();
    const classic = WelcomeFlow({ data: member, buddy: { name: "小天", form: "classic" } });
    expect(hero(classic)).toBeUndefined();
    expect(elements(classic).some((element) => element.type === CoAgentCapsule)).toBe(true);
  });

  it("名字太长、多的字被截掉时，框下面写「名字已到最长」；输入法组字时不提示，组完被截才提示；删回放得下就消失", () => {
    const onChange = vi.fn();
    const render = () => { hooks.begin(); return BuddyNameInput({ value: "", onChange }); };
    const type = (value: string, isComposing = false) => {
      const input = elements(render()).find((element) => element.type === "input")!;
      (input.props.onChange as (event: unknown) => void)({ target: { value }, nativeEvent: { isComposing } });
    };
    const hint = () => text(render());
    expect(hint()).toBe("");
    type("Christopherrr");
    expect(onChange).toHaveBeenLastCalledWith("Christopher");
    expect(hint()).toBe("名字已到最长");
    expect(elements(render()).find((element) => element.props.role === "status")).toBeDefined();
    type("Christophe");
    expect(hint()).toBe("");
    type("一二三四五六七", true);
    expect(onChange).toHaveBeenLastCalledWith("一二三四五六七");
    expect(hint()).toBe("");
    const input = elements(render()).find((element) => element.type === "input")!;
    (input.props.onCompositionEnd as (event: unknown) => void)({ currentTarget: { value: "一二三四五六七" } });
    expect(onChange).toHaveBeenLastCalledWith("一二三四五六");
    expect(hint()).toBe("名字已到最长");
  });

  it("伙伴存不上就留在起名字这一页并说明，不往下走", async () => {
    stubWindow();
    mockPut({ data: undefined, error: { message: "伙伴要有名字" }, status: 400 });
    press(flow(ceo), "选定");
    press(flow(ceo), "选定");
    await agree(ceo);
    nameInput(flow(ceo)).onChange("团团");
    press(flow(ceo), "完成");
    await vi.waitFor(() => expect(text(flow(ceo))).toContain("伙伴要有名字"));
    expect(text(flow(ceo))).toContain("给伙伴起个名字");
  });

  it("已经引导过、只差伙伴的人：存好就回原来要去的页面，不再记一次引导完成", async () => {
    const replace = vi.fn();
    stubWindow({ location: { replace } });
    mockPut({ data: { name: "团团", form: "alive", personality: "steady" } });
    const complete = vi.spyOn(browserApi, "POST").mockResolvedValue({ data: undefined, response: new Response(null, { status: 204 }) } as never);
    const options = { nextPath: "/radar", buddyOnly: true };
    carousel(flow(ceo, options)).onChange("alive");
    press(flow(ceo, options), "选定");
    press(flow(ceo, options), "选定");
    await agree(ceo, options);
    nameInput(flow(ceo, options)).onChange("团团");
    press(flow(ceo, options), "完成");
    await vi.waitFor(() => expect(replace).toHaveBeenCalledExactlyOnceWith("/radar"));
    expect(complete).not.toHaveBeenCalledWith("/api/me/onboarding/complete");
  });
});
