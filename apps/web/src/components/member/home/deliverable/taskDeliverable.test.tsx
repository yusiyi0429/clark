import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { TDeliverableVersion, THomePlanTask, TTaskAgreementResponse, TTaskCheckCriterion, TTaskCheckResponse, TTaskDeliverableResponse } from "@warmap/contracts";
import type { TaskAgreementApi } from "./useTaskAgreement";

/** 交付物面板：数据换成固定的几种状态，看每一种画出了什么（没有 jsdom，只看第一屏）。约定与对表的数据同样换成固定的（state.pact）。 */
const state = vi.hoisted(() => ({ data: null as unknown, pact: null as unknown }));
vi.mock("./useTaskDeliverable", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./useTaskDeliverable")>()),
  useTaskDeliverable: () => ({ data: state.data, error: null, createVersion: vi.fn(), deliver: vi.fn(), withdraw: vi.fn(), retry: vi.fn(),
    dissent: vi.fn(), patchNote: vi.fn(), itemHref: (id: string) => `/api/plan-tasks/t1/deliverable/items/${id}` }),
}));
vi.mock("./useTaskAgreement", () => ({ useTaskAgreement: () => state.pact }));
vi.mock("@/components/AccountMenu", () => ({ avatarInitial: (name: string) => [...name][1] ?? name }));

import { TaskDeliverable } from "./TaskDeliverable";
import { ReviewHeader } from "./ReviewHeader";
import { CriteriaList } from "./CriteriaList";
import { fileProblem, normalizeLink } from "./DeliverableComposer";
import { about, clock, itemState, statusChip, versionLabel } from "./deliverableFormat";
import { agreementBody, checkText } from "./Agreement";

