import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/me/work" }));
vi.mock("@/lib/board/cloud", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/board/cloud")>()), acceptDrafts: vi.fn(async () => []) }));

import { acceptDrafts } from "@/lib/board/cloud";
import { relativeDayTime } from "@/lib/companyTime";
import { waitingHref } from "@/lib/home/derive";
import type { WaitingItem } from "@/lib/home/types";
import type { WorkHomeApi } from "@/lib/home/useWorkHome";
import { LocalContext, type LocalRunnerState } from "@/lib/local/LocalRunnerProvider";
import { createMockRunner } from "@/lib/local/mock";
import type { Worker } from "@/lib/work/workers";
import { WaitingList, dueText, waitingAnswer } from "./HomeView";

const HERE = "00000000-0000-4000-8000-00000000d001";
const THERE = "00000000-0000-4000-8000-00000000d002";
const SESSION = "00000000-0000-4000-8000-0000000000a1";
const NOW = Date.parse("2026-11-07T04:00:00Z");
const HOUR = 3_600_000;
const NOW_ISO = new Date(NOW).toISOString();
const at = (ms: number) => new Date(NOW + ms).toISOString();

const wait = (extra: Partial<WaitingItem>): WaitingItem => ({
  id: "w1", kind: "verdict", title: "greet 连续两次没过", source: "首页改版 · greet", at: "2026-11-07T03:00:00Z", open: { kind: "project", id: "p1" },
  taskId: "t1", projectId: "p1", sessionId: null, deviceId: null, deviceName: null, dueAt: null, answer: "open", person: null, month: null, question: null, permission: null, ...extra,
});
const local = (phase = "ready", sessions: unknown[] = []) => ({ runner: createMockRunner(), phase, version: null, status: null, models: [], folders: [], sessions, pairing: null, error: null,
  refresh: vi.fn(), pair: vi.fn(), unpair: vi.fn(), pickFolder: vi.fn(), setIncludePersonal: vi.fn() }) as unknown as LocalRunnerState;
const api = ({ workers = [], boards = {} }: { workers?: unknown[]; boards?: Record<string, { drafts: { id: string }[] }> } = {}) =>
  ({ deviceId: HERE, work: { workers, boards }, refresh: vi.fn() }) as unknown as WorkHomeApi;
/** 这台电脑上在等你批准的那个子会话（就地答只看 session）。 */
const approvalWorker = { session: { id: SESSION, pendingQuestion: null } } as unknown as Worker;
const approval = (extra: Partial<WaitingItem> = {}) => wait({ id: "a1", kind: "approval", title: "要运行命令", sessionId: SESSION, deviceId: HERE, answer: "inline_local", ...extra });
const render = (items: WaitingItem[], { phase = "ready", home = api() }: { phase?: string; home?: WorkHomeApi } = {}) =>
  renderToStaticMarkup(<LocalContext.Provider value={local(phase)}><WaitingList items={items} api={home} go={() => undefined} /></LocalContext.Provider>);
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); vi.mocked(acceptDrafts).mockClear(); });

