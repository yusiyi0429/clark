import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkspaceTestProvider } from "@/components/shell/testing";

const nav = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn(), notFound: vi.fn(() => { throw new Error("NEXT_404"); }), redirect: vi.fn((href: string) => { throw new Error(`NEXT_REDIRECT:${href}`); }) }));
vi.mock("next/navigation", () => ({ useRouter: () => nav, notFound: nav.notFound, redirect: nav.redirect }));
const api = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/lib/api/client", async (original) => ({ ...(await original<typeof import("@/lib/api/client")>()), serverApi: { GET: api.get } }));

import { MemberRadarScreen } from "./MemberRadarScreen";
import { MemberSignalScreen } from "./MemberSignalScreen";
import { loadMyRadar, loadMyRadarSignal, loadMyRadarSignals } from "./loadMyRadar";
import type { MyRadar, PersonalSignal, PersonalSignalBrief } from "./personalRadar";

const radar: MyRadar = {
  enabled: true,
  directions: [{ id: "d_1", text: "Agent 的定价方式" }],
  sources: [],
  updatedAt: "2026-09-26T02:00:00.000Z",
  lastRun: { trigger: "scheduled", status: "completed", completedAt: "2026-09-27T00:10:00.000Z", createdSignals: 0, warnings: [] },
  unreadCount: 0,
  webSearch: true,
  suggestions: { directions: [], sources: [] },
};
function brief(id: string, title: string, publishedAt: string, state: Partial<PersonalSignalBrief["state"]> = {}): PersonalSignalBrief {
  return {
    id,
    source: { type: "outlet", label: "金融时报", title, url: `https://www.ft.com/${id}`, publishedAt, listedOn: null },
    direction: { id: "d_1", text: "Agent 的定价方式" },
    summary: `${title}的一句总结`,
    reason: `${title}和定价方式直接相关`,
    relevance: 4,
    state: { read: false, saved: false, dismissed: false, ...state },
    collectedAt: publishedAt,
  };
}
const list = [
  brief("a1b2c3d4-0000-4000-8000-000000000001", "旧的一条", "2026-09-24T02:00:00.000Z", { read: true }),
  brief("a1b2c3d4-0000-4000-8000-000000000002", "新的一条", "2026-09-26T02:00:00.000Z", { saved: true }),
  brief("a1b2c3d4-0000-4000-8000-000000000003", "隐藏的一条", "2026-09-27T02:00:00.000Z", { dismissed: true }),
];
const render = (value: MyRadar, signals: PersonalSignalBrief[] = []) =>
  renderToStaticMarkup(
    <WorkspaceTestProvider>
      <MemberRadarScreen radar={value} signals={signals} />
    </WorkspaceTestProvider>,
  );

beforeEach(() => vi.clearAllMocks());

describe("我的雷达（/me/radar）", () => {
  it("页头有「设置」和「刷新」；工具条只留全部／未读／收藏，没有按重要程度", () => {
    const html = render(radar, list);
    expect(html).toContain(">我的雷达<");
    expect(html).toContain('aria-label="雷达设置"');
    expect(html).toContain('aria-label="刷新我的雷达"');
    for (const label of ["全部", "未读", "收藏"]) expect(html).toContain(label);
    expect(html).not.toContain("按重要程度");
    expect(html).toContain("定时扫描已完成 · 9/27 08:10 · 新增 0 条 · 0 条未读");
  });

  it("信号卡：href 是 /me/radar/signals/<id>，没有图片；来源一行带命中的方向；按时间排，隐藏的不出现", () => {
    const html = render(radar, list);
    expect(html).toContain('data-origin="/me/radar/signals/a1b2c3d4-0000-4000-8000-000000000002"');
    expect(html).not.toContain('data-origin="/radar/signals/');
    expect(html).not.toContain("<img");
    expect(html).toContain("金融时报 · 2026/9/26 · Agent 的定价方式");
    expect(html).toContain(">已收藏<");
    expect(html).toContain(">已读<");
    expect(html).not.toContain("隐藏的一条");
    expect(html.indexOf("新的一条")).toBeLessThan(html.indexOf("旧的一条"));
  });

  it("三种空态各说各的：第一次还没扫完、扫完 0 条、扫描失败（写原因并给重试）", () => {
    const first = render({ ...radar, lastRun: null });
    expect(first).toContain("第一次扫描还没完成，稍等片刻");
    const queued = render({ ...radar, lastRun: { trigger: "manual", status: "queued", queuedAt: "2026-09-27T00:00:00.000Z", createdSignals: 0, warnings: [] } });
    expect(queued).toContain("第一次扫描还没完成，稍等片刻");
    expect(queued).toContain("正在扫描外部信息");
    const empty = render(radar);
    expect(empty).toContain("这段时间没有和你方向相关的新内容");
    expect(empty).not.toContain("第一次扫描");
    const failed = render({ ...radar, lastRun: { trigger: "scheduled", status: "failed", completedAt: "2026-09-27T00:10:00.000Z", createdSignals: 0, warnings: ["检索服务暂时不可用"] } });
    expect(failed).toContain("扫描失败");
    expect(failed).toContain("检索服务暂时不可用");
    expect(failed).toContain(">重试<");
    expect(failed).not.toContain("这段时间没有和你方向相关的新内容");
    for (const html of [first, empty]) expect(html).not.toContain(">重试<");
  });

  it("雷达关着：写明关闭并给「打开」；已经收到的信号仍在；不再有刷新", () => {
    const off = render({ ...radar, enabled: false });
    expect(off).toContain("雷达已关闭。打开后，我每天按你的方向替你看一遍。");
    expect(off).toContain(">打开<");
    expect(off).not.toContain('aria-label="刷新我的雷达"');
    const kept = render({ ...radar, enabled: false }, list);
    expect(kept).toContain("雷达已关闭。打开后，我每天按你的方向替你看一遍。");
    expect(kept).toContain("新的一条");
  });
});

