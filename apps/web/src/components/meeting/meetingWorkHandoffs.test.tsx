import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import type { TMeetingWorkFeedItem, TMeetingWorkReceipt } from "@warmap/contracts";

const hooks = vi.hoisted(() => ({ active: false, position: 0, values: [] as unknown[], effects: [] as (() => void | (() => void))[] }));
const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("react", async (original) => {
  const real = await original<typeof import("react")>();
  return { ...real,
    useState: (initial: unknown) => {
      if (!hooks.active) return real.useState(initial);
      const values = hooks.values;
      const index = hooks.position++;
      if (!(index in values)) values[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
      return [values[index], (next: unknown) => { values[index] = typeof next === "function" ? (next as (old: unknown) => unknown)(values[index]) : next; }];
    },
    useEffect: (effect: () => void | (() => void), deps?: unknown[]) => hooks.active ? hooks.effects.push(effect) : real.useEffect(effect, deps),
  };
});
vi.mock("@/lib/api/client", () => ({ browserApi: { GET: api.get, POST: api.post } }));
import { ConfirmAndHandOff, MeetingWorkFeedEntry, suggestedMeetingTarget, useMeetingWorkHandoffFeed } from "./MeetingWorkHandoffs";

const item: TMeetingWorkFeedItem = {
  kind: "meeting_handoff", id: "00000000-0000-4000-8000-000000000003", at: "2026-11-13T09:31:00Z",
  target: { kind: "topic", projectId: "00000000-0000-4000-8000-000000000001", id: "00000000-0000-4000-8000-000000000002", projectName: "品牌建设", name: "官网" },
  conclusion: { confirmationRef: "00000000-0000-4000-8000-000000000004", requestId: "nexus-1", itemId: "change-1", meetingId: "external-meeting",
    revision: 4, confirmedAt: "2026-11-13T09:30:00Z", confirmedBy: "owner", decision: "amended", question: "首页方向如何调整？",
    content: { classification: "fact", targetRef: "homepage", value: "本人改后的首页方向" },
    source: { id: "minutes-1", version: "v2", hash: "hash", minutesRef: "https://example.com/minutes",
      quote: null, readState: "reference_only", reference: null, turnId: null } },
  instruction: "延续原版", criteria: [{ kind: "task", id: "task1", revision: null, index: 1, text: "核对页面文案" }],
  authorizedAt: "2026-11-13T09:30:30Z", authorizedBy: "owner", superseded: false,
};

const receipt = (status: TMeetingWorkReceipt["status"], id = "receipt-1"): TMeetingWorkReceipt => ({
  id, target: { kind: item.target.kind, projectId: item.target.projectId, id: item.target.id },
  status, instruction: "保留本人交代", reason: status === "failed" ? "权限已变化" : null,
  authorizedAt: item.authorizedAt, deliveredAt: status === "delivered" ? item.at : null,
});
const listeners = new Map<string, Set<() => void>>();
const cleanups: (() => void)[] = [];
const drive = <T,>(render: () => T): T => {
  hooks.position = 0; hooks.effects = []; hooks.active = true;
  try { return render(); } finally { hooks.active = false; }
};
const effects = () => hooks.effects.forEach(effect => { const cleanup = effect(); if (cleanup) cleanups.push(cleanup); });
const nodes = (value: ReactNode): ReactElement<Record<string, unknown>>[] => {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!isValidElement<Record<string, unknown>>(value)) return [];
  return [value, ...nodes(value.props.children as ReactNode)];
};
const drawCard = (node: ReactNode) => {
  if (!isValidElement(node) || typeof node.type !== "function") throw new Error("Expected a handoff card");
  return drive(() => (node.type as (props: unknown) => ReactNode)(node.props));
};
async function feed(receipts: TMeetingWorkReceipt[], targets = [item.target], conclusion = item.conclusion) {
  api.get.mockImplementation(async (path: string) => ({ response: { ok: true }, data: path.endsWith("-targets") ? { targets } : { items: [{ conclusion, receipts }] } }));
  drive(useMeetingWorkHandoffFeed); effects();
  await vi.waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
  return drive(useMeetingWorkHandoffFeed);
}

beforeEach(() => {
  hooks.active = false; hooks.position = 0; hooks.values = []; hooks.effects = []; listeners.clear();
  api.get.mockReset(); api.post.mockReset();
  vi.stubGlobal("window", { location: { hash: "" }, addEventListener: (name: string, listener: () => void) => {
    listeners.set(name, new Set([...(listeners.get(name) ?? []), listener]));
  }, removeEventListener: (name: string, listener: () => void) => listeners.get(name)?.delete(listener) });
});
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); vi.unstubAllGlobals(); });

