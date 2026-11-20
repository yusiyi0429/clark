import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { TChatListResponse, TChatRow, THomeItem } from "@warmap/contracts";
import type { HomeProject, SubSession, WorkHomeData } from "@/lib/home/types";
import { fromHome, projectWorking } from "@/lib/home/projects";
import { LeftColumn } from "./LeftColumn";
import { HomeMeetingContext, type HomeMeetingState } from "./meetingState";
import { SeenContext, Subs, planOrder, subDot, subIcon } from "./SubRows";
import { scopeOf, viewOf } from "./view";

/** 没有 jsdom：带 data-testid 的原生元素的 props 从 JSX 运行时截下来，直接调它们的处理器。 */
const tap = vi.hoisted(() => ({ props: new Map<string, Record<string, unknown>>() }));
const capture = vi.hoisted(() => <T,>(fn: T) => ((type: unknown, props: Record<string, unknown>, ...rest: unknown[]) => {
  if (typeof type === "string" && typeof props?.["data-testid"] === "string") tap.props.set(props["data-testid"] as string, props);
  return (fn as unknown as (...args: unknown[]) => unknown)(type, props, ...rest);
}) as unknown as T);
vi.mock("react/jsx-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react/jsx-runtime")>();
  return { ...actual, jsx: capture(actual.jsx), jsxs: capture(actual.jsxs) };
});
vi.mock("react/jsx-dev-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react/jsx-dev-runtime")>();
  return { ...actual, jsxDEV: capture(actual.jsxDEV) };
});

const data = { period: "2026-11", projects: [], archivedCount: 0, month: { missions: [] }, waiting: [], other: { subSessions: [], items: [] } } as unknown as WorkHomeData;
const projectsOf = (used: WorkHomeData) => used.projects.map((project) => fromHome(project, used, new Map()));
const render = (extra: Partial<Parameters<typeof LeftColumn>[0]>, meeting: HomeMeetingState = { listening: false, clock: null, href: null }) => {
  const used = extra.data ?? data;
  return renderToStaticMarkup(
    <HomeMeetingContext.Provider value={meeting}>
      <LeftColumn data={used} view={{ kind: "home" }} buddy={null} go={() => undefined} phone={false}
        account={{ displayName: "孙铭泽", role: "member" }} today="11 月 7 日 周六"
        projects={projectsOf(used)} archived={[]} onCreate={async () => "x"} {...extra} />
    </HomeMeetingContext.Provider>,
  );
};

describe("左栏：计划读不到、空月份（5.4.2、5.4.4）", () => {
  it("计划读不到时树最上面一行「本体读取失败」加「重试」，不画成空树", () => {
    const html = render({ onRetryPlan: () => undefined });
    expect(html).toContain('data-testid="plan-read-failed"');
    expect(html).toMatch(/本体读取失败.*重试/);
    expect(render({})).not.toContain("本体读取失败");
  });

  it("空月份：「本月」行行尾出「11 月待敲定」chip（11/16 从「今天」行挪过来）", () => {
    const html = render({ month: { href: "/me/work/month/2026-11", label: "11 月待敲定" } });
    expect(html).toMatch(/data-testid="month-row"[^]*11 月待敲定/);
    expect(html).not.toMatch(/data-testid="today-row"[^]*?11 月待敲定[^]*data-testid="meetings-row"/);
    expect(render({})).not.toContain("待敲定");
  });
});