describe("个人信号阅读（/me/radar/signals/[id]）", () => {
  const signal: PersonalSignal = { ...list[0], excerpt: "第一段原文。", fullText: true, evidenceQuote: "第一段原文" };

  it("与公司信号同一份正文：和你的方向、命中理由；返回我的雷达；继续浏览也是个人信号的地址", () => {
    const html = renderToStaticMarkup(
      <WorkspaceTestProvider>
        <MemberSignalScreen signal={signal} list={list} />
      </WorkspaceTestProvider>,
    );
    expect(html).toContain("信号详情 · 我的雷达");
    expect(html).toContain("返回我的雷达");
    expect(html).toContain(">和你的方向<");
    expect(html).toContain("旧的一条和定价方式直接相关");
    expect(html).toContain("你的方向 · Agent 的定价方式");
    expect(html).toContain("发布方原文（自动抓取）");
    expect(html).toContain('data-origin="/me/radar/signals/a1b2c3d4-0000-4000-8000-000000000002"');
    expect(html).not.toContain("隐藏的一条");
    expect(html).not.toContain("<img");
    expect(html).toContain('aria-label="收藏信号"');
    expect(html).toContain("标记为未读");
  });

  it("隐藏后留在原地，可以当场恢复", () => {
    const html = renderToStaticMarkup(
      <WorkspaceTestProvider>
        <MemberSignalScreen signal={{ ...signal, state: { ...signal.state, dismissed: true } }} list={[]} />
      </WorkspaceTestProvider>,
    );
    expect(html).toContain("恢复到阅读列表");
    expect(html).toContain("这条已从阅读列表隐藏；需要时可以恢复。");
  });
});

describe("我的雷达服务端读取", () => {
  it("带成员 cookie 读本人接口", async () => {
    api.get.mockResolvedValue({ response: { ok: true, status: 200 }, data: { signals: list } });
    expect(await loadMyRadarSignals("session=test")).toEqual(list);
    expect(api.get).toHaveBeenCalledWith("/api/me/radar/signals", { headers: { cookie: "session=test" } });
  });

  it("不存在、属于别人都是 404；登录失效回锁屏并保留深链；服务失败不能伪装成没有", async () => {
    api.get.mockResolvedValue({ response: { ok: false, status: 404 } });
    await expect(loadMyRadarSignal("session=test", "x")).rejects.toThrow("NEXT_404");
    api.get.mockResolvedValue({ response: { ok: false, status: 401 } });
    await expect(loadMyRadarSignal("session=test", "abc")).rejects.toThrow("NEXT_REDIRECT:/access?next=%2Fme%2Fradar%2Fsignals%2Fabc");
    await expect(loadMyRadar("session=test")).rejects.toThrow("NEXT_REDIRECT:/access?next=%2Fme%2Fradar");
    api.get.mockResolvedValue({ response: { ok: false, status: 503 } });
    await expect(loadMyRadarSignals("session=test")).rejects.toThrow("503");
    expect(nav.notFound).toHaveBeenCalledTimes(1);
  });
});