describe("会议变化在原工作中可读", () => {
  it("建议去向只使用本人可选的同一个本体 Task 标识", () => {
    const task = { ...item.target, kind: "task" as const };
    expect(suggestedMeetingTarget(task.id + "@5", [item.target, task])).toBe(task);
    expect(suggestedMeetingTarget(task.id, [item.target])).toBeNull();
    expect(suggestedMeetingTarget(task.name, [task])).toBeNull();
  });
  it("展示确认原文、本次交代、可打开的真实去向和来源读取状态", () => {
    const html = renderToStaticMarkup(<MeetingWorkFeedEntry item={item} />);
    for (const text of ["已递送", "本人改后的首页方向", "延续原版", "核对页面文案", "仅有出处", "external-meeting", "确认版本 4",
      "https://example.com/minutes", `/me/work/topics/${item.target.id}`]) expect(html).toContain(text);
    expect(html).not.toContain("已开工");
    expect(html).not.toContain("/meetings/external-meeting");
  });
  it("过期的版本保留历史标识，出处只显示 Nexus 提供的片段", () => {
    const updated = { ...item, superseded: true, conclusion: { ...item.conclusion, source: { ...item.conclusion.source, readState: "excerpt" as const, quote: "本次摘录" } } };
    const html = renderToStaticMarkup(<MeetingWorkFeedEntry item={updated} />);
    expect(html).toContain("此确认已被新版替代");
    expect(html).toContain("已收到摘录");
    expect(html).toContain("本次摘录");
  });
  it("待确认项先让本人选择去向", () => {
    const html = renderToStaticMarkup(<ConfirmAndHandOff requestId="request-row" onConfirmed={() => undefined} />);
    expect(html).toContain("选择去向并确认");
    expect(html).not.toContain("已递送");
  });
});