describe("左栏：今天、会议、本月三行（11/16 重新设计第 3 节）", () => {
  it("「今天」下面是「会议」「本月」两行，各有自己的地址", () => {
    const html = render({});
    const order = ["today-row", "meetings-row", "month-row"].map((id) => html.indexOf(`data-testid="${id}"`));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).not.toContain('data-testid="month-chip"');
  });

  it("「会议」行行尾写下一场还没进等你的会；没有就不写", () => {
    expect(render({ meetingsTrail: "11/18" })).toMatch(/data-testid="meetings-row"[^]*?>11\/18</);
    expect(render({})).not.toMatch(/data-testid="meetings-row"[^>]*>[^]*?\d+\/\d+[^]*data-testid="month-row"/);
  });

  it("「本月」行平时写下一个验收时间点；有月份 chip 时只画 chip", () => {
    expect(render({ monthTrail: "11/18 验收" })).toMatch(/data-testid="month-row"[^]*11\/18 验收/);
    const both = render({ monthTrail: "11/18 验收", month: { href: "/me/work/month/2026-11", label: "复盘" } });
    expect(both).toContain("复盘");
    expect(both).not.toContain("11/18 验收");
  });

  it("在月份页时亮的是「本月」行，不是「今天」行；在会议页亮「会议」行", () => {
    const month = render({ view: { kind: "month", period: "2026-11" } });
    expect(month).toMatch(/data-testid="month-row"[^>]*aria-current="page"|aria-current="page"[^>]*data-testid="month-row"/);
    expect(month).not.toMatch(/aria-current="page"[^>]*data-testid="today-row"|data-testid="today-row"[^>]*aria-current="page"/);
    const meetings = render({ view: { kind: "meetings" } });
    expect(meetings).toMatch(/data-testid="meetings-row"[^>]*aria-current="page"|aria-current="page"[^>]*data-testid="meetings-row"/);
  });

  it("地址：/me/work/meetings 是会议页，/me/work/meetings/<id> 还是会议详情", () => {
    expect(viewOf("/me/work/meetings")).toEqual({ kind: "meetings" });
    expect(viewOf("/me/work/meetings/m1")).toEqual({ kind: "meeting", id: "m1" });
    expect(scopeOf({ kind: "meetings" })).toBe("main");
  });
});

const item = (id: string, title: string, extra: Partial<THomeItem> = {}): THomeItem => ({
  id, title, status: "in_progress", dueDate: null, awaitingAcceptance: false, updatedAt: "2026-11-07T01:00:00.000Z", ...extra,
});
const withTask = (items: THomeItem[], extra: Partial<HomeProject> = {}) => ({
  ...data,
  projects: [{
    projectId: "p1", name: "首页改版", lastActivityAt: "2026-11-07T01:00:00.000Z", budget: null,
    goals: [{ taskId: "t1", missionId: "m1", name: "左栏", period: "2026-11", dueDate: "2026-11-30", criteria: [], criteriaMet: 0, criteriaTotal: 0, completedAt: null, responsible: null }], transfer: null,
    summary: { running: 0, waiting: 0, queued: 0, done: 0, doneToday: 0, needsYou: 0 },
    pipeline: { conversationId: null, scope: "project:p1" }, planning: false, subSessions: [], items, ...extra,
  }],
}) as unknown as WorkHomeData;

