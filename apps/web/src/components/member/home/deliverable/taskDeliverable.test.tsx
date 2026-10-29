import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { TDeliverableVersion, THomePlanTask, TTaskDeliverableResponse } from "@warmap/contracts";

/** 交付物面板：数据换成固定的几种状态，看每一种画出了什么（没有 jsdom，只看第一屏）。 */
const state = vi.hoisted(() => ({ data: null as unknown }));
vi.mock("./useTaskDeliverable", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./useTaskDeliverable")>()),
  useTaskDeliverable: () => ({ data: state.data, error: null, createVersion: vi.fn(), deliver: vi.fn(), withdraw: vi.fn(), retry: vi.fn(),
    dissent: vi.fn(), patchNote: vi.fn(), itemHref: (id: string) => `/api/plan-tasks/t1/deliverable/items/${id}` }),
}));
vi.mock("@/components/AccountMenu", () => ({ avatarInitial: (name: string) => [...name][1] ?? name }));

import { TaskDeliverable } from "./TaskDeliverable";
import { fileProblem, normalizeLink } from "./DeliverableComposer";
import { about, clock, itemState, statusChip, versionLabel } from "./deliverableFormat";

const task: THomePlanTask = { taskId: "t1", missionId: "m1", name: "对话质量达标", doneDefinition: null, criteria: ["10/26 进程内发布，10/28 随上线", "题库打分 75 分且无否决项"] };
const criteria = task.criteria;
const review = (patch: Partial<TDeliverableVersion["review"]> = {}): TDeliverableVersion["review"] => ({
  status: "done", phase: null, startedAt: "2026-10-29T10:00:00.000Z", finishedAt: "2026-10-29T10:01:52.000Z", expectedSeconds: 120,
  basis: "acceptance", headline: "还差第 2 条：缺题库打分结果", summary: "第 1 条有据可查；内网监控面板打不开，没算进依据。", gain: null,
  score: 50, met: 1, total: 2, ready: false, error: null,
  criteria: [
    { index: 1, text: criteria[0], verdict: "met", reason: "上线记录里有 10/28 21:40 的正式环境部署和健康检查。", evidence: "10-28 上线记录.pdf 第 2 页", fix: null, dissent: null },
    { index: 2, text: criteria[1], verdict: "unmet", reason: "交付物里没有题库打分结果，只有对话截图。", evidence: "上线截图.png：首页一轮问答，没有分数。", fix: "传题库评测报告，要有总分和否决项那一栏。", dissent: null },
  ],
  ...patch,
});
const version = (patch: Partial<TDeliverableVersion> = {}): TDeliverableVersion => ({
  id: "11111111-1111-4111-8111-111111111111", number: 2, statement: null, createdAt: "2026-10-29T10:00:00.000Z",
  items: [
    { id: "21111111-1111-4111-8111-111111111111", kind: "file", name: "10-28 上线记录.pdf", mimeType: "application/pdf", sizeBytes: 1000, pageCount: 6, url: null, read: "read", readNote: null },
    { id: "31111111-1111-4111-8111-111111111111", kind: "link", name: "内网监控面板", mimeType: null, sizeBytes: null, pageCount: null, url: "https://grafana.internal/d/1", read: "unreadable", readNote: "打不开 · 请导出后上传" },
  ],
  review: review(), deliveredAt: null, note: null, ...patch,
});
const deliverable = (patch: Partial<TTaskDeliverableResponse> = {}): TTaskDeliverableResponse => ({
  taskId: "t1", responsibleId: "sun", responsibleName: "孙铭泽", canEdit: true, basis: "acceptance", criteria, versions: [], ...patch,
});
const render = (data: TTaskDeliverableResponse) => {
  state.data = data;
  return renderToStaticMarkup(<TaskDeliverable task={task} activities={<div data-columns />} activityCount={3} />);
};
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const button = (html: string, label: string) => html.match(new RegExp(`<button[^>]*>${label}</button>`))?.[0] ?? null;

beforeEach(() => { state.data = null; });

