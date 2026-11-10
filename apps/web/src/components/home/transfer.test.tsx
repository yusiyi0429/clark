import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LocalContext } from "@/lib/local/LocalRunnerProvider";
import { createMockRunner } from "@/lib/local/mock";
import type { Project } from "@/lib/home/projects";
import { projectLine } from "@/lib/home/projects";
import { handoverRule, justStarted, noteSeenSequence, noteStartedTransfer, SCROLL_NEW_TRANSFER_MS, seenSequence, transferLine, type Transfer } from "@/lib/home/transfer";
import { CONFIRM_MS, HandoverCard, HandoverRule, HandoverSummary, PullChip, TransferFlow, TransferHistory, TransferPreview, twoStepPress } from "./Transfer";

const me = { personId: "sun-mingze", name: "孙铭泽" };
const chen = { personId: "chen-chenxing", name: "陈晨星" };
const sub = (id: string, state: string) => ({ id, kind: "card", title: `卡${id}`, state, waiting: null, updatedAt: "a", queueReason: null, holdUntil: null, sessionId: `s${id}` });
const project = (patch: Partial<Project> = {}): Project => ({
  id: "p", name: "Chat 服务", folder: null, archived: false, goals: [], subSessions: [], items: [], waiting: 0, lastActivity: null, budget: null, transfer: null, unseen: false, scope: "project:p",
  current: [{ taskId: "t1", missionId: "m1", missionTitle: "Chat", period: "2026-11", name: "回答的样子", due: "11/30", dueDate: "2026-11-30", dueSet: false, criteria: [], completedAt: null, responsible: null }], ...patch,
});
const NOTE = [{ title: "到哪了", lines: ["11 月目标：回答的样子 · 11/30 验收"] }, { title: "没做完的事", lines: ["卡1", "补上评测集"] }, { title: "可以问谁", lines: ["孙铭泽"] }];
const transfer = (patch: Partial<Transfer> = {}): Transfer => ({
  id: "00000000-0000-4000-8000-0000000000aa", projectId: "p", projectName: "Chat 服务", from: me, to: chen, status: "preparing", startedAt: "2026-11-07T10:00:00.000Z", decidedAt: null,
  includeHistory: false, running: null, check: null, note: null, checkResult: null, clone: null, afterSequence: null, ...patch,
});
const noop = async () => undefined;
const local = { runner: createMockRunner(), phase: "offline", version: null, status: null, models: [], folders: [], sessions: [], pairing: null, error: null,
  refresh: vi.fn(), pair: vi.fn(), unpair: vi.fn(), pickFolder: vi.fn(), setIncludePersonal: vi.fn() } as unknown as Parameters<typeof LocalContext.Provider>[0]["value"];
const render = (node: ReactNode) => renderToStaticMarkup(<LocalContext.Provider value={local}>{node}</LocalContext.Provider>);