describe("左栏：项目（16.2）", () => {
  it("「项目」组头右边一个「+」；项目行只有名字一行，本月目标不写在左栏（47 条）；信息按钮进项目详情", () => {
    const html = render({ data: withTask([]) });
    expect(html).toMatch(/>项目<\/button><button[^>]*>对话<\/button><\/div><button[^>]*aria-label="新建项目"/);
    expect(html).toContain("首页改版");
    expect(html).not.toContain("11/30 验收");
    expect(html).not.toMatch(/class="[^"]*taskSub/);
    expect(html).toContain('aria-label="首页改版 详情"');
  });

  it("例外两种还出第二行（47 条）：转交中「等 X 接手」、预算 80%（琥珀）", () => {
    const transfer = { id: "x", projectId: "p1", projectName: "p1", from: { personId: "a", name: "甲" }, to: { personId: "b", name: "乙" }, status: "sent",
      startedAt: "2026-11-07T01:00:00.000Z", decidedAt: null, includeHistory: false, running: null, check: null, note: null, checkResult: null, clone: null, afterSequence: null };
    expect(render({ data: withTask([], { transfer } as never) })).toMatch(/<span class="[^"]*taskSub[^"]*">等 乙 接手<\/span>/);
    expect(render({ data: withTask([], { budget: { percent: 80, state: "warning" } } as never) })).toMatch(/<span class="[^"]*taskSub[^"]*" data-warning="">预算 80%<\/span>/);
  });

  it("没有 Mission 分组：不再画 Mission 行", () => {
    expect(render({ data: withTask([]) })).not.toContain("tree-mission");
  });

  it("本人事项在项目下面：标题加行尾截止日；做完的排后、变淡", () => {
    const html = render({ data: withTask([item("00000000-0000-4000-8000-000000000001", "写验收清单", { status: "done" }), item("00000000-0000-4000-8000-000000000002", "约评审", { dueDate: "2026-11-12" })]) });
    expect(html).toMatch(/data-testid="tree-project".*约评审.*11\/12.*data-state="done"[^>]*data-tree-row=""[^>]*data-testid="tree-item".*写验收清单/);
    expect(html).not.toContain("已完成");
  });

  it("项目行只有名字和点：没有箭头、没有「N 个子会话」、没有「+」", () => {
    const sub = (id: string, state: string, unseen = false) => ({ id, kind: "card", title: `卡${id}`, state, waiting: null, updatedAt: "a", queueReason: null, holdUntil: null, unseen });
    const actions = { renameProject: vi.fn(), archiveProject: vi.fn(), deleteProject: vi.fn(), hideProject: vi.fn(), renameSub: vi.fn(), archiveSub: vi.fn(), deleteSub: vi.fn() };
    const html = render({ data: withTask([], { subSessions: [sub("1", "running"), sub("2", "done", true)] as never, unseen: true }), actions }).replace(/<!-- -->/g, "");
    expect(html).toContain("首页改版");
    expect(html).toContain('data-testid="project-unseen"');
    expect(html).toContain('data-testid="project-info"');
    expect(html).toContain('aria-label="首页改版 更多"');
    for (const gone of ["data-fold", "tree-subs", "子会话", "卡1", "tree-sub", "project-new-sub"]) expect(html).not.toContain(gone);
  });

  it("有已归档的（本人 11/16 藏起来）：树里不占一行，「项目」组头「+」左边一个图标「已归档 N」，默认不列", () => {
    const html = render({ data: withTask([]), projects: [], archived: projectsOf(withTask([])).map((project) => ({ ...project, archived: true })) });
    expect(html).toMatch(/aria-label="项目".*>项目<\/button><button[^>]*>对话<\/button><\/div><button[^>]*aria-label="已归档 1"[^>]*aria-pressed="false"[^>]*data-testid="tree-archived".*data-testid="project-add"/);
    expect(html).not.toContain('aria-label="已归档"');
    expect(html).not.toContain('data-testid="tree-project"');
  });

  it("待归位的事项进「其他」：没有会话也画这一组；老的不归项目的会话不在这里（挪去右边）", () => {
    expect(render({})).not.toContain('aria-label="其他"');
    const old = { id: "c9", kind: "card", title: "老会话", state: "done", waiting: null, updatedAt: "a", queueReason: null, holdUntil: null, unseen: false };
    expect(render({ data: { ...data, other: { subSessions: [old], items: [] } } as never })).not.toContain('aria-label="其他"');
    const html = render({ data: { ...data, other: { subSessions: [], items: [item("00000000-0000-4000-8000-000000000003", "整理会议纪要", { dueDate: "2026-11-09" })] } } });
    expect(html).toMatch(/aria-label="其他".*其他.*data-testid="tree-item".*整理会议纪要.*11\/09/);
  });

  it("左栏和已归档都不列随手项目", () => {
    const base = withTask([]);
    const both = { ...base, projects: [...base.projects, { ...base.projects[0]!, projectId: "s1", name: "随手", goals: [], scratch: true }] } as WorkHomeData;
    const html = render({ data: both });
    expect(html).toContain("首页改版");
    expect(html).not.toContain("随手");
    // 已归档里同样不列，「已归档 N」也不数它。
    const archived = render({ data: both, projects: [], archived: projectsOf(both).map((project) => ({ ...project, archived: true })) });
    expect(archived).toMatch(/aria-label="已归档 1"[^>]*data-testid="tree-archived"/);
    expect(archived).not.toContain("随手");
  });

  it("已归档只列项目", () => {
    const archived = projectsOf(withTask([])).map((project) => ({ ...project, archived: true }));
    const archivedSubs = [{ kind: "topic", id: "t1", title: "选型", projectId: "p1", projectName: "首页改版", archivedAt: "2026-11-09T02:00:00.000Z" }];
    const html = render({ data: withTask([]), projects: [], archived, ...({ archivedSubs } as object) });
    expect(html).toMatch(/aria-label="已归档 1"[^>]*data-testid="tree-archived"/);
  });
});

