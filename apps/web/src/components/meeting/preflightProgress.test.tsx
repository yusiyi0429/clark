import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { TPreflightProgress } from "@warmap/contracts";
import type { Card } from "@/lib/api/client";
import { MeetingCard, PREFLIGHT_POLL_MS } from "@/cards/MeetingCard";
import { PreflightProgress, durationText, offsetText } from "./PreflightProgress";

vi.mock("@/components/shell/WorkspaceContext", () => ({ useWorkspace: () => ({ homeCards: [], closing: false }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined, push: () => undefined }) }));

const T0 = "2026-10-13T06:00:00.000Z";
const at = (seconds: number) => new Date(Date.parse(T0) + seconds * 1000).toISOString();
const step = (key: string, kind: string, label: string, seconds: number, state: "active" | "done" = "done", detail?: string) =>
  ({ key, kind, label, state, at: at(seconds), updatedAt: at(seconds), ...(detail ? { detail } : {}) }) as TPreflightProgress["steps"][number];

const running: TPreflightProgress = {
  startedAt: T0, updatedAt: at(75),
  thought: "核对上游合作条件",
  steps: [
    step("collect", "input", "已读取会前资料", 1),
    step("material:a", "input", "已读取《Fireworks 国内对标 V2》第 1 版，共 315 段", 1),
    step("meeting:m", "history", "已找到同一战场的近期会议：7/12《词元云集公司业务战略与产品部署讨论会》，9 条会后决定待确认", 1),
    step("analysis", "thinking", "正在对照 7/12《词元云集公司业务战略与产品部署讨论会》的会后决定，分析材料", 2, "active"),
    step("knowledge:1", "knowledge", "已查找企业知识「词元云集 责任边界」", 18, "done", "找到 3 节：《词元云集》"),
    step("material_questions", "material_question", "正在逐条判断材料自带的 5 道待决题（2/5）", 64, "active"),
    step("material_question:1", "material_question", "第 1 题「首批 Token 上游」：负责人职责内可定", 66),
  ],
};

