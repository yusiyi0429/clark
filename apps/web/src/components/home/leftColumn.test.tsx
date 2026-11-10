import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { THomeItem } from "@warmap/contracts";
import type { HomeProject, SubSession, WorkHomeData } from "@/lib/home/types";
import { fromHome, projectWorking } from "@/lib/home/projects";
import { LeftColumn, STAGE_BASE, letterOf, planOrder, stageScale, subLetters } from "./LeftColumn";

const data = { period: "2026-11", projects: [], archivedCount: 0, month: { missions: [] }, waiting: [], other: { subSessions: [], items: [] } } as unknown as WorkHomeData;
const projectsOf = (used: WorkHomeData) => used.projects.map((project) => fromHome(project, used, new Map()));
const render = (extra: Partial<Parameters<typeof LeftColumn>[0]>) => {
  const used = extra.data ?? data;
  return renderToStaticMarkup(
    <LeftColumn data={used} view={{ kind: "home" }} buddy={null} speaking={false} go={() => undefined} phone={false}
      account={{ displayName: "孙铭泽", role: "member" }} today="11 月 7 日 周六" alert={false}
      projects={projectsOf(used)} archived={[]} onCreate={async () => "x"} {...extra} />,
  );
};

describe("左栏：计划读不到、空月份（5.4.2、5.4.4）", () => {
  it("计划读不到时树最上面一行「本体读取失败」加「重试」，不画成空树", () => {
    const html = render({ onRetryPlan: () => undefined });
    expect(html).toContain('data-testid="plan-read-failed"');
    expect(html).toMatch(/本体读取失败.*重试/);
    expect(render({})).not.toContain("本体读取失败");
  });

  it("空月份：「今天」行行尾出「11 月待敲定」chip", () => {
    const html = render({ month: { href: "/me/work/month/2026-11", label: "11 月待敲定" } });
    expect(html).toMatch(/11 月 7 日 周六.*11 月待敲定/);
    expect(render({})).not.toContain("待敲定");
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
    expect(html).toMatch(/项目<\/span><button[^>]*aria-label="新建项目"/);
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

  it("会话默认收成一行「会话 N」，不列出来、不画点；后面不再有一排小方块（47 条：圆点只有一种）", () => {
    const sub = (id: string, state: string, waiting: unknown = null) => ({ id, kind: "card", title: `卡${id}`, state, waiting, updatedAt: "a", queueReason: null, holdUntil: null });
    const html = render({ data: withTask([], { subSessions: [sub("1", "running"), sub("2", "waiting", "question"), sub("3", "done")] as never }) });
    expect(html).toMatch(/aria-expanded="false"[^>]*data-testid="tree-subs".*会话 3/);
    expect(html).not.toMatch(/<i data-state=/);
    expect(html).toMatch(/会话 3<\/button>/);
    expect(html).not.toContain("卡1");
  });

  it("有已归档的：一行「已归档 N」，默认收起", () => {
    const html = render({ data: withTask([]), projects: [], archived: projectsOf(withTask([])).map((project) => ({ ...project, archived: true })) });
    expect(html).toMatch(/aria-expanded="false"[^>]*data-testid="tree-archived".*已归档 1/);
    expect(html).not.toContain('data-testid="tree-project"');
  });

  it("待归位的事项进「其他」：没有会话也画这一组", () => {
    expect(render({})).not.toContain('aria-label="其他"');
    const html = render({ data: { ...data, other: { subSessions: [], items: [item("00000000-0000-4000-8000-000000000003", "整理会议纪要", { dueDate: "2026-11-09" })] } } });
    expect(html).toMatch(/aria-label="其他".*其他.*data-testid="tree-item".*整理会议纪要.*11\/09/);
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

describe("子会话的字母和状态点（18.10）", () => {
  it("字母 A…Z 之后是 AA、AB；按建立先后排", () => {
    expect([0, 1, 25, 26, 27, 51, 52].map(letterOf)).toEqual(["A", "B", "Z", "AA", "AB", "AZ", "BA"]);
    const at = new Map([["c1", "2026-11-07T01:00:00.001Z"], ["c2", "2026-11-07T01:00:00.002Z"]]);
    const list = [{ id: "c2", kind: "card", updatedAt: "a" }, { id: "c1", kind: "card", updatedAt: "b" }] as unknown as SubSession[];
    expect([...subLetters(list, at)]).toEqual([["card:c1", "A"], ["card:c2", "B"]]);
    // 云端带了字母就照它的（删过的不复用，可以跳号）；null（「其他」里的）不画。
    const fromCloud = [{ id: "c1", kind: "card", letter: "A", updatedAt: "a" }, { id: "c3", kind: "card", letter: "C", updatedAt: "b" }, { id: "t1", kind: "topic", letter: null, updatedAt: "c" }] as unknown as SubSession[];
    expect([...subLetters(fromCloud, at)]).toEqual([["card:c1", "A"], ["card:c3", "C"]]);
  });

  it("行首字母方块；行尾在跑灰点、停了蓝点、要介入黄点，排队的行尾什么都不画（47 条）；读屏按状态读", () => {
    const sub = (id: string, state: string, waiting: unknown = null, queueReason: unknown = null, unseen = false) =>
      ({ id, kind: "card", title: `卡${id}`, state, waiting, updatedAt: id, queueReason, holdUntil: null, sessionId: null, unseen });
    const html = render({ data: { ...data, other: { subSessions: [sub("1", "running"), sub("2", "waiting", null, null, true), sub("3", "waiting", "approval"), sub("4", "queued", null, "prior_cards"), sub("5", "waiting")], items: [] } } as never });
    const rows = html.split('data-testid="tree-sub"').slice(1);
    expect(rows.map((row) => /data-testid="sub-letter">([A-Z]+)</.exec(row)?.[1])).toEqual(["A", "B", "C", "D", "E"]);
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
  const other = (updatedAt: string) => ({ ...data, other: { subSessions: [sub(updatedAt)], items: [] } }) as never;
  it("刚看过的（同一次停下）不画蓝点；之后来了更新的停下又画；刷新后没有这一页的记录，照云端画", () => {
    const seen = new Map([["sub:c2", "2026-11-09T03:00:00Z"]]);
    expect(render({ data: other("2026-11-09T03:00:00Z"), seen })).not.toContain("sub-dot");
    expect(render({ data: other("2026-11-09T03:05:00Z"), seen })).toMatch(/data-tone="stopped"[^>]*aria-label="已停下"/);
    expect(render({ data: other("2026-11-09T03:00:00Z") })).toMatch(/data-tone="stopped"[^>]*aria-label="已停下"/);
  });
  it("项目行同理：刚看过的不画，看过以后又有新回复的画", () => {
    const seen = new Map([["project:p1", "2026-11-07T01:00:00.000Z"]]);
    expect(render({ data: withTask([], { unseen: true }), seen })).not.toContain("project-unseen");
    expect(render({ data: withTask([], { unseen: true, lastActivityAt: "2026-11-07T02:00:00.000Z" }), seen })).toContain("project-unseen");
  });
});

describe("伙伴台「亮着」（17.2）：只在伙伴对话里", () => {
  it("别的页不亮；伙伴对话里空闲是 idle，回话流着是 speaking（在说或在想）", () => {
    expect(render({})).not.toContain("data-glow");
    expect(render({ view: { kind: "buddy" } })).toContain('data-glow="idle"');
    expect(render({ view: { kind: "buddy" }, speaking: true })).toContain('data-glow="speaking"');
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
    expect(html).toMatch(/首页改版<\/span><\/span><span class="[^"]*" data-tone="running" data-testid="project-working"><i aria-hidden="true"><\/i><span[^>]*>在后台工作<\/span><\/span><\/button>/);
    expect(render({ data: withTask([]) })).not.toContain("project-working");
    expect(render({ data: withTask([]), working: new Set(["p9"]) })).not.toContain("在后台工作");
  });

  it("项目对话有没看过的新回复（26 条）：行尾蓝点，同子会话的蓝点；在干活时照旧是灰点；看过的不画", () => {
    const unseen = render({ data: withTask([], { unseen: true }) });
    expect(unseen).toMatch(/<\/span><\/span><span class="[^"]*" data-tone="stopped" role="img" aria-label="有新回复" data-testid="project-unseen"><i aria-hidden="true"><\/i><\/span><\/button>/);
    expect(render({ data: withTask([], { unseen: true }), working: new Set(["p1"]) })).not.toContain("project-unseen");
    expect(render({ data: withTask([]) })).not.toContain("project-unseen");
  });

  it("等你的项目（34、47 条）：行最右边一颗黄点，和子会话行「要介入」的点同一个元素同一种颜色；等你时不再画在干活的灰点和新回复", () => {
    const waiting = withTask([], { summary: { running: 0, waiting: 1, queued: 0, done: 0, doneToday: 0, needsYou: 1 }, unseen: true } as never);
    const html = render({ data: waiting, working: new Set(["p1"]) });
    expect(html).toMatch(/<\/span><\/span><span class="[^"]*" data-tone="attention" role="img" aria-label="等你" data-testid="project-waiting"><i aria-hidden="true"><\/i><\/span><\/button>/);
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

describe("伙伴形象跟着台子缩放（17.2 第 15 条）", () => {
  it("按 1440 时（台子 255）的比例走，不比原来的小；矮屏台子变扁时跟着高度缩", () => {
    expect(stageScale(242, 242)).toBe(1);
    expect(stageScale(STAGE_BASE, STAGE_BASE)).toBe(1);
    expect(stageScale(344, 344)).toBeCloseTo(344 / 255);
    expect(stageScale(344, 172)).toBeCloseTo((344 / 255) / 2);
    expect(stageScale(242, 121)).toBeCloseTo(0.5);
    expect(stageScale(0, 0)).toBe(1);
  });
});
