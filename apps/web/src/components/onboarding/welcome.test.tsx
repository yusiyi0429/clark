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
import { ConnectAgentForm } from "@/components/ConnectAgentForm";
import { CollectorInstallPanel, collectorCommand, scanSteps, type CollectorStatus } from "./CollectorSetup";
import { DelegationPanel } from "./DelegationPanel";
import { revisedLabel, reviewEmpty, ReviewSummary, submitReview, type ReviewLists, type ReviewPicks } from "./ReviewLists";
import { MemoryImportPanel } from "./MemoryImportSlot";
import { CollectorConsentSwitch } from "./CollectorConsentSwitch";
import { browserApi } from "@/lib/api/client";
import { BuddyNameInput } from "@/components/buddy/BuddyPicker";
import { CoAgentSkinPicker } from "@/components/coagent/SkinPicker";
import { PresenceCapsule } from "@/components/coagent/PresenceCapsule";
import { CoAgentCapsule } from "./CoAgentCapsule";

const base = { displayName: "测试", companyName: null, delegationStep: false, voiceprint: { configured: false, enrolled: false, updatedAt: null }, next: { text: "可以开始工作", action: "进入工作台", href: "/me" } };
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
  // 雷达之后是「连接外部工具」「安装本机采集器」：都选「稍后」；扫描页和最后一页直接往下走，进入结束页。
  (button(renderFlow(data, nextPath), "稍后").props.onClick as () => void)();
  (button(renderFlow(data, nextPath), "稍后").props.onClick as () => void)();
  (button(renderFlow(data, nextPath), "下一步").props.onClick as () => void)();
  (button(renderFlow(data, nextPath), "完成").props.onClick as () => void)();
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
  it("成员先导览、再看 Mission 和本月工作；CEO 只看工作台三页", () => {
    const tail = ["connect", "collector", "scan", "review", "start"];
    expect(onboardingSteps(member)).toEqual(["hello", "tour-notifications", "tour-board", "mission-flow", "work", "radar", ...tail]);
    expect(onboardingSteps({ ...member, voiceprint: { ...base.voiceprint, configured: true } })).toEqual(["hello", "tour-notifications", "tour-board", "mission-flow", "work", "radar", "voiceprint", ...tail]);
    expect(onboardingSteps(ceo)).toEqual(["hello", "tour-notifications", "tour-board"]);
    expect(onboardingSteps({ ...ceo, voiceprint: { ...base.voiceprint, configured: true }, delegationStep: true })).toEqual(["hello", "tour-notifications", "tour-board"]);
    // 委托授权这一步由配置打开，放在结束页之前。
    expect(onboardingSteps({ ...member, delegationStep: true }).slice(-3)).toEqual(["review", "delegation", "start"]);
    // 扫完三项都没有可确认的：跳过确认清单。
    expect(onboardingSteps(member, true).slice(-3)).toEqual(["collector", "scan", "start"]);
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
  it("同意上传会话的开关从「连上 AI 工具」挪到「安装本机采集器」；没连上之前「下一步」不能点、可以「稍后」", () => {
    radarEditor(reachRadar(member)).onLater!();
    const connect = renderFlow(member);
    expect(elements(connect).some((element) => element.type === CollectorConsentSwitch)).toBe(false);
    (button(connect, "稍后").props.onClick as () => void)();
    const tree = renderFlow(member);
    expect(text(tree)).toContain("安装本机采集器");
    const panel = elements(tree).find((element) => element.type === CollectorInstallPanel);
    expect(panel?.props).toMatchObject({ token: null, status: null });
    expect(button(tree, "下一步").props.disabled).toBe(true);
    expect(button(tree, "稍后")).toBeDefined();
  });
  it("确认清单不用逐项确认，「完成」直接可点；委托授权一步只在配置打开时出现", () => {
    radarEditor(reachRadar(member)).onLater!();
    for (const label of ["稍后", "稍后", "下一步"]) (button(renderFlow(member), label).props.onClick as () => void)();
    const review = renderFlow(member);
    expect(text(review)).toContain("确认清单");
    expect(button(review, "完成").props.disabled).toBe(false);
    expect(elements(review).some((element) => element.props.role === "tablist")).toBe(false);
    hooks.reset();
    const flagged = { ...member, delegationStep: true };
    radarEditor(reachRadar(flagged)).onLater!();
    for (const label of ["稍后", "稍后", "下一步", "完成"]) (button(renderFlow(flagged), label).props.onClick as () => void)();
    const delegation = renderFlow(flagged);
    expect(text(delegation)).toContain("授权天枢替你记进本体");
    expect(elements(delegation).some((element) => element.type === DelegationPanel)).toBe(true);
    expect(button(delegation, "稍后")).toBeDefined();
  });
});