describe("等你行的截止（5.4.4「时间只写截止」）", () => {
  it("一天以上写天，不到 24 小时写小时，不到 1 小时写分钟，过了写「已过截止」；后三档是警告色", () => {
    expect(dueText(at(49 * HOUR), NOW)).toEqual({ text: "剩 2 天", warn: false });
    expect(dueText(at(24 * HOUR), NOW)).toEqual({ text: "剩 1 天", warn: false });
    expect(dueText(at(24 * HOUR - 1), NOW)).toEqual({ text: "剩 23 小时", warn: true });
    expect(dueText(at(5 * HOUR + 59 * 60_000), NOW)).toEqual({ text: "剩 5 小时", warn: true });
    expect(dueText(at(20 * 60_000), NOW)).toEqual({ text: "剩 20 分钟", warn: true });
    expect(dueText(at(10_000), NOW)).toEqual({ text: "剩 1 分钟", warn: true });
    expect(dueText(at(0), NOW)).toEqual({ text: "已过截止", warn: true });
    expect(dueText(at(-HOUR), NOW)).toEqual({ text: "已过截止", warn: true });
  });

  it("第二行：请你认可的先是对方的头像和名字，再来源，再截止；没截止的不写时间，时间在这一行的 title 里", () => {
    const html = render([wait({ id: "c1", kind: "acceptance", title: "请你认可「首页改版」", source: "首页改版", person: { personId: "p-wang", name: "王明" },
      open: { kind: "task_detail", id: "t9" }, dueAt: at(49 * HOUR) })]);
    expect(text(html)).toMatch(/请你认可「首页改版」 王明 · 首页改版 · 剩 2 天/);
    expect(html).toMatch(/<span[^>]*data-testid="wait-due"[^>]*>剩 2 天</);
    expect(html).not.toContain("data-warn");
    expect(html).not.toMatch(/<li[^>]*title=/);

    const plain = render([wait({})]);
    expect(plain).toMatch(new RegExp(`<button[^>]*title="${relativeDayTime("2026-11-07T03:00:00Z", new Date(NOW))}"`));
    expect(relativeDayTime("2026-11-07T03:00:00Z", new Date(NOW))).toMatch(/^今天 \d\d:\d\d$/);
    expect(plain).not.toMatch(/<li[^>]*title=/);
    expect(plain).not.toContain("wait-due");
    expect(text(plain)).toContain("首页改版 · greet");
  });

  it("不到 24 小时、已过截止换警告档", () => {
    expect(render([wait({ dueAt: at(5 * HOUR) })])).toMatch(/data-warn=""[^>]*>剩 5 小时</);
    expect(render([wait({ dueAt: at(-60_000) })])).toMatch(/data-warn=""[^>]*>已过截止</);
  });

  it("额度那条的 dueAt 是恢复时刻，不当截止写", () => {
    const html = render([wait({ id: "q1", kind: "quota", title: "Claude 订阅额度用完 · 08:00 恢复", source: "停着 2 件", dueAt: at(4 * HOUR), open: { kind: "connections", id: "this_computer" } })]);
    expect(html).not.toContain("wait-due");
  });
});

