import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { SubSession } from "@/lib/home/types";
import { SubSessionSummary } from "./SubSessionSummary";

const sub = (id: string, patch: Partial<SubSession> = {}): SubSession => ({
  id, kind: "card", title: id, letter: "A", state: "waiting", waiting: null, stopWhy: "turn_done", unseen: false,
  queueReason: null, role: null, sessionId: null, deviceId: null, autoStart: false,
  updatedAt: "2026-11-13T02:00:00Z", merge: null, holdUntil: null, ...patch,
});
const project = (id: string, subSessions: SubSession[]) => ({ id, name: id, subSessions });
const render = (props: Omit<Parameters<typeof SubSessionSummary>[0], "go">) => renderToStaticMarkup(<SubSessionSummary {...props} go={() => undefined} />).replace(/<!-- -->/g, "");

describe("主管线的子会话摘要", () => {
  it("伙伴按项目列出，并把未归项目的会话放在其他；默认收起", () => {
    const html = render({ projects: [project("天枢", [sub("修会议", { state: "running", waiting: null })]), project("品牌", [sub("Logo")])], other: [sub("单独讨论", { kind: "topic", letter: null })] });
    expect(html).toContain("子会话 3");
    expect(html).toContain("1 进行中");
    expect(html).toContain('aria-label="天枢"');
    expect(html).toContain('aria-label="品牌"');
    expect(html).toContain("单独讨论");
    expect(html).not.toContain("<details open");
    expect(html).not.toContain("等你</span>");
  });

  it("做完一轮、停止、等合回、等本人补、重做和真正完成分别显示", () => {
    const html = render({ projects: [project("天枢", [
      sub("停下一轮"), sub("被打断", { stopWhy: "interrupted" }),
      sub("合回", { waiting: "merge" }), sub("补证据", { waiting: "needs_person" }),
      sub("返工", { state: "failed" }), sub("验收过且合回", { state: "done" }),
    ])], grouped: false });
    expect(html).toContain("做完一轮");
    expect(html).toContain("已停下");
    expect(html).toContain("等你合回");
    expect(html).toContain("等你补");
    expect(html).toContain("重做中");
    expect(html.match(/>已完成</g)).toHaveLength(1);
    expect(html).not.toContain("进行中");
    expect(html).toContain("1 重做中");
    expect(html).toContain("2 等你");
    expect(html).not.toContain('<h2');
  });

  it("运行与验收返工分别计数，不能用汇总暗示返工已有运行进程", () => {
    const html = render({ projects: [project("天枢", [
      sub("正在执行", { state: "running" }), sub("验收返工", { state: "failed" }),
      sub("等批准", { state: "waiting", waiting: "approval" }),
    ])] });
    expect(html).toContain("1 进行中");
    expect(html).toContain("1 重做中");
    expect(html).toContain("1 等你");
    expect(html).not.toContain("2 进行中");
  });

  it("排队显示实际原因和占着文件夹的会话，不冒充正在运行", () => {
    const html = render({ projects: [project("天枢", [sub("下一件", { state: "queued", queueReason: "folder_busy", heldBy: { id: "prior", kind: "card", letter: "B", title: "改登录页" } })])] });
    expect(html).toContain("已排队 · 等「改登录页」这一轮做完");
    expect(html).not.toContain("进行中");
  });

  it("没有子会话不占主对话空间；项目摘要只列调用方传入的本项目", () => {
    expect(render({ projects: [project("空项目", [])] })).toBe("");
    const html = render({ projects: [project("天枢", [sub("会议修复")])], grouped: false });
    expect(html).toContain("会议修复");
    expect(html).not.toContain("品牌");
  });
});