describe("安装采集器与扫描", () => {
  it("一行安装命令按系统给出，带着天枢地址和令牌", () => {
    expect(collectorCommand("windows", "https://ts.example/", "tsm_x")).toBe(
      "& ([scriptblock]::Create((irm 'https://ts.example/api/collector/install.ps1'))) -Server 'https://ts.example' -Token 'tsm_x'");
    expect(collectorCommand("macos", "https://ts.example", "tsm_x")).toBe(
      "curl -fsSL 'https://ts.example/api/collector/install.sh' | sh -s -- --server 'https://ts.example' --token 'tsm_x'");
  });
  const status = (patch: Partial<CollectorStatus> = {}): CollectorStatus => ({
    consent: true,
    devices: [{ id: "d", name: "工作机", platform: "windows", lastSeenAt: "2026-10-18T02:00:00.000Z" }],
    scannedAt: null, inventory: { scheduledTasks: 3, feishuDocs: 5, memoryFiles: 12 }, ...patch,
  });
  const view = (steps: ReturnType<typeof scanSteps>) => steps.map((step) => [step.label, step.status, step.result ?? ""]);
  it("扫描步骤：等盘点时当前一步高亮；盘点到了三类一起打勾带数字，再整理清单；没连上就停住", () => {
    expect(view(scanSteps(status(), null))).toEqual([
      ["连接采集器", "done", "工作机"], ["本机定时任务", "active", ""], ["飞书文档", "pending", ""], ["记忆文件", "pending", ""], ["整理清单", "pending", ""]]);
    expect(view(scanSteps(status({ scannedAt: "2026-10-18T02:01:00.000Z" }), null))).toEqual([
      ["连接采集器", "done", "工作机"], ["本机定时任务", "done", "3 项"], ["飞书文档", "done", "5 份"], ["记忆文件", "done", "12 个"], ["整理清单", "active", ""]]);
    expect(view(scanSteps(status({ scannedAt: "2026-10-18T02:01:00.000Z" }), { basis: 4, schedules: 2 })).at(-1)).toEqual(["整理清单", "done", "依据 4 · 定时任务 2"]);
    expect(view(scanSteps(status({ devices: [] }), null))).toEqual([
      ["连接采集器", "stopped", "未连接"], ["本机定时任务", "stopped", "未连接"], ["飞书文档", "stopped", "未连接"], ["记忆文件", "stopped", "未连接"], ["整理清单", "active", ""]]);
    expect(view(scanSteps(status(), null, true)).slice(1, 2)).toEqual([["本机定时任务", "stopped", "超时"]]);
    // 没同意采集：本机清单的三步停在「未同意」，直接整理天枢里已有的。
    expect(view(scanSteps(status({ consent: false }), null)).slice(1)).toEqual([
      ["本机定时任务", "stopped", "未同意"], ["飞书文档", "stopped", "未同意"], ["记忆文件", "stopped", "未同意"], ["整理清单", "active", ""]]);
  });
  it("飞书文档的修订写成「月/日 修订 · 修订人」", () => {
    expect(revisedLabel("2026-10-16T08:00:00.000Z", "编辑人")).toBe("10/16 修订 · 编辑人");
    expect(revisedLabel("2026-10-16T08:00:00.000Z", null)).toBe("10/16 修订");
  });
});