describe("左栏：项目 | 对话（同事伙伴设计第 1 节）", () => {
  const chatRow = (fields: Partial<TChatRow>): TChatRow => ({
    id: "00000000-0000-4000-8000-000000000001", peer: { personId: "p", displayName: "测试研发", left: false }, peerBuddy: null,
    last: { author: "buddy", text: "好的", at: "2026-11-06T02:00:00.000Z" }, unread: false, waiting: 0, ...fields,
  });
  const list: TChatListResponse = { mine: [chatRow({ unread: true })], inbound: [chatRow({ waiting: 1 })], requests: [] };

  it("红框那行是滑块：默认项目；在对话页时停在对话；停在项目、对话有事时亮点", () => {
    tap.props.clear();
    render({ chats: list });
    expect(tap.props.get("tab-projects")?.["aria-pressed"]).toBe(true);
    expect(tap.props.get("tab-chats-dot")?.["data-tone"]).toBe("attention");
    render({ view: { kind: "chat", side: "with", personId: "p" }, chats: list });
    expect(tap.props.get("tab-chats")?.["aria-pressed"]).toBe(true);
    expect(tap.props.has("chat-find")).toBe(true);
  });
});

describe("会话的先后（照派活单）", () => {
  it("卡按看板里建出来的先后，没读到的和专题在后面", () => {
    const sub = (id: string, kind: "card" | "topic", updatedAt: string) => ({ id, kind, updatedAt }) as unknown as SubSession;
    const at = new Map([["c1", "2026-11-07T01:00:00.001Z"], ["c2", "2026-11-07T01:00:00.002Z"], ["c3", "2026-11-07T01:00:00.003Z"]]);
    const list = [sub("c3", "card", "z"), sub("t1", "topic", "a"), sub("c1", "card", "y"), sub("c2", "card", "x")];
    expect(planOrder(list, at).map((entry) => entry.id)).toEqual(["c1", "c2", "c3", "t1"]);
  });
});

/** 子会话行（挪去右边的会话面板）：直接画 SubRows 的 Subs。 */
const subs = (list: SubSession[], seen?: Map<string, string>) => renderToStaticMarkup(
  <SeenContext.Provider value={{ seen }}><Subs subs={list} view={{ kind: "home" }} go={() => undefined} flat /></SeenContext.Provider>,
);

describe("子会话的状态点（18.10）", () => {
  it("停着、不在等什么的：一轮做完读「做完一轮」，真停了（本人停、强停、本机程序重启）和云端没报原因的读「已停下」", () => {
    const stopped = (stopWhy?: SubSession["stopWhy"]) => ({ state: "waiting" as const, waiting: null, unseen: true, ...(stopWhy ? { stopWhy } : {}) });
    expect(subDot(stopped("turn_done"))).toEqual({ tone: "stopped", label: "做完一轮" });
    expect(subIcon(stopped("turn_done"))).toEqual({ state: "stopped", label: "做完一轮" });
    for (const why of ["interrupted", "killed", "runner_restart"] as const) expect(subDot(stopped(why))?.label).toBe("已停下");
    expect(subIcon(stopped())).toEqual({ state: "stopped", label: "已停下" });
  });

  it("本人 11/16：行首不画字母方块；行尾在跑灰点、停了蓝点、要介入黄点，排队的行尾什么都不画（47 条）；读屏按状态读", () => {
    const sub = (id: string, state: string, waiting: unknown = null, queueReason: unknown = null, unseen = false) =>
      ({ id, kind: "card", title: `卡${id}`, state, waiting, updatedAt: id, queueReason, holdUntil: null, sessionId: null, unseen });
    const html = subs([sub("1", "running"), sub("2", "waiting", null, null, true), sub("3", "waiting", "approval"), sub("4", "queued", null, "prior_cards"), sub("5", "waiting")] as never);
    const rows = html.split('data-testid="tree-sub"').slice(1);
    expect(html).not.toContain("sub-letter");
    expect(rows).toHaveLength(5);
    expect(rows[0]).toMatch(/data-tone="running" role="img" aria-label="在跑"/);
    expect(rows[1]).toMatch(/data-tone="stopped" role="img" aria-label="已停下"/);
    expect(rows[2]).toMatch(/data-tone="attention" role="img" aria-label="等你批准"/);
    expect(rows[3]).not.toContain("sub-dot");
    // 蓝点只是提醒（26 条）：停了、看过的不画。
    expect(rows[4]).not.toContain("sub-dot");
    // 排队：行尾不写字、不画图标（47 条，计时器图标去掉）。
    expect(rows[3]).not.toContain("sub-queue");
    expect(rows[3]).not.toContain("等前面的卡");
    expect(rows[3]).not.toContain("<svg");
  });
});