describe("Task 交付物面板", () => {
  it("还没交：负责人、按什么评；空心圈列出标准；下面是放置区（上传文件、粘贴链接、说说现状）；没有交付按钮", () => {
    const html = render(deliverable());
    expect(text(html)).toContain("孙铭泽");
    expect(text(html)).toContain("本体 · 验收标准 2 条");
    expect(text(html)).toContain(criteria[1]);
    for (const label of ["上传文件", "粘贴链接", "说说现状"]) expect(button(html, label)).not.toBeNull();
    expect(button(html, "评审这一版")).toMatch(/disabled/);
    expect(button(html, "交付")).toBeNull();
    expect(button(html, "取消")).toBeNull();
    // 我的事项折着，执行事项三栏不画出来。
    expect(text(html)).toContain("我的事项 3");
    expect(html).not.toContain("data-columns");
  });

  it("评审中：几步走到哪、已用 / 预计；底部写评审中，交付不能点", () => {
    const html = render(deliverable({ versions: [version({ review: review({ status: "running", phase: { step: 3, total: 4, label: "对照第 2 条" }, criteria: [], score: null, met: 0, total: 0 }) })] }));
    expect(html).toMatch(/data-state="done"[^>]*>.*?读交付物（2 份）/);
    expect(html).toMatch(/data-state="now"[^>]*>.*?对照第 2 条/);
    expect(text(html)).toMatch(/已用 \d+:\d{2} \/ 约 2 分钟/);
    expect(text(html)).toContain("评审中");
    expect(button(html, "交付")).toMatch(/disabled/);
  });

  it("报告：还差 1 条——圆环 1/2、一句结论；没达到的那条带依据、怎么补和「我不同意」；读不了的链接写原因", () => {
    const html = render(deliverable({ versions: [version()] }));
    expect(text(html)).toContain("1/2");
    expect(text(html)).toContain("还差第 2 条：缺题库打分结果");
    expect(text(html)).toContain("按本体验收标准评 · 读了 1 份 · 用时 1 分 52 秒");
    expect(html).toMatch(/data-verdict="unmet"/);
    expect(text(html)).toContain("怎么补 传题库评测报告");
    expect(button(html, "我不同意")).not.toBeNull();
    expect(text(html)).toContain("打不开 · 请导出后上传");
    expect(text(html)).toContain("还差 1 条");
    expect(button(html, "交付")).toMatch(/disabled/);
    expect(html).toContain('href="/api/plan-tasks/t1/deliverable/items/21111111-1111-4111-8111-111111111111"');
  });

  it("每一条都达到：交付可以点", () => {
    const ready = review({ met: 2, score: 100, ready: true, headline: "2 条都达到了",
      criteria: review().criteria.map((row) => ({ ...row, verdict: "met" as const, fix: null })) });
    const html = render(deliverable({ versions: [version({ review: ready })] }));
    expect(button(html, "交付")).not.toMatch(/disabled/);
    expect(button(html, "我不同意")).toBeNull();
  });

  it("已交付：伙伴写的说明、「已交付 · 撤回」；不再有交付按钮和圆环", () => {
    const ready = review({ met: 2, score: 100, ready: true, criteria: review().criteria.map((row) => ({ ...row, verdict: "met" as const, fix: null })) });
    const html = render(deliverable({ versions: [version({ review: ready, deliveredAt: new Date(Date.now() - 12 * 60_000).toISOString(),
      note: { status: "done", achieved: "v2 达成了：对话质量过了 75 分线", gain: "补上题库评测，78 分、没有否决项。", why: "评测口径定成「75 分加否决」。", lesson: null, edited: false, dismissed: false } })] }));
    expect(text(html)).toContain("v2 达成了：对话质量过了 75 分线");
    expect(text(html)).toContain("这一版多做到的：补上题库评测");
    expect(text(html)).toContain("已交付 · 12 分钟");
    for (const label of ["撤回", "改一改", "不要这段"]) expect(button(html, label)).not.toBeNull();
    expect(button(html, "交付")).toBeNull();
    expect(html).not.toContain("<svg class");
  });

  it("不是负责人：只看，不出放置区、底部动作和「我不同意」；本体没登记负责人时写「负责人未登记」", () => {
    const html = render(deliverable({ canEdit: false, versions: [version()] }));
    for (const label of ["上传新版本", "说说现状", "交付", "我不同意"]) expect(button(html, label)).toBeNull();
    expect(text(render(deliverable({ responsibleId: null, responsibleName: null })))).toContain("负责人未登记");
  });

  it("没有可对照的标准：只写这一句，不出放置区", () => {
    const html = render(deliverable({ basis: "none", criteria: [] }));
    expect(text(html)).toContain("没有可对照的标准");
    expect(button(html, "上传文件")).toBeNull();
  });
});

describe("格式与校验", () => {
  it("左边 Task 卡的状态小标", () => {
    expect(statusChip(undefined)).toEqual({ label: "未开始", tone: "plain" });
    expect(statusChip({ status: "iterating", score: 50 })).toEqual({ label: "迭代中 · 50", tone: "judgment" });
    expect(statusChip({ status: "ready", score: 100 }).label).toBe("可以交付");
    expect(statusChip({ status: "delivered", score: 100 }).tone).toBe("confirmed");
  });
  it("版本小字、材料状态、用时", () => {
    expect(versionLabel(version())).toBe("v2 · 50");
    expect(versionLabel(version({ review: review({ status: "running" }) }))).toBe("v2 · 评审中");
    expect(versionLabel(version({ deliveredAt: "2026-10-29T10:00:00.000Z" }))).toBe("v2 · 已交付");
    expect(itemState(version().items[0])).toBe("已读 · 6 页");
    expect(itemState(version().items[1])).toBe("打不开 · 请导出后上传");
    expect(clock(41)).toBe("0:41");
    expect(about(120)).toBe("约 2 分钟");
  });
  it("放进来的文件和链接先在页面上挡一遍", () => {
    expect(fileProblem(new File(["x"], "a.pdf"))).toBeNull();
    expect(fileProblem(new File(["x"], "a.zip"))).toBe("支持 PDF、Word、Markdown、HTML 和图片");
    expect(fileProblem(Object.defineProperty(new File(["x"], "a.png"), "size", { value: 6 * 1024 * 1024 }))).toBe("图片不能超过 5 MB");
    expect(normalizeLink(" https://example.com/a ")).toBe("https://example.com/a");
    expect(normalizeLink("ftp://example.com")).toBeNull();
    expect(normalizeLink("不是链接")).toBeNull();
  });
});