describe("项目转交（16.7，接 B 的转交接口）", () => {
  it("发起时带本人在项目对话里看到的最后一条序号（没打开过对话的不带）；本人刚发起的卡出现时滚到能看见，过一会儿不再滚", () => {
    expect(seenSequence("p-seen")).toBeUndefined();
    noteSeenSequence("p-seen", 7);
    noteSeenSequence("p-seen", undefined);
    expect(seenSequence("p-seen")).toBe(7);
    vi.useFakeTimers();
    try {
      expect(justStarted("t-new")).toBe(false);
      noteStartedTransfer("t-new");
      expect(justStarted("t-new")).toBe(true);
      vi.advanceTimersByTime(SCROLL_NEW_TRANSFER_MS);
      expect(justStarted("t-new")).toBe(false);
    } finally { vi.useRealTimers(); }
  });
  it("交接说明卡：云端写的几段，准备中每段一个「改」；「带上对话记录」默认不勾，按钮写「交给 {名字}」；发出了就没有按钮、不能改", () => {
    const card = render(<HandoverCard transfer={transfer({ note: NOTE })} onChanged={noop} />);
    expect(card).toMatch(/到哪了.*没做完的事.*卡1.*可以问谁/);
    expect(card.match(/aria-label="改「/g)?.length).toBe(3);
    // 「带上对话记录」是开关（左右拨动），默认关。
    expect(card).toMatch(/<button type="button" role="switch" aria-checked="false"[^>]*data-testid="handover-history"/);
    expect(card).toContain("交给 陈晨星");
    const sent = render(<HandoverCard transfer={transfer({ note: NOTE, status: "sent" })} onChanged={noop} />);
    expect(sent).not.toContain('data-testid="handover-send"');
    expect(sent).not.toContain('aria-label="改「');
  });

  it("准备交接：有在跑的会话先问「等做完再转（推荐）/ 停掉」；绑了文件夹的再问检查；说明还在写时是「正在写交接说明」、不出卡", () => {
    const running = render(<TransferFlow project={project({ subSessions: [sub("1", "running")] as never, folder: "Chat_Service" })} transfer={transfer()} onChanged={noop} onStop={noop} />);
    expect(running).toContain("准备交接给 陈晨星");
    expect(running).toMatch(/有 1 个会话在跑.*等做完再转.*停掉/);
    expect(running).not.toContain("检查文件夹");
    const check = render(<TransferFlow project={project({ folder: "Chat_Service" })} transfer={transfer()} onChanged={noop} onStop={noop} />);
    expect(check).toMatch(/检查文件夹「Chat_Service」.*等本机上线.*不检查直接转/);
    // 等本机检查：本机没就绪时一行「等本机上线」；检查结果到了（云端存下）就往下走到说明卡。
    expect(render(<TransferFlow project={project({ folder: "Chat_Service" })} transfer={transfer({ check: "wait" })} onChanged={noop} onStop={noop} />)).toContain("检查文件夹 · 等本机上线");
    const checked = render(<TransferFlow project={project({ folder: "Chat_Service" })} onChanged={noop} onStop={noop}
      transfer={transfer({ check: "wait", note: NOTE, checkResult: { projectId: "p", checkedAt: "2026-11-07T10:01:00.000Z", folder: null, git: null, recentFiles: null } })} />);
    expect(checked).toContain('data-testid="handover-card"');
    // 交接说明 null 就是云端在后台写：一行「正在写交接说明」加用时，没有卡；问题没答完时不出这一行。
    const writing = render(<TransferFlow project={project()} transfer={transfer()} onChanged={noop} onStop={noop} />);
    expect(writing).not.toContain('data-testid="handover-card"');
    expect(writing).toMatch(/data-testid="note-writing".*正在写交接说明.*·/);
    expect(running).not.toContain("正在写交接说明");
  });

  it("发出以后：项目行写「等 {名字} 接手」，接走了「已交给 {名字}」；对话里「已交给 {名字} · 等接手」", () => {
    expect(transferLine(transfer({ status: "sent" }))).toBe("等 陈晨星 接手");
    expect(projectLine(project({ transfer: transfer({ status: "accepted" }) })).text).toBe("已交给 陈晨星");
    expect(transferLine(null)).toBeNull();
    const sent = render(<TransferFlow project={project()} transfer={transfer({ status: "sent", note: NOTE })} onChanged={noop} onStop={noop} />);
    expect(sent).toContain("已交给 陈晨星 · 等接手");
    expect(sent).not.toContain('data-testid="handover-send"');
  });

  it("接手人：只读预览，交接说明在最上面，「接手」「不接」；已经了结的不给按钮", () => {
    const preview = render(<TransferPreview transfer={transfer({ status: "sent", note: NOTE })} onAccept={noop} onDecline={noop} />);
    expect(preview).toMatch(/孙铭泽把「Chat 服务」交给你.*交接说明.*到哪了.*接手.*不接/);
    expect(render(<TransferPreview transfer={transfer({ status: "declined", note: NOTE })} onAccept={noop} onDecline={noop} />)).not.toContain('data-testid="transfer-accept"');
  });

  it("对话从「{日期} {原负责人} → {接手人}」开始；第一条是交接说明，「没做完的事」做成选项；带上了对话记录时原来那段收成一行", () => {
    const at = new Date(2026, 10, 7, 20).toISOString();
    expect(handoverRule({ at, from: me, to: chen })).toBe("11/7 孙铭泽 → 陈晨星");
    expect(render(<HandoverRule item={{ at, from: me, to: chen }} />)).toContain('role="separator"');
    const summary = render(<HandoverSummary item={{ id: "hs-1", from: me, note: NOTE }} onSay={() => true} />);
    expect(summary).toMatch(/交接说明 · 孙铭泽.*先做哪件.*卡1.*补上评测集/);
    const history = render(<TransferHistory from={me} history={{ scope: "project:p", messages: [{ sequence: 1, role: "user", content: "先看评测", referencesSnapshot: [], attachments: [], runId: "r", createdAt: at }] }} />);
    expect(history).toMatch(/aria-expanded="false".*孙铭泽的对话 1/);
    expect(history).not.toContain("先看评测");
  });

  it("文件夹 chip：「拉到这台电脑」，拉不下来写原因", () => {
    expect(renderToStaticMarkup(<PullChip state="idle" onPull={() => undefined} />)).toContain("拉到这台电脑");
    expect(renderToStaticMarkup(<PullChip state="failed" reason="没拉下来：没有仓库权限" onPull={() => undefined} />)).toMatch(/data-tone="danger".*没有仓库权限/);
  });

  it("「交给 {名字}」点两次才发出：点一次只变成「确认转交」，点别处、Esc、失焦或过约 5 秒没再点就变回去", () => {
    vi.useFakeTimers();
    try {
      const act = vi.fn();
      const armed = vi.fn();
      const step = twoStepPress(act, armed);
      step.press();
      expect(act).not.toHaveBeenCalled();
      expect(armed).toHaveBeenLastCalledWith(true);
      step.press();
      expect(act).toHaveBeenCalledTimes(1);
      expect(armed).toHaveBeenLastCalledWith(false);

      step.press();
      step.disarm();
      expect(armed).toHaveBeenLastCalledWith(false);
      step.press();
      expect(act).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(CONFIRM_MS);
      expect(armed).toHaveBeenLastCalledWith(false);
      step.press();
      expect(act).toHaveBeenCalledTimes(1);
      expect(armed).toHaveBeenLastCalledWith(true);
      expect(CONFIRM_MS).toBe(5000);
    } finally {
      vi.useRealTimers();
    }
    const card = render(<HandoverCard transfer={transfer({ note: NOTE })} onChanged={noop} />);
    expect(card).toMatch(/aria-live="polite"[^>]*>.*data-testid="handover-send"[^>]*>交给 陈晨星</);
    expect(card).not.toContain("确认转交");
  });
});