const task: THomePlanTask = { taskId: "t1", missionId: "m1", name: "对话质量达标", doneDefinition: null, criteria: ["10/26 进程内发布，10/28 随上线", "题库打分 75 分且无否决项"] };
const criteria = task.criteria;
const review = (patch: Partial<TDeliverableVersion["review"]> = {}): TDeliverableVersion["review"] => ({
  status: "done", phase: null, startedAt: "2026-10-29T10:00:00.000Z", finishedAt: "2026-10-29T10:01:52.000Z", expectedSeconds: 120,
  basis: "acceptance", headline: "还差第 2 条：缺题库打分结果", summary: "第 1 条有据可查；内网监控面板打不开，没算进依据。", gain: null, mismatch: null,
  score: 50, met: 1, total: 2, ready: false, error: null, beyondScope: [],
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
const pact = (patch: Partial<TaskAgreementApi> = {}): TaskAgreementApi => ({
  agreement: null, check: null, checking: false, checkError: null, asked: [], feishuOff: false,
  runCheck: vi.fn(), save: vi.fn(), notify: vi.fn(), ...patch,
});
const render = (data: TTaskDeliverableResponse, agreementApi: TaskAgreementApi = pact()) => {
  state.data = data;
  state.pact = agreementApi;
  return renderToStaticMarkup(<TaskDeliverable task={task} activities={<div data-columns />} activityCount={3} newItem={<span data-new-item />} />);
};
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const button = (html: string, label: string) => html.match(new RegExp(`<button[^>]*>${label}</button>`))?.[0] ?? null;

beforeEach(() => { state.data = null; state.pact = pact(); });

const yang = { personId: "yang", name: "杨主任" };
const agreement = (patch: Partial<TTaskAgreementResponse> = {}): TTaskAgreementResponse => ({
  taskId: "t1", taskName: task.name, missionId: "m1", basis: "acceptance", source: "none",
  criteria: criteria.map((text, index) => ({ index: index + 1, text, proof: null, acceptor: null })),
  exclusions: [], complete: false, basisChanged: false, canEdit: true, updatedBy: null, updatedAt: null, ...patch,
});
const row = (index: number, status: TTaskCheckCriterion["status"], patch: Partial<TTaskCheckCriterion> = {}): TTaskCheckCriterion => ({
  index, text: criteria[index - 1], status, proof: null, acceptor: null, evidence: null, gap: null, notifiedToday: false, ...patch,
});
const evidence = { versionId: "11111111-1111-4111-8111-111111111111", versionNumber: 2, locator: "第 2 页",
  items: [{ id: "21111111-1111-4111-8111-111111111111", kind: "file" as const, name: "10-28 上线记录.pdf", url: null }] };
const check = (patch: Partial<TTaskCheckResponse> = {}): TTaskCheckResponse => ({
  taskId: "t1", verdict: "not_ready", conclusion: "还不能交：差第 2 条（传题库评测报告）。", notices: [], source: "tianshu",
  criteria: [row(1, "evidenced", { evidence }), row(2, "gap", { gap: "传题库评测报告，要有总分和否决项那一栏。" })],
  version: { id: evidence.versionId, number: 2, reviewStatus: "done", deliveredAt: null }, beyondScope: [], canNotify: true, ...patch,
});
/** 第 n 条标准（li）的整段。 */
const item = (html: string, n: number) => html.match(/<li[^>]*>.*?<\/li>/g)?.filter((li) => li.includes("criterionText"))[n - 1] ?? "";

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
    // 我的事项默认展开，新建键在那一行。
    expect(text(html)).toContain("我的事项 3");
    expect(html).toContain("data-columns");
    expect(html).toContain("data-new-item");
  });

  it("参考评审在跑：收成一行「参考评审 · 评审中」，交付等它跑完", () => {
    const html = render(deliverable({ versions: [version({ review: review({ status: "running", phase: { step: 3, total: 4, label: "对照第 2 条" }, criteria: [], score: null, met: 0, total: 0 }) })] }));
    expect(text(html)).toContain("参考评审 · 评审中");
    expect(html).not.toMatch(/data-state="now"/);
    expect(text(html)).toContain("参考评审中");
    expect(button(html, "交付")).toMatch(/disabled/);
  });

  it("评审只作参考：收成一行「参考评审 · 1/2」，不画圆环和逐条判定；没都达到也能交付；读不了的链接写原因", () => {
    const html = render(deliverable({ versions: [version()] }));
    expect(text(html)).toContain("参考评审 · 1/2");
    expect(text(html)).not.toContain("还差第 2 条：缺题库打分结果");
    expect(html).not.toMatch(/data-verdict=/);
    expect(button(html, "我不同意")).toBeNull();
    expect(text(html)).toContain(criteria[1]);
    expect(text(html)).not.toContain("还差 1 条");
    expect(button(html, "交付")).not.toMatch(/disabled/);
    expect(text(html)).toContain("打不开 · 请导出后上传");
    expect(html).toContain('href="/api/plan-tasks/t1/deliverable/items/21111111-1111-4111-8111-111111111111"');
  });

  it("点开参考评审：圆环 1/2、一句结论、按什么评；没达到的那条带依据、怎么补和「我不同意」", () => {
    const header = renderToStaticMarkup(<ReviewHeader version={version()} basis="acceptance" criteriaCount={2} canEdit onRetry={() => undefined} />);
    expect(text(header)).toContain("1/2");
    expect(text(header)).toContain("还差第 2 条：缺题库打分结果");
    expect(text(header)).toContain("按本体验收标准评 · 读了 1 份 · 用时 1 分 52 秒");
    const list = renderToStaticMarkup(<CriteriaList title="验收标准" texts={criteria} results={review().criteria} canDissent onDissent={async () => null} />);
    expect(list).toMatch(/data-verdict="unmet"/);
    expect(text(list)).toContain("怎么补 传题库评测报告");
    expect(button(list, "我不同意")).not.toBeNull();
  });

  it("评审中点开参考评审：几步走到哪、已用 / 预计", () => {
    const running = version({ review: review({ status: "running", phase: { step: 3, total: 4, label: "对照第 2 条" }, criteria: [], score: null, met: 0, total: 0 }) });
    const header = renderToStaticMarkup(<ReviewHeader version={running} basis="acceptance" criteriaCount={2} canEdit onRetry={() => undefined} />);
    expect(header).toMatch(/data-state="done"[^>]*>.*?读交付物（2 份）/);
    expect(header).toMatch(/data-state="now"[^>]*>.*?对照第 2 条/);
    expect(text(header)).toMatch(/已用 \d+:\d{2} \/ 约 2 分钟/);
  });

  it("材料和这个 Task 对不上：版本上方提醒一句，交付照样能点", () => {
    const html = render(deliverable({ versions: [version({ review: review({ mismatch: "这份材料像是「会议内容写进本体」的交付物" }) })] }));
    expect(text(html)).toContain("这份材料像是「会议内容写进本体」的交付物");
    expect(button(html, "交付")).not.toMatch(/disabled/);
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
    expect(text(html)).not.toContain("参考评审");
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

describe("约定与对表", () => {
  it("没补约定：每条下面是「补约定」，列表底部「这次不包括」带「补」；标题行有「对表」，还没对过就不画结果", () => {
    const html = render(deliverable({ versions: [version()] }), pact({ agreement: agreement() }));
    expect(html.match(/<button[^>]*>补约定<\/button>/g)).toHaveLength(2);
    expect(text(html)).toContain("这次不包括 补");
    expect(button(html, "对表")).not.toMatch(/disabled/);
    expect(text(html)).not.toMatch(/证明：|11 月补充/);
    expect(html).not.toMatch(/data-verdict=/);
    expect(html).not.toContain("标准改过");
  });

  it("补了一半：写了的那条是「证明：…」「认可：X」和小字「11 月补充」，点这一行就能改；没写的那条还是「补约定」", () => {
    const html = render(deliverable({ versions: [version()] }), pact({ agreement: agreement({ source: "tianshu", updatedAt: "2026-11-06T02:00:00.000Z", updatedBy: { personId: "sun", name: "孙铭泽" },
      criteria: [{ index: 1, text: criteria[0], proof: "正式环境部署记录和健康检查截图", acceptor: yang }, { index: 2, text: criteria[1], proof: null, acceptor: null }],
      exclusions: ["客户版的对话质量"] }) }));
    expect(text(item(html, 1))).toContain("证明：正式环境部署记录和健康检查截图 认可：杨主任 11 月补充");
    expect(item(html, 1)).toMatch(/<button[^>]*aria-label="改第 1 条的约定"/);
    expect(item(html, 1)).not.toContain("补约定");
    expect(item(html, 2)).toContain(">补约定</button>");
    expect(text(html)).toContain("这次不包括 改 客户版的对话质量");
  });

  it("「谁来认」留空：只写证明，不写认可", () => {
    const html = render(deliverable(), pact({ agreement: agreement({ source: "tianshu", complete: true,
      criteria: [{ index: 1, text: criteria[0], proof: "上线记录", acceptor: null }, { index: 2, text: criteria[1], proof: "评测报告", acceptor: null }] }) }));
    expect(text(item(html, 1))).toContain("证明：上线记录 11 月补充");
    expect(text(html)).not.toContain("认可：");
  });

  it("约定来自本体：只读——小字「本体」，没有「补约定」、改的键和「这次不包括」的「改」", () => {
    const html = render(deliverable({ versions: [version()] }), pact({ agreement: agreement({ source: "world", canEdit: false, complete: true,
      criteria: [{ index: 1, text: criteria[0], proof: "上线记录", acceptor: yang }, { index: 2, text: criteria[1], proof: "题库评测报告", acceptor: null }],
      exclusions: ["客户版"] }) }));
    expect(text(item(html, 1))).toContain("证明：上线记录 认可：杨主任 本体");
    expect(item(html, 1)).not.toMatch(/aria-label="改第/);
    expect(html).not.toContain("补约定");
    expect(button(html, "改")).toBeNull();
    expect(text(html)).toContain("这次不包括 客户版");
  });

  it("不能改又没补过：不出约定行，也不出空的「这次不包括」", () => {
    const html = render(deliverable({ canEdit: false }), pact({ agreement: agreement({ canEdit: false }) }));
    expect(html).not.toContain("补约定");
    expect(text(html)).not.toContain("这次不包括");
  });

  it("对表 · 还不能交：服务端给的提示在前、结论在后，放在列表上面；差的那条写差什么、画 ✗；有证据的写第几版、哪份材料、定位、画 ✓", () => {
    const html = render(deliverable({ versions: [version()] }), pact({ agreement: agreement(), check: check({
      notices: [{ code: "agreement_incomplete", text: "约定还没补全：第 2 条没写用什么证明。" }] }) }));
    const summary = html.match(/<div[^>]*data-verdict="not_ready"[^>]*>.*?<\/div>/)?.[0] ?? "";
    expect(text(summary)).toBe("约定还没补全：第 2 条没写用什么证明。 还不能交：差第 2 条（传题库评测报告）。");
    expect(html.indexOf("还不能交")).toBeLessThan(html.indexOf(criteria[0]));
    expect(text(item(html, 1))).toContain("有证据 · v2 · 10-28 上线记录.pdf · 第 2 页");
    expect(item(html, 1)).toMatch(/data-verdict="met"/);
    expect(text(item(html, 2))).toContain("差：传题库评测报告，要有总分和否决项那一栏。");
    expect(item(html, 2)).toMatch(/data-verdict="unmet"/);
  });

  it("对表 · 差的那条在最新一版评审里是部分达到：圈画半个", () => {
    const partial = review({ criteria: review().criteria.map((row) => (row.index === 2 ? { ...row, verdict: "partial" as const } : row)) });
    const html = render(deliverable({ versions: [version({ review: partial })] }), pact({ check: check() }));
    expect(item(html, 2)).toMatch(/data-verdict="partial"/);
  });

  it("对表 · 评审中、还没交付物：各写一句，圈是空的", () => {
    const html = render(deliverable({ versions: [version()] }), pact({ check: check({ criteria: [row(1, "reviewing"), row(2, "no_deliverable")] }) }));
    expect(text(item(html, 1))).toContain("评审中");
    expect(text(item(html, 2))).toContain("还没交付物");
    expect(item(html, 1) + item(html, 2)).not.toMatch(/data-verdict=/);
  });

  it("对表 · 可以交：绿底结论；要别人确认的那条写「要杨主任确认」，旁边「请杨主任看」；下次可以做单列，不进结论", () => {
    const html = render(deliverable({ versions: [version()] }), pact({ check: check({ verdict: "ready",
      conclusion: "约定的 2 条都有证据了，可以交。交之前请杨主任确认第 1 条。再改要重新谈范围。",
      criteria: [row(1, "needs_acceptor", { acceptor: yang, evidence }), row(2, "evidenced", { evidence })],
      beyondScope: ["把评测脚本放进仓库", "补一份客户版对照"] }) }));
    expect(html).toMatch(/data-verdict="ready"[^>]*role="status"/);
    expect(text(html)).toContain("约定的 2 条都有证据了，可以交。");
    expect(text(item(html, 1))).toContain("要杨主任确认 · v2 · 10-28 上线记录.pdf · 第 2 页");
    expect(button(item(html, 1), "请杨主任看")).not.toMatch(/disabled/);
    expect(item(html, 1)).toMatch(/data-verdict="met"/);
    expect(text(html)).toContain("下次可以做 2");
    expect(text(html)).not.toContain("把评测脚本放进仓库");
  });

  it("今天已请：服务端说今天请过，或这次刚请过，都写「今天已请」，不能再点；飞书没接时按钮置灰；不是负责人不出按钮", () => {
    const ready = (patch: Partial<TTaskCheckCriterion>, more: Partial<TTaskCheckResponse> = {}) => check({ verdict: "ready", conclusion: "可以交。",
      criteria: [row(1, "needs_acceptor", { acceptor: yang, evidence, ...patch }), row(2, "evidenced", { evidence })], ...more });
    const notified = render(deliverable({ versions: [version()] }), pact({ check: ready({ notifiedToday: true }) }));
    expect(text(item(notified, 1))).toContain("今天已请");
    expect(button(notified, "请杨主任看")).toBeNull();
    const asked = render(deliverable({ versions: [version()] }), pact({ check: ready({}), asked: [1] }));
    expect(text(item(asked, 1))).toContain("今天已请");
    expect(button(asked, "请杨主任看")).toBeNull();
    const off = render(deliverable({ versions: [version()] }), pact({ check: ready({}), feishuOff: true }));
    expect(button(off, "请杨主任看")).toMatch(/disabled/);
    const reader = render(deliverable({ canEdit: false, versions: [version()] }), pact({ check: ready({}, { canNotify: false }) }));
    expect(button(reader, "请杨主任看")).toBeNull();
    expect(text(item(reader, 1))).toContain("要杨主任确认");
  });

  it("标准改过：标题行小标「标准改过」，对表的提示里也有那一句", () => {
    const html = render(deliverable({ versions: [version()] }), pact({ agreement: agreement({ basisChanged: true, source: "tianshu" }),
      check: check({ notices: [{ code: "basis_changed", text: "本体里这个 Task 的标准改过，约定是照旧标准写的。" }] }) }));
    expect(html).toMatch(/<span[^>]*>标准改过<\/span>/);
    expect(text(html)).toContain("本体里这个 Task 的标准改过，约定是照旧标准写的。");
  });

  it("标准改过以后，列表写本体当前的标准（最新一版评审里还是旧的那句）；点开参考评审才看评审时的原文", () => {
    const html = render(deliverable({ criteria: [criteria[0], "题库打分 80 分且无否决项"], versions: [version()] }), pact({ agreement: agreement({ basisChanged: true }) }));
    expect(text(item(html, 2))).toContain("题库打分 80 分且无否决项");
    expect(text(html)).not.toContain(criteria[1]);
  });

  it("对表在跑：按钮写「对表中…」并置灰；没对成写服务端的那句话", () => {
    const html = render(deliverable({ versions: [version()] }), pact({ checking: true, checkError: "对表没成功，请重试" }));
    expect(button(html, "对表中…")).toMatch(/disabled/);
    expect(text(html)).toContain("对表没成功，请重试");
  });

  it("别人的 Task（不传 activities）：没有「我的事项」那一行，面板照样带对表结果", () => {
    state.data = deliverable({ canEdit: false, versions: [version()] });
    state.pact = pact({ check: check() });
    const html = renderToStaticMarkup(<TaskDeliverable task={{ taskId: "t1" }} checkOnOpen />);
    expect(text(html)).not.toContain("我的事项");
    expect(text(html)).toContain("还不能交");
    expect(html).toContain('data-plan-task="t1"');
  });

  it("存约定是整份覆盖：改一条时别的条目和「这次不包括」原样带上；改「这次不包括」时条目原样带上", () => {
    const current = agreement({ source: "tianshu", exclusions: ["客户版"],
      criteria: [{ index: 1, text: criteria[0], proof: "上线记录", acceptor: yang }, { index: 2, text: criteria[1], proof: null, acceptor: null }] });
    expect(agreementBody(current, { index: 2, proof: "评测报告", acceptorId: null })).toEqual({
      criteria: [{ index: 1, proof: "上线记录", acceptorId: "yang" }, { index: 2, proof: "评测报告", acceptorId: null }], exclusions: ["客户版"] });
    expect(agreementBody(current, { exclusions: [] })).toEqual({
      criteria: [{ index: 1, proof: "上线记录", acceptorId: "yang" }, { index: 2, proof: null, acceptorId: null }], exclusions: [] });
  });

  it("对表小字：差没有说明时只写「差」；要确认的人没名字时写「要认可人确认」；没有定位就不写", () => {
    expect(checkText(row(1, "gap"))).toBe("差");
    expect(checkText(row(1, "needs_acceptor"))).toBe("要认可人确认");
    expect(checkText(row(1, "evidenced", { evidence: { ...evidence, locator: null } }))).toBe("有证据 · v2 · 10-28 上线记录.pdf");
  });
});


describe("格式与校验", () => {
  it("左边 Task 卡的状态小标：未开始、已传 vN、已交付，不写分数", () => {
    expect(statusChip(undefined)).toEqual({ label: "未开始", tone: "plain" });
    expect(statusChip({ status: "none", score: null, version: null })).toEqual({ label: "未开始", tone: "plain" });
    expect(statusChip({ status: "iterating", score: 50, version: 2 })).toEqual({ label: "已传 v2", tone: "plain" });
    expect(statusChip({ status: "ready", score: 100, version: 3 }).label).toBe("已传 v3");
    expect(statusChip({ status: "reviewing", score: null, version: 1 }).label).toBe("已传 v1");
    expect(statusChip({ status: "delivered", score: 100, version: 2 })).toEqual({ label: "已交付", tone: "confirmed" });
  });
  it("版本小字、材料状态、用时", () => {
    expect(versionLabel(version())).toBe("v2");
    expect(versionLabel(version({ review: review({ status: "running" }) }))).toBe("v2");
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