describe("预审过程可见", () => {
  it("运行中：显示进行中的那一步、思考要点、每一步的时间点，没有百分比", () => {
    const html = renderToStaticMarkup(<PreflightProgress progress={running} status="running" />);
    expect(html).toContain("预审进度");
    expect(html).toContain("正在逐条判断材料自带的 5 道待决题（2/5）");
    expect(html).toContain("思考要点");
    expect(html).toContain("核对上游合作条件");
    expect(html).toContain("0:18");
    expect(html).toContain("1:06");
    expect(html).toContain("找到 3 节：《词元云集》");
    expect(html).not.toMatch(/\d+%/);
  });

  it("完成后收成一行：用时与步数，可点开", () => {
    const done = { ...running, finishedAt: at(133), thought: undefined, steps: running.steps.map((item) => ({ ...item, state: "done" as const })) };
    const html = renderToStaticMarkup(<PreflightProgress progress={done} status="ready" />);
    expect(html).toContain("<details");
    expect(html).toContain("预审过程 · 用时 2 分 13 秒 · 7 步");
    expect(html).not.toContain("思考要点");
  });

  it("时间写法", () => {
    expect(durationText(42_000)).toBe("42 秒");
    expect(durationText(65_000)).toBe("1 分 05 秒");
    expect(offsetText(T0, at(135))).toBe("2:15");
  });

  it("预审进行中每两秒取一次卡片", () => {
    expect(PREFLIGHT_POLL_MS).toBe(2000);
  });

  it("新加的样式只用 13 / 12 号字，没有新颜色", () => {
    const css = readFileSync(join(import.meta.dirname, "../../styles/meeting-workspace.module.css"), "utf8");
    const block = css.slice(css.indexOf("/* 会前预审过程（v4）"));
    const sizes = new Set([...block.matchAll(/font-size:(\d+)px/g)].map((match) => match[1]));
    expect([...sizes].sort()).toEqual(["12", "13"]);
    const before = css.slice(0, css.indexOf("/* 会前预审过程（v4）")).toLowerCase();
    for (const color of block.match(/#[0-9a-f]{3,8}\b/gi) ?? []) expect(before, color).toContain(color.toLowerCase());
  });
});

function meetingCard(preflight: Record<string, unknown>): Card {
  return {
    schemaVersion: 1, id: "meeting:1", version: 1, kind: "meeting", objectRef: { type: "meeting", id: "1", version: 1 }, title: "Token 上游合作讨论会",
    payload: {
      status: "scheduled", scheduledAt: "2026-10-14T02:00:00.000Z", endsAt: "2026-10-14T03:30:00.000Z", endedAt: null, recording: null,
      leadDriId: "p1", ceoParticipantId: "p2",
      participants: [
        { personId: "p1", displayName: "陈砚", roles: ["dri"], sourceRef: "person:p1", updatedAt: "2026-10-01" },
        { personId: "p2", displayName: "林岚", roles: ["ceo"], sourceRef: "person:p2", updatedAt: "2026-10-01" },
      ],
      issueIds: [], originRef: null,
      preflight: {
        status: "ready", pendingSince: null, runId: "run-1", basis: "读取了群材料", brief: "先定底层延伸的边界", error: null,
        generatedAt: "2026-10-13T06:03:00.000Z", readiness: "revise",
        summary: { criticalIssue: "触发条件缺可核验口径", priorityAction: "会上请一号位选定边界" },
        taskDefinition: { materialPurpose: "讨论合作方式", reviewPurpose: "判断哪些题需要一号位", primaryRole: "strategic_judgment", secondaryRole: null,
          maturity: "internal_alignment", readerAction: "选定边界", nonGoal: "不做采购决定" },
        inputCoverage: { background: "available", purpose: "derived", sourceMaterial: "available", relatedMeeting: "available" },
        entries: [
          { id: "entry-1", kind: "core_judgment", title: "先定边界", body: "近期坚持合作优先", sourceRefs: ["meeting:1"] },
          { id: "entry-2", kind: "leader_lens", title: "触发条件", body: "向底层延伸的触发条件由谁按什么口径核验？", sourceRefs: ["meeting:1"],
            ceoDecision: { whyNow: "合作条款本月谈定", whyCeo: "涉及跨战场资本承诺", options: [
              { label: "已有可核验口径", impact: "可以把延伸条件写进本次决定" },
              { label: "还没有口径", impact: "本次只定合作优先，延伸另议" }] } },
        ],
        ...preflight,
      },
      draft: { readIssueIds: [], carriedIssueIds: [], checkedEntryIds: [], editsByEntryId: {}, supplementRequests: [], note: "" },
      transcript: null, transcriptCandidate: null, outcome: null, materials: [],
    },
    actions: [],
  } as unknown as Card;
}

const render = (value: Card) => renderToStaticMarkup(
  <MeetingCard card={value} collection={[value]} onCard={() => undefined} onNavigate={() => undefined} readOnly={false} />,
);

describe("预审 v4 的结论段", () => {
  it("材料自带待决题逐条显示判断与理由；开放分歧按三类；追问写出不同回答的含义", () => {
    const html = render(meetingCard({
      materialQuestions: { total: 2, items: [
        { question: "是否在房懂懂 001 验证国产模型和国产卡", verdict: "ceo", reason: "改变灯塔项目范围和成本，跨战场", sourceRefs: ["meeting:1"] },
        { question: "首批上游选谁", verdict: "owner", reason: "负责人职责内可定", sourceRefs: ["meeting:1"] },
      ] },
      divergences: [
        { type: "value_tradeoff", title: "合作优先还是提前投入底层", body: "两种目标之间的取舍", sourceRefs: ["meeting:1"] },
        { type: "judgment", title: "硅基流动与路由的重叠", body: "两种看法", converged: "都认可先做路由评测", sourceRefs: ["meeting:1"] },
        { type: "fact_gap", title: "披露数字待核验", body: "速度与成本是企业披露", sourceRefs: ["meeting:1"] },
      ],
    }));
    for (const text of ["材料自带的待决题", "2 道 · 1 道需要一号位判断", "需要一号位判断", "改变灯塔项目范围和成本，跨战场", "负责人可定",
      "开放分歧", "价值取舍 · 需要一号位选择", "判断分歧 · 已收敛到哪里、还差什么", "已收敛", "都认可先做路由评测", "事实不足 · 转监测，不阻塞本次决定",
      "若回答「已有可核验口径」", "可以把延伸条件写进本次决定", "若回答「还没有口径」", "待决题与分歧"]) expect(html).toContain(text);
    // 价值取舍排在最前：剩下需要一号位选的先看。
    expect(html.indexOf("价值取舍 ·")).toBeLessThan(html.indexOf("判断分歧 ·"));
    expect(html.indexOf("判断分歧 ·")).toBeLessThan(html.indexOf("事实不足 ·"));
  });

  it("预审进行中：会议页显示过程，替代「进行中」的空白说明；刷新后从卡片里的进度接着显示", () => {
    const html = render(meetingCard({ status: "running", entries: [], progress: running }));
    expect(html).toContain("预审进度");
    expect(html).toContain("已找到同一战场的近期会议：7/12《词元云集公司业务战略与产品部署讨论会》，9 条会后决定待确认");
    expect(html).not.toContain("会前预审进行中，完成后在下方列出各议题判断。");
  });

  it("旧报告没有过程与新段落时照旧显示", () => {
    const html = render(meetingCard({}));
    expect(html).not.toContain("预审过程");
    expect(html).not.toContain("材料自带的待决题");
  });
});