describe("就地答（9.6，契约 WaitingAnswer）", () => {
  it("inline_local：在 deviceId 那台电脑上、本机就绪才画按钮", () => {
    const home = api({ workers: [approvalWorker] });
    // 批准旁边是「换个做法」：进那个子会话去说（5.4.4、9.6）。
    expect(waitingAnswer(approval(), { api: home, local: local(), handheld: false })).toMatchObject({ actions: [{ label: "批准", done: "已批准", primary: true }, { label: "换个做法", href: waitingHref(approval()) }], away: null });
    const html = render([approval()], { home });
    expect(text(html)).toContain("批准");
    expect(html).not.toContain("wait-away");
  });

  it("契约的 permission、question（aa6aba9e）：有越界路径的不就地批、来源后面写越界路径；单选最多 3 个选项的就地答，三个都画", () => {
    const home = api({ workers: [] });
    const outside = approval({ permission: { requestId: "r1", toolName: "Write", title: "写 /etc/hosts", outsidePaths: ["/etc/hosts"] } });
    expect(waitingAnswer(outside, { api: home, local: local(), handheld: false }).actions).toEqual([{ label: "去看看", href: waitingHref(outside) }]);
    expect(text(render([outside], { home }))).toContain("越界：/etc/hosts");
    const plain = approval({ permission: { requestId: "r2", toolName: "Bash", title: "运行 pnpm test", outsidePaths: [] } });
    expect(waitingAnswer(plain, { api: home, local: local(), handheld: false }).actions.map((action) => action.label)).toEqual(["批准", "换个做法"]);
    const options = ["A", "B", "C"].map((label) => ({ label, description: "" }));
    const asked = approval({ kind: "question", question: { requestId: "q1", askedAt: NOW_ISO, questions: [{ header: "", question: "选哪个？", options, multiSelect: false }] } });
    expect(waitingAnswer(asked, { api: home, local: local(), handheld: false }).actions.map((action) => action.label)).toEqual(["A", "B", "C"]);
  });

  it("别的电脑、手机、本机没就绪：不画按钮，画「等你 · 电脑名」，没有名字写「那台电脑」", () => {
    const home = api({ workers: [approvalWorker] });
    expect(waitingAnswer(approval({ deviceId: THERE, deviceName: "ThinkPad" }), { api: home, local: local(), handheld: false })).toEqual({ actions: [], away: "等你 · ThinkPad" });
    expect(waitingAnswer(approval({ deviceName: "ThinkPad" }), { api: home, local: local(), handheld: true })).toEqual({ actions: [], away: "等你 · ThinkPad" });
    expect(waitingAnswer(approval(), { api: home, local: local("offline"), handheld: false })).toEqual({ actions: [], away: "等你 · 那台电脑" });
    const merge = wait({ id: "m1", kind: "merge", title: "合进 main", sessionId: SESSION, deviceId: THERE, answer: "inline_local", open: { kind: "card", id: "c1" } });
    expect(waitingAnswer(merge, { api: home, local: local(), handheld: false })).toEqual({ actions: [], away: "等你 · 那台电脑" });
    const mergeHere = { ...merge, deviceId: HERE, deviceName: "这台电脑" };
    const sessions = [{ id: SESSION, workspace: { kind: "worktree", baseBranch: "main" } }];
    expect(waitingAnswer(mergeHere, { api: home, local: local("ready", sessions), handheld: false }).actions.map((action) => action.label)).toEqual(["合进 main"]);
    expect(waitingAnswer(mergeHere, { api: home, local: local("checking", sessions), handheld: false })).toEqual({ actions: [], away: "等你 · 这台电脑" });

    const html = render([approval({ deviceId: THERE, deviceName: "ThinkPad" })], { home });
    expect(html).toMatch(/data-testid="wait-away"[^>]*><i aria-hidden="true"><\/i>等你 · ThinkPad</);
    expect(text(html)).not.toContain(" 批准 ");
  });

  it("就在这台电脑上、但不是单选的问题：不画按钮也不画 chip，整行点进去", () => {
    const question = { requestId: "r1", questions: [{ question: "选哪个？", header: "", multiSelect: false, options: ["甲", "乙", "丙", "丁"].map((label) => ({ label, description: "" })) }] };
    const worker = { session: { id: SESSION, pendingQuestion: question } } as unknown as Worker;
    const item = approval({ kind: "question", title: "选哪个？" });
    expect(waitingAnswer(item, { api: api({ workers: [worker] }), local: local(), handheld: false })).toEqual({ actions: [], away: null });
  });

  it("开工（inline）：「开始」接受派活单并登记开工，「改一改」进项目对话；手机上也能", async () => {
    const home = api({ boards: { t1: { drafts: [{ id: "d1" }, { id: "d2" }] } } });
    const item = wait({ id: "plan_start:t1", kind: "plan_start", title: "首页改版：这样开工？", source: "2 步", answer: "inline" });
    const { actions, away } = waitingAnswer(item, { api: home, local: local("offline"), handheld: true });
    expect(away).toBeNull();
    expect(actions).toMatchObject([{ label: "开始", done: "已开工", primary: true }, { label: "改一改", href: "/me/work/projects/p1" }]);
    const start = actions[0]!;
    if (!("run" in start)) throw new Error("「开始」要能就地办");
    await start.run();
    expect(acceptDrafts).toHaveBeenCalledWith("t1", [{ id: "d1" }, { id: "d2" }], true);

    expect(text(render([item], { home }))).toMatch(/开始 .*改一改/);
    expect(waitingAnswer(item, { api: api(), local: local(), handheld: false }).actions).toEqual([]);
  });

  it("岗位建议照旧「采纳 / 不要」；open 的整行点进去，没有按钮和 chip", () => {
    const role = wait({ id: "proposal:r1", kind: "role", title: "开发的说明改一句", answer: "inline", open: { kind: "role", id: "r1" } });
    expect(waitingAnswer(role, { api: api(), local: local(), handheld: true }).actions.map((action) => action.label)).toEqual(["采纳", "不要"]);
    for (const kind of ["verdict", "acceptance", "month", "device", "quota", "meeting", "mission_card"] as const) {
      expect(waitingAnswer(wait({ kind }), { api: api(), local: local(), handheld: false })).toEqual({ actions: [], away: null });
    }
  });
});