describe("确认清单：一屏摘要", () => {
  const doc = (key: string, patch: Partial<ReviewLists["basis"][number]> = {}): ReviewLists["basis"][number] => ({
    key, kind: "feishu_doc", title: `文档 ${key}`, url: null, revision: null, origin: "session", revisedAt: null, revisedBy: null,
    confirmed: false, supersededBy: null, keepUntil: null, ...patch });
  const weekly: ReviewLists["schedules"][number] = { key: "dev:TianshuWeeklySync", name: "TianshuWeeklySync", cadence: "Weekly",
    command: "powershell.exe -File tianshu-weekly-sync.ps1", deviceName: "工作机", imported: false };
  const lists: ReviewLists = { basis: [doc("material:m1", { kind: "material", origin: "task", title: "M2 战略解码.md" }), doc("feishu_doc:w1")], schedules: [weekly] };
  type SummaryProps = Parameters<typeof ReviewSummary>[0];
  const summary = (patch: Partial<SummaryProps> = {}) => {
    hooks.begin();
    return ReviewSummary({ lists, reviewed: false, picks: {}, onPick: () => undefined, memoryFiles: 12, saving: false, error: null, ...patch });
  };
  const rows = (tree: ReactNode) => elements(tree).filter((element) => element.type === "button").map((element) => text(element.props.children as ReactNode));
  const row = (tree: ReactNode, label: string) => {
    const match = elements(tree).find((element) => element.type === "button" && text(element.props.children as ReactNode).startsWith(label));
    expect(match, `应有「${label}」一行`).toBeDefined();
    return match!;
  };
  const checklist = (tree: ReactNode, label: string) => elements(tree).find((element) => element.props.label === label && typeof element.props.onToggle === "function");

  it("一项一行写帮本人选好的数：还没提交过时文档、定时任务全勾；默认全部收起", () => {
    const tree = summary();
    expect(rows(tree)).toEqual(["记忆文件12个", "文档2份", "定时任务1个"]);
    expect(elements(tree).filter((element) => element.props["aria-expanded"] === true)).toEqual([]);
    expect(checklist(tree, "文档")).toBeUndefined();
    expect(text(tree)).not.toContain("飞书知识库 ·");
  });

  it("数量为 0 的那一项不显示；三项都没有时这一步跳过", () => {
    expect(rows(summary({ lists: { basis: [], schedules: [weekly] }, memoryFiles: 0 }))).toEqual(["定时任务1个"]);
    hooks.reset();
    expect(rows(summary({ lists: { basis: [doc("feishu_doc:w1")], schedules: [] }, memoryFiles: null }))).toEqual(["文档1份"]);
    expect(reviewEmpty({ basis: [], schedules: [] }, 0)).toBe(true);
    expect(reviewEmpty({ basis: [], schedules: [] }, null)).toBe(true);
    expect(reviewEmpty({ basis: [], schedules: [] }, 3)).toBe(false);
    expect(reviewEmpty({ basis: [], schedules: [weekly] }, null)).toBe(false);
  });

  it("点开一行展开勾选明细，改了勾选摘要跟着变；提交过之后按入库的勾", () => {
    let picks: ReviewPicks = {};
    const onPick = vi.fn((key: string, checked: boolean) => { picks = { ...picks, [key]: checked }; });
    (row(summary({ onPick }), "文档").props.onClick as () => void)();
    let tree = summary({ onPick, picks });
    expect(row(tree, "文档").props["aria-expanded"]).toBe(true);
    const list = checklist(tree, "文档")!;
    expect(list.props).toMatchObject({ items: lists.basis, selected: ["material:m1", "feishu_doc:w1"] });
    (list.props.onToggle as (key: string, checked: boolean) => void)("feishu_doc:w1", false);
    expect(onPick).toHaveBeenCalledWith("feishu_doc:w1", false);
    tree = summary({ onPick, picks });
    expect(rows(tree)).toContain("文档1份");
    expect(checklist(tree, "文档")!.props.selected).toEqual(["material:m1"]);
    // 再点一次收起；记忆文件那一行展开的是导入插槽。
    (row(tree, "文档").props.onClick as () => void)();
    expect(checklist(summary({ onPick, picks }), "文档")).toBeUndefined();
    (row(summary({ onPick, picks }), "记忆文件").props.onClick as () => void)();
    expect(elements(summary({ onPick, picks })).find((element) => element.type === MemoryImportPanel)?.props).toEqual({ localMemoryFiles: 12 });
    hooks.reset();
    const saved: ReviewLists = { basis: [{ ...lists.basis[0], confirmed: true }, lists.basis[1]], schedules: [{ ...weekly, imported: false }] };
    expect(rows(summary({ lists: saved, reviewed: true }))).toEqual(["记忆文件12个", "文档1份", "定时任务0个"]);
  });

  it("点完成把两份清单按当前勾选分别提交；任一份没存上就抛错留在这一步", async () => {
    const put = vi.spyOn(browserApi, "PUT").mockImplementation((async (path: string) => ({ data: { candidates: [`saved ${path}`] }, response: new Response(null, { status: 200 }) })) as never);
    const saved = await submitReview(lists, false, { "feishu_doc:w1": false });
    expect(put).toHaveBeenCalledTimes(2);
    expect(put).toHaveBeenCalledWith("/api/me/work-basis", { body: { keys: ["material:m1"] } });
    expect(put).toHaveBeenCalledWith("/api/me/schedule-migration", { body: { keys: ["dev:TianshuWeeklySync"] } });
    expect(saved).toEqual({ basis: ["saved /api/me/work-basis"], schedules: ["saved /api/me/schedule-migration"] });
    // 空的清单不提交。
    put.mockClear();
    await submitReview({ basis: [], schedules: [weekly] }, false, {});
    expect(put).toHaveBeenCalledExactlyOnceWith("/api/me/schedule-migration", { body: { keys: ["dev:TianshuWeeklySync"] } });
    put.mockImplementation((async () => ({ data: undefined, error: { message: "清单已经变了，请刷新后再确认" }, response: new Response(null, { status: 400 }) })) as never);
    await expect(submitReview(lists, false, {})).rejects.toThrow("清单已经变了，请刷新后再确认");
  });

  it("提交失败在摘要里原位显示", () => {
    expect(elements(summary({ error: "没有存上，请重试" })).find((element) => element.props.role === "alert")).toBeDefined();
  });
});

