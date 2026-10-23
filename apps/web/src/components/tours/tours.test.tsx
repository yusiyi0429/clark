import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { RELEASE } from "@/lib/releaseNotes";

const seenState = vi.hoisted(() => ({ seen: null as ReadonlySet<string> | null }));
vi.mock("@/lib/useSeenMarks", () => ({ useSeenMarks: () => ({ seen: seenState.seen, mark: vi.fn() }) }));

const { ReleaseNotesView } = await import("@/components/whatsNew/WhatsNewCard");
const { ExecutionItemsTourView, EXECUTION_TOUR_KEY } = await import("./ExecutionItemsTour");
const { MissionCardTourView, MISSION_CARD_TOUR_KEY } = await import("./MissionCardTour");
const { MISSION_CARD_TOUR_STEPS } = await import("./MissionCardScenes");
const { StartTaskButton } = await import("./StartTaskButton");
const { TOUR_STEPS } = await import("./TourScenes");

describe("更新说明卡片", () => {
  it("列出这一版的每一条更新，只有「知道了」和关闭两个出口", () => {
    const html = renderToStaticMarkup(<ReleaseNotesView onClose={vi.fn()} />);
    for (const item of RELEASE.items) expect(html).toContain(item);
    expect(html).toContain("知道了");
    expect(html).toContain('aria-label="关闭更新说明"');
    expect(html).not.toContain("天枢</text>");
  });
});

describe("执行事项演示", () => {
  it("第一幕没放完时「下一步」不可用，看完前的出口只有「跳过，直接进入」", () => {
    const html = renderToStaticMarkup(<ExecutionItemsTourView onExit={vi.fn()} />);
    expect(html).toContain("第 1 步，共 6 步");
    expect(html).toMatch(/data-ready="false" aria-disabled="true"/);
    expect(html).toContain("跳过，直接进入");
    for (const exit of ["稍后再说", "开启我的第一件", "关闭"]) expect(html).not.toContain(exit);
  });

  it("开头两幕照新首页：「开启执行事项」在三栏那一行，开好的事落在「本周」", () => {
    const [start, create] = TOUR_STEPS.map(({ Scene }) => renderToStaticMarkup(<Scene />));
    for (const html of [start, create]) {
      expect(html).toContain("本周 10/5–10/11");
      expect(html).not.toContain("项执行事项在推进");
    }
    expect(start).toContain("开启执行事项");
  });
});

describe("任务卡演示", () => {
  it("新流程使用独立已读版本，旧导览记录不能跳过本人确认说明", () => {
    expect(MISSION_CARD_TOUR_KEY).toBe("tour:mission-card:owner-confirmation-v2");
  });
  it("先解释目标与任务，看完前只能跳过直接进入", () => {
    const html = renderToStaticMarkup(<MissionCardTourView onExit={vi.fn()} />);
    expect(html).toContain("第 1 步，共 5 步");
    expect(html).toContain("长期目标");
    expect(html).toContain("本月目标");
    expect(html).toContain("执行拆分");
    expect(html).toContain("下一版开放");
    expect(html).toMatch(/data-ready="false" aria-disabled="true"/);
    expect(html).toContain("跳过，直接进入");
    expect(html).not.toContain("开始查看任务");
    expect(html).not.toContain("关闭");
  });

  it("第一幕从页头右侧展开视图菜单，任务细节已选中，执行拆分标为下一版", () => {
    const { Scene, duration } = MISSION_CARD_TOUR_STEPS[0];
    const html = renderToStaticMarkup(<Scene />);
    const header = /<header\b[^>]*>([\s\S]*?)<\/header>/.exec(html)?.[1];
    expect(header).toContain("孙铭泽 · 10月任务");
    expect(header).toContain("待本人确认");
    expect(html).toContain("流程示例");
    expect(header).toContain("任务细节");
    expect(header).toMatch(/data-selected="true"[^>]*>[\s\S]*?任务细节/);
    expect(header).toMatch(/data-disabled="true"[^>]*>[\s\S]*?执行拆分[\s\S]*?<small>下一版<\/small>/);
    expect(header).toContain('--t:1100ms;--len:1160ms');
    expect(html).not.toContain('data-active="true"');
    expect(duration).toBe(2700);
  });

  it("选字有两种入口，批注旁输入和即时澄清保留修改记录，引用带入私聊", () => {
    const scenes = MISSION_CARD_TOUR_STEPS.map(({ Scene }) => renderToStaticMarkup(<Scene />));
    expect(scenes[1]).toContain("直接批注");
    expect(scenes[1]).toContain("引用并对话");
    expect(scenes[2]).not.toContain("同卡成员可见");
    expect(scenes[2]).toContain("写下修改意见");
    expect(scenes[2]).toContain("保存");
    expect(scenes[2]).toContain("立即修改");
    expect(scenes[2]).toContain("正文保持原样");
    expect(MISSION_CARD_TOUR_STEPS[2].body).toContain("也可以确认任务");
    expect(scenes[3]).toContain("逐项核对每个字段");
    expect(scenes[3]).toContain("自己输入");
    expect(scenes[3]).toContain("原文与依据");
    expect(scenes[3]).not.toContain("<del");
    expect(scenes[3]).not.toContain("<ins");
    expect(scenes[4]).toContain("仅自己可见");
    expect(scenes[4]).toContain("确认我的任务");
    expect(scenes[4]).toContain("Co-Agent 统一核对任务与记录");
    expect(scenes[4]).toContain("战场 DRI 确认任务组合");
    expect(scenes[4]).toMatch(/quotePreview[^>]*>[\s\S]*?<span>引用<\/span>/);
    expect(MISSION_CARD_TOUR_STEPS[3].body).toContain("请求修改后");
    expect(MISSION_CARD_TOUR_STEPS[4].body).toContain("CEO 签核本月目标");
    expect(MISSION_CARD_TOUR_STEPS[4].body).toContain("退回相关本人重新确认");
  });

  it("五幕中的段落只包含内联内容，选字菜单不造成 HTML 非法嵌套", () => {
    const blockInsideParagraph = /<p\b[^>]*>(?:(?!<\/p>)[\s\S])*<(?:div|section|article|aside|p|ul|ol|h[1-6])\b/;
    for (const { title, Scene } of MISSION_CARD_TOUR_STEPS) {
      expect(renderToStaticMarkup(<Scene />), title).not.toMatch(blockInsideParagraph);
    }
  });
});

describe("开启执行事项按钮", () => {
  it("没看过演示时带「新」标记；看过或还没读到记录时是普通按钮", () => {
    seenState.seen = new Set();
    expect(renderToStaticMarkup(<StartTaskButton />)).toMatch(/data-fresh="true"[\s\S]*新/);
    seenState.seen = new Set([EXECUTION_TOUR_KEY]);
    expect(renderToStaticMarkup(<StartTaskButton />)).toContain('data-fresh="false"');
    seenState.seen = null;
    expect(renderToStaticMarkup(<StartTaskButton />)).not.toContain(">新<");
  });
});