describe("会后变化进入伙伴时间线", () => {
  it("按确认时间生成稳定区块，刷新仍保留同一个 key", async () => {
    let surface = await feed([receipt("delivered")]);
    expect(surface.blocks).toHaveLength(1);
    expect(surface.blocks[0]).toMatchObject({ key: `meeting-handoff:${item.conclusion.confirmationRef}`, at: item.conclusion.confirmedAt });
    const html = renderToStaticMarkup(surface.blocks[0].node);
    expect(html).toContain(`dateTime="${item.conclusion.confirmedAt}"`);
    expect(html).toContain("已递送 <strong>1</strong>");
    expect(html).toContain("待递送 <strong>0</strong>");
    expect(html).toContain("失败 <strong>0</strong>");
    expect(html).toContain("下一步");
    listeners.get("tianshu:meeting-work-confirmed")?.forEach(listener => listener());
    surface = drive(useMeetingWorkHandoffFeed); effects();
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledTimes(4));
    expect(drive(useMeetingWorkHandoffFeed).blocks[0].key).toBe(surface.blocks[0].key);
  });

  it("确认时间按公司时区跨日展示，时间线排序与 dateTime 保留原始时刻", async () => {
    const confirmedAt = "2026-11-13T17:30:00Z";
    const surface = await feed([], [item.target], { ...item.conclusion, confirmedAt });
    const html = renderToStaticMarkup(surface.blocks[0].node);
    expect(html).toContain("确认于 11/14 01:30 北京时间");
    expect(html).toContain(`dateTime="${confirmedAt}"`);
    expect(surface.blocks[0].at).toBe(confirmedAt);
  });

  it("已完成去向退出可选列表后仍可打开历史，同时不会恢复到选择器", async () => {
    const surface = await feed([receipt("delivered")], []);
    const html = renderToStaticMarkup(surface.blocks[0].node);
    expect(html).toContain(`href="/me/work/topics/${item.target.id}">打开去向</a>`);
    expect(html).toContain("历史去向");
    expect(html).toMatch(/<details[^>]*><summary>递送明细/);
    expect(html).not.toMatch(/<details[^>]*open=""[^>]*><summary>递送明细/);
    hooks.values = [];
    let card = drawCard(surface.blocks[0].node);
    const add = nodes(card).find(node => node.type === "button" && node.props.children === "添加工作去向");
    expect(add).toBeDefined();
    (add!.props.onClick as () => void)();
    card = drawCard(surface.blocks[0].node);
    const picker = nodes(card).find(node => node.props.action === "继续推进");
    expect(picker?.props.targets).toEqual([]);
    expect(picker?.props.excluded).toEqual([receipt("delivered")]);
    expect(api.post).not.toHaveBeenCalled();
  });

  it("待递送与失败均显式展示，失败重试沿用原目标、交代、确认版本和授权", async () => {
    const failed = receipt("failed");
    const pending = { ...receipt("pending", "receipt-2"), target: { ...item.target, kind: "task" as const, id: "pending-task" } };
    const surface = await feed([failed, pending]);
    const html = renderToStaticMarkup(surface.blocks[0].node);
    expect(html).toContain("已递送 <strong>0</strong>");
    expect(html).toContain("待递送 <strong>1</strong>");
    expect(html).toContain("失败 <strong>1</strong>");
    expect(html).toContain("权限已变化");
    expect(html).toContain("重试此去向");
    expect(html).toContain("递送此去向");
    expect(html).toMatch(/<details[^>]*open=""[^>]*><summary>递送明细/);
    const feedValues = hooks.values;
    hooks.values = [];
    const tree = drawCard(surface.blocks[0].node);
    const retry = nodes(tree).find(node => node.type === "button" && node.props.children === "重试此去向");
    api.post.mockResolvedValue({ response: { ok: true }, data: { receipts: [{ ...failed, status: "delivered", reason: null }] } });
    (retry!.props.onClick as () => void)();
    await vi.waitFor(() => expect(api.post).toHaveBeenCalledOnce());
    expect(api.post).toHaveBeenCalledWith("/api/me/meeting-work-handoffs/{confirmationRef}", {
      params: { path: { confirmationRef: item.conclusion.confirmationRef } },
      body: { authorization: "continue", revision: 4, targets: [{ ...failed.target, instruction: failed.instruction }] },
    });
    hooks.values = feedValues;
    await vi.waitFor(() => {
      const saved = renderToStaticMarkup(drive(useMeetingWorkHandoffFeed).blocks[0].node);
      expect(saved).toContain("已递送 <strong>1</strong>");
      expect(saved).toContain("待递送 <strong>1</strong>");
      expect(saved).toContain("失败 <strong>0</strong>");
    });
  });

  it("重试被拒绝时保留失败回执和可再试的动作，并显示服务端原因", async () => {
    const surface = await feed([receipt("failed")]);
    hooks.values = [];
    const retry = nodes(drawCard(surface.blocks[0].node)).find(node => node.type === "button" && node.props.children === "重试此去向");
    api.post.mockResolvedValue({ response: { ok: false, status: 403 }, error: { message: "当前没有递送权限" } });
    (retry!.props.onClick as () => void)();
    await vi.waitFor(() => {
      const failed = drawCard(surface.blocks[0].node);
      expect(nodes(failed).some(node => node.props.role === "alert" && node.props.children === "当前没有递送权限")).toBe(true);
    });
    const card = drawCard(surface.blocks[0].node);
    const again = nodes(card).find(node => node.type === "button" && node.props.children === "重试此去向");
    expect(again?.props.disabled).toBe(false);
    expect(renderToStaticMarkup(surface.blocks[0].node)).toContain("失败 <strong>1</strong>");
  });

  it("深链在初次载入和 hashchange 时展开来源/明细并聚焦对应卡", async () => {
    const surface = await feed([receipt("delivered")]);
    hooks.values = [];
    const disclosures = [{ open: false }, { open: false }];
    const article = { querySelectorAll: () => disclosures, scrollIntoView: vi.fn(), focus: vi.fn() };
    const find = vi.fn(() => article);
    vi.stubGlobal("document", { getElementById: find });
    window.location.hash = `#meeting-work-${item.conclusion.confirmationRef}`;
    drawCard(surface.blocks[0].node); effects();
    expect(find).toHaveBeenCalledWith(`meeting-work-${item.conclusion.confirmationRef}`);
    expect(disclosures.every(detail => detail.open)).toBe(true);
    expect(article.focus).toHaveBeenCalledWith({ preventScroll: true });
    disclosures.forEach(detail => { detail.open = false; });
    window.location.hash = "#meeting-work-other";
    listeners.get("hashchange")?.forEach(listener => listener());
    expect(disclosures.every(detail => !detail.open)).toBe(true);
    window.location.hash = `#meeting-work-${item.conclusion.confirmationRef}`;
    listeners.get("hashchange")?.forEach(listener => listener());
    expect(article.focus).toHaveBeenCalledTimes(2);
    expect(disclosures.every(detail => detail.open)).toBe(true);
  });

  it("去向读取失败保留已确认变化及历史路由，并提供可重试提示", async () => {
    api.get.mockImplementation(async (path: string) => {
      if (path.endsWith("-targets")) throw new Error("暂时离线");
      return { response: { ok: true }, data: { items: [{ conclusion: item.conclusion, receipts: [receipt("delivered")] }] } };
    });
    drive(useMeetingWorkHandoffFeed); effects();
    await vi.waitFor(() => expect(renderToStaticMarkup(drive(useMeetingWorkHandoffFeed).notice)).toContain("工作去向读取失败 · 连不上天枢，请稍后再试"));
    const surface = drive(useMeetingWorkHandoffFeed);
    expect(surface.blocks).toHaveLength(1);
    expect(renderToStaticMarkup(surface.blocks[0].node)).toContain(`href="/me/work/topics/${item.target.id}">打开去向</a>`);
    expect(renderToStaticMarkup(surface.notice)).toContain("重试");
  });
});
