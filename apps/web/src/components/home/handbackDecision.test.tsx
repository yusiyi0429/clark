import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { TCardGapItem, TCardRelayView } from "@warmap/contracts";
import { LocalContext } from "@/lib/local/LocalRunnerProvider";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/me/work" }));

import { HandbackDecision, StopBox, SupplyBox, supplyPrefill, type HandbackForBox } from "./TaskDecisions";

/** 等你补和受阻并成的框（主循环第 61、62 条）：没有 jsdom，只看画出来的第一屏；点了以后的那两个写字的框单独画。 */
const text = (html: string) => html.replace(/<[^>]+>/g, "|").replace(/\|+/g, "|");
const local = { phase: "ready", sessions: [], status: null, runner: {}, refresh: async () => undefined } as unknown as Parameters<typeof LocalContext.Provider>[0]["value"];
const gaps: TCardGapItem[] = [
  { index: 2, short: "候选名的含义", verdict: "unmet", fixBy: "worker", fix: "每个名字补一句含义" },
  { index: 4, short: "近似商标申请号", verdict: "needs_person", fixBy: "person", fix: "登录中国商标网查这 3 个名字，把近似商标的申请号贴回来" },
];
const handback = (patch: Partial<HandbackForBox> = {}): HandbackForBox => ({
  id: "00000000-0000-4000-8000-0000000000e1", outcome: "needs_person", headline: "申请号要你去商标网查", sourceWordIssues: [], returnText: null, returnedAt: null,
  gaps, relay: null, passedWithGap: null, ...patch,
});
const relay = (state: TCardRelayView["state"], kind: TCardRelayView["kind"] = "supply"): TCardRelayView => ({
  id: "00000000-0000-4000-8000-0000000000f1", kind, state, text: "申请号：无", requestedAt: "2026-11-11T08:00:00.000Z", doneAt: state === "delivered" ? "2026-11-11T08:01:00.000Z" : null,
  message: state === "failed" ? "本机上没有这个会话" : null,
});
const render = (box: HandbackForBox, here = false) => renderToStaticMarkup(
  <LocalContext.Provider value={local}>
    <HandbackDecision cardId="card-1" handback={box} here={here} onLook={() => undefined} onEdit={() => undefined} onChanged={() => undefined} />
  </LocalContext.Provider>,
);
const options = (html: string) => [...html.matchAll(/data-testid="decision-option"[^>]*>.*?<span class="[^"]*">(?:<span>)?([^<]+)/g)].map((match) => match[1]);

describe("等你补的框", () => {
  it("第一行是验收员那一句人话；逐条只列要你做的；三个选项，我来补推荐", () => {
    const html = render(handback());
    const page = text(html);
    expect(page.startsWith("|申请号要你去商标网查|")).toBe(true);
    expect(page).toContain("登录中国商标网查这 3 个名字");
    expect(page).not.toContain("每个名字补一句含义");
    expect(options(html)).toEqual(["我来补", "就到这里", "改完成标准"]);
    expect(page).toContain("我来补|（推荐）");
  });
  it("要你做的那一条和第一行是同一句：只写一遍", () => {
    const same = handback({ headline: "登录中国商标网查这 3 个名字，把近似商标的申请号贴回来。" });
    const html = render(same);
    expect(html.match(/登录中国商标网查这 3 个名字/g)).toHaveLength(1);
    expect(html).not.toContain("handback-needs");
  });
  it("手机上、不在这台电脑上：选项一个不少", () => {
    expect(options(render(handback(), false))).toEqual(["我来补", "就到这里", "改完成标准"]);
    expect(options(render(handback({ outcome: "fail" }), false))).toEqual(["再改一轮", "我去看看", "改完成标准", "就到这里"]);
  });
});

describe("受阻的框", () => {
  it("第一行是那一句人话；验收意见默认收起；四个选项，再改一轮推荐；没有行号和改法全文", () => {
    const html = render(handback({ outcome: "fail", headline: "含义还缺两个" }));
    const page = text(html);
    expect(page.startsWith("|含义还缺两个|验收意见|")).toBe(true);
    expect(html).toMatch(/aria-expanded="false"[^>]*data-testid="handback-opinion"/);
    expect(page).not.toContain("每个名字补一句含义");
    expect(options(html)).toEqual(["再改一轮", "我去看看", "改完成标准", "就到这里"]);
    expect(page).not.toContain("仍然通过");
    expect(page).not.toContain("接受现在的结果");
  });
  it("没有那一句人话的老交回：第一行写「验收两次没过」", () => {
    expect(text(render(handback({ outcome: "fail", headline: null }))).startsWith("|验收两次没过|")).toBe(true);
  });
});

describe("登记以后（relay.state）", () => {
  it("pending：不再给选项，框上写电脑在线后送到 / 执行", () => {
    const supply = text(render(handback({ relay: relay("pending") })));
    expect(supply).toContain("电脑在线后送到");
    expect(options(render(handback({ relay: relay("pending") })))).toEqual([]);
    expect(text(render(handback({ outcome: "fail", relay: relay("pending", "return") })))).toContain("电脑在线后执行");
  });
  it("delivered：收成一行，写答了什么", () => {
    const html = render(handback({ relay: relay("delivered") }));
    expect(html).toContain('data-resolved=""');
    expect(text(html)).toContain("申请号要你去商标网查|我来补|");
    expect(text(render(handback({ outcome: "fail", relay: relay("delivered", "return") })))).toContain("再改一轮");
  });
  it("failed：选项照旧给，框下写没送成的原因", () => {
    const html = render(handback({ relay: relay("failed") }));
    expect(options(html)).toEqual(["我来补", "就到这里", "改完成标准"]);
    expect(text(html)).toContain("本机上没有这个会话");
  });
  it("就到这里了：收成一行「就到这里」", () => {
    expect(text(render(handback({ passedWithGap: { reason: "近似商标申请号：先不查", at: "2026-11-11T08:00:00.000Z" } })))).toContain("就到这里");
  });
});

describe("就到这里、我来补（写字的那一步）", () => {
  it("就到这里：没达到的几条短标题列在上面，输入框空着、占位字「原因」，空着没有发送键", () => {
    const html = renderToStaticMarkup(<StopBox title="含义还缺两个" gaps={gaps} onCancel={() => undefined} onSubmit={async () => undefined} />);
    expect(text(html)).toContain("|含义还缺两个|候选名的含义|近似商标申请号|1|取消|");
    expect(html).toMatch(/<textarea[^>]*placeholder="原因…"[^>]*><\/textarea>/);
    expect(html).not.toContain('aria-label="发送"');
  });
  it("没有逐条的老交回：上面不列，照样空着提交不了", () => {
    const html = renderToStaticMarkup(<StopBox title="验收两次没过" gaps={[]} onCancel={() => undefined} onSubmit={async () => undefined} />);
    expect(html).not.toContain("handback-stop-gaps");
    expect(html).not.toContain('aria-label="发送"');
  });
  it("我来补预填每条要你补的短标题，一行一条；只有预填的发不出去", () => {
    expect(supplyPrefill(gaps)).toBe("近似商标申请号：");
    const html = renderToStaticMarkup(<SupplyBox title="申请号要你去商标网查" gaps={gaps} onCancel={() => undefined} onSubmit={async () => undefined} />);
    expect(html).toContain(">近似商标申请号：</textarea>");
    expect(html).not.toContain('aria-label="发送"');
  });
});