describe("蓝点点了就藏（25 条，组件）", () => {
  const sub = (updatedAt: string) => ({ id: "c2", kind: "card", title: "卡2", state: "waiting", waiting: null, updatedAt, queueReason: null, holdUntil: null, sessionId: null, unseen: true });
  it("刚看过的（同一次停下）不画蓝点；之后来了更新的停下又画；刷新后没有这一页的记录，照云端画", () => {
    const seen = new Map([["sub:c2", "2026-11-09T03:00:00Z"]]);
    expect(subs([sub("2026-11-09T03:00:00Z")] as never, seen)).not.toContain("sub-dot");
    expect(subs([sub("2026-11-09T03:05:00Z")] as never, seen)).toMatch(/data-tone="stopped"[^>]*aria-label="已停下"/);
    expect(subs([sub("2026-11-09T03:00:00Z")] as never)).toMatch(/data-tone="stopped"[^>]*aria-label="已停下"/);
  });
  it("项目行同理：刚看过的不画，看过以后又有新回复的画", () => {
    const seen = new Map([["project:p1", "2026-11-07T01:00:00.000Z"]]);
    expect(render({ data: withTask([], { unseen: true }), seen })).not.toContain("project-unseen");
    expect(render({ data: withTask([], { unseen: true, lastActivityAt: "2026-11-07T02:00:00.000Z" }), seen })).toContain("project-unseen");
  });
});

