import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { SessionEntry } from "@/lib/local/sessionView";
import type { LocalRunner, TLocalPermissionRequestView } from "@/lib/local/runner";
import { SessionTranscript, sayToSession } from "./SessionTranscript";
import { paneFirst, stateChip } from "./CardSession";

const at = "2026-11-07T01:00:00Z";
const notice = (seq: number, text: string): SessionEntry => ({ kind: "notice", seq, at, level: "info", text });
const permission = (seq: number, decision: "allow" | "deny" | null): SessionEntry => ({
  kind: "permission", seq, at, decision,
  request: { requestId: `r${seq}`, toolName: "Bash", title: "运行 pnpm test", input: { command: "pnpm test" }, canAllowForSession: true } as unknown as TLocalPermissionRequestView,
});
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const render = (entries: SessionEntry[], extra: Partial<Parameters<typeof SessionTranscript>[0]> = {}) =>
  text(renderToStaticMarkup(<SessionTranscript entries={entries} agentName="Claude Code" canAct onDecide={vi.fn()} live {...extra} />));

describe("子会话里答过、过期的选项框（5.4.3）", () => {
  it("问和答收成一行：问题 · 答案，不再另起「问：」「答：」两行", () => {
    const html = render([notice(1, "问：用哪个库？"), notice(2, "答：zod")]);
    expect(html).toContain("用哪个库？");
    expect(html).toContain("zod");
    expect(html).not.toContain("问：");
    expect(html).not.toContain("答：");
  });

  it("没答就过去了的提问收成「已失效」", () => {
    expect(render([notice(1, "问：用哪个库？"), notice(2, "问：先做哪个？")], {})).toContain("已失效");
  });

  it("换个做法收起后写「换个做法」，不写「已拒绝」", () => {
    const html = render([permission(1, "deny")]);
    expect(html).toContain("换个做法");
    expect(html).not.toContain("已拒绝");
  });

  it("会话结束了还没批的批准收成「已失效」，不再给批准", () => {
    const html = render([permission(1, null)], { live: false, ended: true });
    expect(html).toContain("已失效");
    expect(html).not.toContain("同类以后都批准");
  });

  it("这里答不了：头上写「等你 · 电脑名」", () => {
    expect(render([permission(1, null)], { canAct: false, device: "ThinkPad" })).toContain("等你 · ThinkPad");
  });

  it("钉在输入框上方时（第 54 条）：对话里那一处不画没答的批准；会话停了照样收成「已失效」", () => {
    const html = render([permission(1, null)], { pinned: true });
    expect(html).not.toContain("同类以后都批准");
    expect(html).not.toContain("去回答");
    expect(render([permission(1, null)], { pinned: true, ended: true })).toContain("已失效");
  });
});

describe("有没批的批准时，底下发一句话 = 换个做法（5.4.3）", () => {
  const runner = () => ({ sendMessage: vi.fn(async () => undefined), decidePermission: vi.fn(async () => undefined) }) as unknown as LocalRunner & { sendMessage: ReturnType<typeof vi.fn>; decidePermission: ReturnType<typeof vi.fn> };
  const pending = [{ requestId: "r1" }] as TLocalPermissionRequestView[];

  it("没有要批的：照常插话", async () => {
    const r = runner();
    await sayToSession(r, "s1", [], "先跑测试");
    expect(r.sendMessage).toHaveBeenCalledWith("s1", "先跑测试", undefined, [], undefined);
    expect(r.decidePermission).not.toHaveBeenCalled();
  });

  it("有要批的：这句话作为换个做法的话交给那次批准", async () => {
    const r = runner();
    await sayToSession(r, "s1", pending, "别用 rm，换成 git clean");
    expect(r.decidePermission).toHaveBeenCalledWith("s1", "r1", { decision: "deny", message: "别用 rm，换成 git clean" });
    expect(r.sendMessage).not.toHaveBeenCalled();
  });

  it("超过换个做法的 500 字：批准那边只记换个做法，整句照常插话", async () => {
    const r = runner();
    const long = "改".repeat(600);
    await sayToSession(r, "s1", pending, long);
    expect(r.decidePermission).toHaveBeenCalledWith("s1", "r1", { decision: "deny" });
    expect(r.sendMessage).toHaveBeenCalledWith("s1", long, undefined, [], undefined);
  });

  it("带了附件（14.5）：批准那边只记换个做法，整句连附件照常插话", async () => {
    const r = runner();
    const file = { id: "00000000-0000-4000-8000-0000000000f1", fileName: "截图.png", size: 10, sha256: "a".repeat(64) };
    await sayToSession(r, "s1", pending, "看这张图", [file]);
    expect(r.decidePermission).toHaveBeenCalledWith("s1", "r1", { decision: "deny" });
    expect(r.sendMessage).toHaveBeenCalledWith("s1", "看这张图", undefined, [file], undefined);
  });
});

describe("子会话页头的状态 chip（5.4.3、5.6、第 54 条）", () => {
  it("只有等本人处理的框是等你档；批准、提问不在这台电脑上写「等你 · 电脑名」", () => {
    expect(stateChip("approval", null, "doing", null)).toEqual({ text: "等你批准", tone: "wait" });
    expect(stateChip("question", null, "doing", "等你 · ThinkPad")).toEqual({ text: "等你 · ThinkPad", tone: "wait" });
    expect(stateChip("verdict", "blocked", "doing", "等你 · ThinkPad")).toEqual({ text: "等你拿主意", tone: "wait" });
    expect(stateChip("merge", null, "done", null)).toEqual({ text: "等你合回", tone: "wait" });
  });
  it("没有框的不是等你档：一轮做完是「已停下」，停了是「已停止」", () => {
    expect(stateChip(null, "reply", "doing", null)).toEqual({ text: "已停下", tone: "neutral" });
    expect(stateChip(null, "paused", "doing", null)).toEqual({ text: "已停止", tone: "neutral" });
    expect(stateChip(null, "approval", "doing", null)).toEqual({ text: "进行中", tone: "neutral" });
  });
  it("手机上不在这台电脑上：有等你处理的框先看对话（框在下面），没有才先看摘要", () => {
    expect(paneFirst(false, true)).toBe(false);
    expect(paneFirst(false, false)).toBe(true);
    expect(paneFirst(true, false)).toBe(false);
  });
  it("排着的卡照写在等谁（第 68 条）；有等你处理的框时先写等你", () => {
    expect(stateChip(null, null, "todo", null, "已排队 · 等 B")).toEqual({ text: "已排队 · 等 B", tone: "neutral" });
    expect(stateChip("approval", null, "doing", null, "已排队 · 等 B")).toEqual({ text: "等你批准", tone: "wait" });
  });
  it("第一次验收没过是进行中的「重做中」，不是单独的状态；不是验收没过的受阻是警告档", () => {
    expect(stateChip(null, "review_failed", "review", null)).toEqual({ text: "重做中", tone: "neutral" });
    expect(stateChip(null, "blocked", "review", null)).toEqual({ text: "受阻", tone: "warn" });
    expect(stateChip(null, null, "done", null)).toEqual({ text: "已完成", tone: "neutral" });
  });
});
