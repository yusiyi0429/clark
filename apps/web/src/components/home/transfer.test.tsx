import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Project } from "@/lib/home/projects";
import { projectLine } from "@/lib/home/projects";
import { draftNote, handoverRule, secretHits, transferLine, type Transfer } from "@/lib/home/transfer";
import { HandoverCard, HandoverRule, PullChip, TransferFlow, TransferPreview } from "./Transfer";

const me = { personId: "sun-mingze", name: "孙铭泽" };
const chen = { personId: "chen-chenxing", name: "陈晨星" };
const sub = (id: string, state: string) => ({ id, kind: "card", title: `卡${id}`, state, waiting: null, updatedAt: "a", queueReason: null, holdUntil: null, sessionId: `s${id}` });
const project = (patch: Partial<Project> = {}): Project => ({
  id: "p", name: "Chat 服务", folder: null, archived: false, goals: [], subSessions: [], items: [], waiting: 0, lastActivity: null, budget: null, transfer: null,
  scope: "project:p",
  current: [{ taskId: "t1", missionId: "m1", missionTitle: "Chat", period: "2026-11", name: "回答的样子", due: "11/21", criteria: [], completedAt: null }], ...patch,
});
const transfer = (patch: Partial<Transfer> = {}): Transfer => ({
  id: "x", projectId: "p", projectName: "Chat 服务", from: me, to: chen, status: "preparing", startedAt: "2026-11-07T10:00:00.000Z", decidedAt: null,
  includeHistory: false, running: null, check: null, note: null, ...patch,
});
const noop = () => undefined;

describe("项目转交（16.7）", () => {
  it("交接说明先按项目里有的拼：到哪了、没做完的事、代码在哪、可以问谁；没内容的段不画", () => {
    const note = draftNote(project({ folder: "Chat_Service", subSessions: [sub("1", "running"), sub("2", "done")] as never }), me);
    expect(note).toEqual([
      { title: "到哪了", lines: ["11 月目标：回答的样子 · 11/21 验收"] },
      { title: "没做完的事", lines: ["卡1"] },
      { title: "代码在哪", lines: ["Chat_Service"] },
      { title: "可以问谁", lines: ["孙铭泽"] },
    ]);
  });

  it("像密钥的行挡住：sk-、ghp_、AKIA、私钥、xox；变量名不算", () => {
    const hits = secretHits([{ title: "怎么跑起来", lines: ["OPENAI_API_KEY 找人豪要", "key 是 sk-abcdefghijklmnopqrstu", "AKIAABCDEFGHIJKLMNOP"] }]);
    expect(hits).toEqual([{ section: "怎么跑起来", line: 2, sample: "sk-abc…" }, { section: "怎么跑起来", line: 3, sample: "AKIAAB…" }]);
    const card = renderToStaticMarkup(<HandoverCard note={[{ title: "怎么跑起来", lines: ["sk-abcdefghijklmnopqrstu"] }]} to="陈晨星" sent={false} includeHistory={false} onSend={noop} />);
    expect(card).toContain('data-testid="handover-secret"');
    expect(card).toMatch(/data-testid="handover-send"[^>]*disabled|disabled[^>]*data-testid="handover-send"/);
  });

  it("交接说明卡：「带上对话记录」默认不勾，按钮写「交给 {名字}」", () => {
    const card = renderToStaticMarkup(<HandoverCard note={draftNote(project(), me)} to="陈晨星" sent={false} includeHistory={false} onSend={noop} />);
    expect(card).toMatch(/<input type="checkbox"(?![^>]*checked)[^>]*data-testid="handover-history"/);
    expect(card).toContain("带上对话记录");
    expect(card).toContain("交给 陈晨星");
  });

  it("准备交接：有在跑的会话先问「等做完再转（推荐）/ 停掉」；绑了文件夹的再问检查", () => {
    const running = renderToStaticMarkup(<TransferFlow project={project({ subSessions: [sub("1", "running")] as never, folder: "Chat_Service" })} transfer={transfer()} onUpdate={noop} onStop={async () => undefined} />);
    expect(running).toContain("准备交接给 陈晨星");
    expect(running).toMatch(/有 1 个会话在跑.*等做完再转.*停掉/);
    expect(running).not.toContain("检查文件夹");
    const check = renderToStaticMarkup(<TransferFlow project={project({ folder: "Chat_Service" })} transfer={transfer()} onUpdate={noop} onStop={async () => undefined} />);
    expect(check).toMatch(/检查文件夹「Chat_Service」.*等本机上线.*不检查直接转/);
  });

  it("发出以后：项目行写「等 {名字} 接手」，接走了「已交给 {名字}」；撤回、没接的不写", () => {
    expect(transferLine(transfer({ status: "sent" }))).toBe("等 陈晨星 接手");
    expect(projectLine(project({ transfer: transfer({ status: "accepted" }) })).text).toBe("已交给 陈晨星");
    expect(transferLine(null)).toBeNull();
    const sent = renderToStaticMarkup(<TransferFlow project={project()} transfer={transfer({ status: "sent", note: draftNote(project(), me) })} onUpdate={noop} onStop={async () => undefined} />);
    expect(sent).toContain("已交给 陈晨星 · 等接手");
    expect(sent).not.toContain('data-testid="handover-send"');
  });

  it("接手人：只读预览，交接说明在最上面，「接手」「不接」；对话从「{日期} {原负责人} → {接手人}」开始", () => {
    const preview = renderToStaticMarkup(<TransferPreview transfer={transfer({ status: "sent", note: draftNote(project(), me) })} onAccept={noop} onDecline={noop} />);
    expect(preview).toMatch(/孙铭泽把「Chat 服务」交给你.*交接说明.*到哪了.*接手.*不接/);
    expect(handoverRule({ decidedAt: new Date(2026, 10, 7, 20).toISOString(), from: me, to: chen })).toBe("11/7 孙铭泽 → 陈晨星");
    expect(renderToStaticMarkup(<HandoverRule transfer={{ decidedAt: new Date(2026, 10, 7, 20).toISOString(), from: me, to: chen }} />)).toContain('role="separator"');
  });

  it("文件夹 chip：「拉到这台电脑」，拉不下来写原因", () => {
    expect(renderToStaticMarkup(<PullChip state="idle" onPull={noop} />)).toContain("拉到这台电脑");
    expect(renderToStaticMarkup(<PullChip state="failed" reason="没有仓库权限" onPull={noop} />)).toMatch(/data-tone="danger".*没有仓库权限/);
  });
});