describe("左栏：伙伴门牌（本人 11/18 方案 A：对话顶上为主，左上角退成不动的门牌）", () => {
  const card = (html: string) => html.match(/<button[^>]*data-testid="buddy-entry"[^>]*>([^]*?)<\/button>/)?.[1] ?? "";
  const cardCss = readFileSync(fileURLToPath(new URL("../../styles/home.module.css", import.meta.url)), "utf8");
  const markCss = readFileSync(fileURLToPath(new URL("../../styles/buddy-mark.module.css", import.meta.url)), "utf8");
  /** 以这个选择器开头的那一行规则。 */
  const rule = (css: string, selector: string) => css.split("\n").find((line) => line.startsWith(`${selector} {`)) ?? "";

  it("门牌只有形象，没有名字文字，形象是 card 位", () => {
    const go = vi.fn();
    const html = render({ buddy: { name: "小天", form: "classic" } as never, go });
    // 读屏名称仍是伙伴名。
    expect(html).toMatch(/<button[^>]*aria-label="小天"[^>]*data-testid="buddy-entry"/);
    // 本人 11/18：门牌里只有形象（card 位），不写名字。
    expect(card(html)).toMatch(/^<span[^>]*data-place="card"/);
    expect(card(html)).not.toContain("小天");
    expect(card(html)).not.toContain("buddyName");
    (tap.props.get("buddy-entry")?.onClick as () => void)();
    expect(go).toHaveBeenCalledWith("/me/work/buddy");
    // 主线时只有选中（aria-current + 现有的选中底），不变淡、不模糊。
    const on = render({ view: { kind: "buddy" } });
    expect(render({})).not.toMatch(/aria-current="page"[^>]*data-testid="buddy-entry"/);
    expect(on).toMatch(/aria-current="page"[^>]*data-testid="buddy-entry"/);
    expect(on).not.toContain("data-dim");
    expect(cardCss).not.toMatch(/data-dim|\.buddySlot|\.buddyName|blur\(/);
    expect(rule(cardCss, ".buddyCard:has(> .buddyHit[aria-current=\"page\"])")).toContain("background: var(--default-soft-hover)");
    // 48 高一行，形象水平、垂直都居中；「⋯」贴右浮着，不把形象挤偏（左右不留不对称的内边距）。
    expect(rule(cardCss, ".buddyHit")).toMatch(/align-items: center; justify-content: center;/);
    expect(rule(cardCss, ".buddyHit")).toMatch(/height: var\(--row-48\)/);
    expect(rule(cardCss, ".buddyHit")).toMatch(/padding: 0;/);
    expect(rule(cardCss, ".buddyMore")).toMatch(/position: absolute/);
    // 形象放大：胶囊 72×27（128×48 缩 .5625），Q 版圆 44。
    expect(rule(markCss, '.mark[data-place="card"]')).toMatch(/--coagent-capsule-width: 128px; --coagent-capsule-height: 48px; width: 72px; height: 27px;/);
    expect(rule(markCss, '.mark[data-place="card"] .scale')).toMatch(/transform: scale\(\.5625\)/);
    expect(rule(markCss, '.mark[data-place="card"][data-shape="circle"]')).toMatch(/width: 44px; height: 44px;/);
  });

  it("门牌形象不动：开会、在想时都是静止", () => {
    // 开会录音时也不跟着动（名片不接对话的在想、回答）：一直是静止的空闲，名片里不写「在录」。
    const meeting = { listening: true, clock: "12:34", href: null };
    for (const buddy of [{ name: "小天", form: "classic" }, { name: "小天", form: "miles" }]) {
      const html = render({ buddy: buddy as never }, meeting).replace(/<!-- -->/g, "");
      expect(card(html)).toMatch(/data-place="card"[^>]*data-state="idle"[^>]*data-still="true"/);
      expect(card(html)).not.toContain('data-state="listening"');
      expect(html).not.toContain("在录");
    }
    // Q 版圆也不眨眼、不转头：静止标记一路传到画它的那一层。
    expect(card(render({ buddy: { name: "小天", form: "miles" } as never }, meeting))).toMatch(/data-pose="idle"[^>]*data-shape="circle"[^>]*data-still="true"/);
    // 门牌里不出场、不过渡：静止的那颗里所有动画都关掉。
    expect(markCss).toMatch(/\.mark\[data-still\] \* \{ animation: none; transition: none; \}/);
  });

  it("开会那一颗在「会议」行行尾，和行按钮并排（不套在按钮里），下一场照旧写在它前面", () => {
    const html = render({ meetingsTrail: "14:30", meetingSlot: <span data-testid="meeting-slot" /> });
    expect(html).toMatch(/data-testid="meetings-row">(?:(?!<\/button>)[^])*14:30(?:(?!<\/button>)[^])*<\/button><span data-testid="meeting-slot"><\/span>/);
  });
});

describe("左栏：项目在后台干活的灰点", () => {
  const running = (state: string) => ({ id: "c1", kind: "card", title: "卡1", state, waiting: null, updatedAt: "a", queueReason: null, holdUntil: null });
  const worker = (patch: Partial<Parameters<typeof projectWorking>[1][number]>) => ({ kind: "plan", state: "doing", mark: null, taskId: null, projectId: null, cardId: null, topicId: null, ...patch }) as Parameters<typeof projectWorking>[1][number];
  const projectOf = (extra: Partial<HomeProject> = {}) => projectsOf(withTask([], extra))[0]!;

  it("有子会话在跑、项目对话在回复、这个项目的规划员或验收员在做，算在干活；都没有就不算", () => {
    expect(projectWorking(projectOf({ subSessions: [running("running")] as never }), [], false)).toBe(true);
    for (const state of ["queued", "waiting", "done", "failed"]) expect(projectWorking(projectOf({ subSessions: [running(state)] as never }), [], false)).toBe(false);
    expect(projectWorking(projectOf(), [], true)).toBe(true);
    expect(projectWorking(projectOf(), [worker({ taskId: "t1" })], false)).toBe(true);
    expect(projectWorking(projectOf(), [worker({ projectId: "p1" })], false)).toBe(true);
    expect(projectWorking(projectOf({ subSessions: [running("done")] as never }), [worker({ kind: "verify", cardId: "c1" })], false)).toBe(true);
    // 这台电脑上正做着的卡（云端还没同步成 running）也算；等你批准、回答的不算。
    expect(projectWorking(projectOf(), [worker({ kind: "card", taskId: "t1" })], false)).toBe(true);
    expect(projectWorking(projectOf(), [worker({ kind: "card", taskId: "t1", mark: "reviewing" })], false)).toBe(true);
    for (const mark of ["approval", "reply", "paused", "review_failed", "blocked"] as const) expect(projectWorking(projectOf(), [worker({ kind: "card", taskId: "t1", mark })], false)).toBe(false);
    expect(projectWorking(projectOf(), [worker({ taskId: "t1", state: "done" }), worker({ taskId: "t1", state: "queued" }), worker({ taskId: "t9" })], false)).toBe(false);
  });

  it("在干活的项目行最右边一颗闪的灰点（34 条：和子会话行的点同一个），读屏读「在后台工作」、点本身不读；不在干活的不画", () => {
    const html = render({ data: withTask([]), working: new Set(["p1"]) });
    expect(html).toMatch(/首页改版<\/span><\/span><\/button><span class="[^"]*" data-tone="running" data-testid="project-working"><i aria-hidden="true"><\/i><span[^>]*>在后台工作<\/span><\/span>/);
    expect(render({ data: withTask([]) })).not.toContain("project-working");
    expect(render({ data: withTask([]), working: new Set(["p9"]) })).not.toContain("在后台工作");
  });

  it("项目对话有没看过的新回复（26 条）：行尾蓝点，同子会话的蓝点；在干活时照旧是灰点；看过的不画", () => {
    const unseen = render({ data: withTask([], { unseen: true }) });
    expect(unseen).toMatch(/<\/span><\/span><\/button><span class="[^"]*" data-tone="stopped" role="img" aria-label="有新回复" data-testid="project-unseen"><i aria-hidden="true"><\/i><\/span>/);
    expect(render({ data: withTask([], { unseen: true }), working: new Set(["p1"]) })).not.toContain("project-unseen");
    expect(render({ data: withTask([]) })).not.toContain("project-unseen");
  });

  it("等你的项目（34、47 条）：行最右边一颗黄点，和子会话行「要介入」的点同一个元素同一种颜色；等你时不再画在干活的灰点和新回复", () => {
    const waiting = withTask([], { summary: { running: 0, waiting: 1, queued: 0, done: 0, doneToday: 0, needsYou: 1 }, unseen: true } as never);
    const html = render({ data: waiting, working: new Set(["p1"]) });
    expect(html).toMatch(/<\/span><\/span><\/button><span class="[^"]*" data-tone="attention" role="img" aria-label="等你" data-testid="project-waiting"><i aria-hidden="true"><\/i><\/span>/);
    expect(html).not.toContain("project-working");
    expect(html).not.toContain("project-unseen");
    expect(html).not.toMatch(/data-state="waiting"/);
  });

  it("项目名和「项目」组头对齐（47 条）：名字前没有空的状态位，第一样就是名字", () => {
    const html = render({ data: withTask([]) });
    expect(html).toMatch(/data-tree-row=""[^>]*><span class="[^"]*taskText[^"]*projectText/);
  });

  it("圆点只有一种（47 条）：6px 实心圆，黄 = 要介入、蓝 = 停了没看过、灰呼吸 = 在跑；「今天」行和状态图标里「等你」的点也是 6px 黄", () => {
    const css = readFileSync(fileURLToPath(new URL("../../styles/home.module.css", import.meta.url)), "utf8");
    expect(css).toContain(".subDot i { width: 6px; height: 6px; border-radius: 50%; background: var(--ink-faint); }");
    expect(css).toContain('.subDot[data-tone="stopped"] i { background: var(--accent); }');
    expect(css).toContain('.subDot[data-tone="attention"] i { background: var(--warning); }');
    expect(css).toContain(".count i { width: 6px; height: 6px; border-radius: 50%; background: var(--warning); }");
    expect(css).toContain('.state[data-state="waiting"] i { width: 6px; height: 6px; border-radius: 50%; background: var(--warning); }');
    expect(css).not.toMatch(/\.cells\b/);
  });

  it("点的节奏：透明度 1 ↔ 0.3、1.4 秒一个来回、缓入缓出一直循环；减少动态效果时不闪", () => {
    const css = readFileSync(fileURLToPath(new URL("../../styles/home.module.css", import.meta.url)), "utf8");
    expect(css).toContain('.subDot[data-tone="running"] i { animation: workingBreath 1.4s ease-in-out infinite; }');
    expect(css).toContain("@keyframes workingBreath { 50% { opacity: .3; } }");
    expect(css).toContain("@media (prefers-reduced-motion: reduce) { .subDot i { animation: none !important; } }");
  });
});