describe("选择你的伙伴（spec 5.5）", () => {
  const flow = (data: OnboardingData, options: { nextPath?: string; buddyOnly?: boolean } = {}) => {
    hooks.begin();
    return WelcomeFlow({ data, nextPath: options.nextPath, buddy: null, buddyOnly: options.buddyOnly });
  };
  const nameInput = (tree: ReactNode) => {
    const match = elements(tree).find((element) => element.type === BuddyNameInput);
    expect(match, "起名字这一页应只有伙伴的名字框").toBeDefined();
    return match!.props as unknown as { value: string; onChange: (name: string) => void; onEnter: () => void };
  };
  const skinPicker = (tree: ReactNode) => {
    const match = elements(tree).find((element) => element.type === CoAgentSkinPicker);
    expect(match, "选形象这一页应嵌入四种形象").toBeDefined();
    return match!.props as unknown as { value: string; name: string; onChange: (form: string) => void };
  };
  const press = (tree: ReactNode, label: string) => (button(tree, label).props.onClick as () => void)();

  it("还没有伙伴时排在最前面，CEO 和成员都走；已经引导过的只走这一步；有伙伴的不走", () => {
    expect(onboardingSteps(ceo, false, "first")).toEqual(["buddy", "hello", "tour-notifications", "tour-board"]);
    expect(onboardingSteps(member, false, "first").slice(0, 2)).toEqual(["buddy", "hello"]);
    expect(onboardingSteps(member, false, "only")).toEqual(["buddy"]);
    expect(onboardingSteps(member)[0]).toBe("hello");
    hooks.begin();
    expect(text(WelcomeFlow({ data: ceo, buddy: { name: "团团", form: "panda" } }))).not.toContain("给你的伙伴起个名字");
  });

  it("先单独一页起名字，名字空着不能继续；再选形象，存下再往下走；这一步没有「先进入工作台」", async () => {
    vi.stubGlobal("window", new EventTarget());
    const put = vi.spyOn(browserApi, "PUT").mockResolvedValue({ data: { name: "团团", form: "panda" }, response: new Response(null, { status: 200 }) } as never);
    let tree = flow(ceo);
    expect(text(tree)).toContain("给你的伙伴起个名字");
    expect(text(tree)).not.toContain("先进入工作台");
    expect(elements(tree).some((element) => element.type === CoAgentSkinPicker)).toBe(false);
    expect(nameInput(tree).value).toBe("");
    expect(button(tree, "继续").props.disabled).toBe(true);
    nameInput(tree).onChange(" 团团 ");
    tree = flow(ceo);
    expect(button(tree, "继续").props.disabled).toBe(false);
    press(tree, "继续");
    tree = flow(ceo);
    expect(text(tree)).toContain("选择团团的形象");
    expect(text(tree)).not.toContain("先进入工作台");
    expect(skinPicker(tree)).toMatchObject({ value: "classic", name: " 团团 " });
    expect(put).not.toHaveBeenCalled();
    skinPicker(tree).onChange("panda");
    press(flow(ceo), "继续");
    await vi.waitFor(() => expect(text(flow(ceo))).toContain("你好，测试"));
    expect(put).toHaveBeenCalledExactlyOnceWith("/api/me/buddy", { body: { name: "团团", form: "panda" } });
  });

  it("名字页回车也往下，名字不合格不翻页；选中哪颗，顶上的胶囊就换成哪颗，选默认还是原来的大胶囊；「上一步」回到起名字", () => {
    nameInput(flow(ceo)).onEnter();
    expect(text(flow(ceo))).toContain("给你的伙伴起个名字");
    nameInput(flow(ceo)).onChange("团团");
    nameInput(flow(ceo)).onEnter();
    let tree = flow(ceo);
    expect(text(tree)).toContain("选择团团的形象");
    expect(elements(tree).some((element) => element.type === CoAgentCapsule)).toBe(true);
    expect(elements(tree).some((element) => element.type === PresenceCapsule)).toBe(false);
    skinPicker(tree).onChange("miles");
    tree = flow(ceo);
    expect(elements(tree).find((element) => element.type === PresenceCapsule)?.props).toMatchObject({ skin: "miles", name: "团团" });
    expect(elements(tree).some((element) => element.type === CoAgentCapsule)).toBe(false);
    press(tree, "上一步");
    tree = flow(ceo);
    expect(nameInput(tree).value).toBe("团团");
    expect(elements(tree).some((element) => element.type === CoAgentCapsule)).toBe(true);
  });

  it("存不上就留在选形象这一页并说明，不往下走", async () => {
    vi.stubGlobal("window", new EventTarget());
    vi.spyOn(browserApi, "PUT").mockResolvedValue({ data: undefined, error: { message: "伙伴要有名字" }, response: new Response(null, { status: 400 }) } as never);
    nameInput(flow(ceo)).onChange("团团");
    press(flow(ceo), "继续");
    press(flow(ceo), "继续");
    await vi.waitFor(() => expect(text(flow(ceo))).toContain("伙伴要有名字"));
    expect(text(flow(ceo))).toContain("选择团团的形象");
  });

  it("已经引导过、只差伙伴的人：存好就回原来要去的页面，不再记一次引导完成", async () => {
    const replace = vi.fn();
    vi.stubGlobal("window", Object.assign(new EventTarget(), { location: { replace } }));
    vi.spyOn(browserApi, "PUT").mockResolvedValue({ data: { name: "团团", form: "alive" }, response: new Response(null, { status: 200 }) } as never);
    const complete = vi.spyOn(browserApi, "POST").mockResolvedValue({ data: undefined, response: new Response(null, { status: 204 }) } as never);
    const options = { nextPath: "/radar", buddyOnly: true };
    nameInput(flow(ceo, options)).onChange("团团");
    press(flow(ceo, options), "继续");
    skinPicker(flow(ceo, options)).onChange("alive");
    const tree = flow(ceo, options);
    expect(elements(tree).find((element) => element.type === OnboardingProgress)?.props).toMatchObject({ current: 1, total: 1 });
    (button(tree, "继续").props.onClick as () => void)();
    await vi.waitFor(() => expect(replace).toHaveBeenCalledExactlyOnceWith("/radar"));
    expect(complete).not.toHaveBeenCalledWith("/api/me/onboarding/complete");
  });
});
