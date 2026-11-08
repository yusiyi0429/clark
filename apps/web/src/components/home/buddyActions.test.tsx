import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { TBuddyAuditEntry, TBuddyMessageDraft } from "@warmap/contracts";
import { ConversationTurn } from "@/conversation/Transcript";
import { isBuddyScope } from "@/conversation/useConversation";
import { PlanChecklist } from "@/components/cards/PlanChecklist";
import { buddyTargetHref } from "@/lib/home/derive";
import { BuddyMessageBox, buddyMessageResolved } from "./BuddyMessageCard";
import { BuddyLogList } from "./BuddyAuthority";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const chen = { personId: "chen-chenxing", name: "陈晨星" };
const xinan = { personId: "chen-xinan", name: "陈溪南" };
const draft = (patch: Partial<TBuddyMessageDraft> = {}): TBuddyMessageDraft => ({
  id: "00000000-0000-4000-8000-0000000000a1", to: [chen, xinan], text: "接口文档周一前给我", status: "draft", createdAt: "2026-11-08T02:00:00Z", sentAt: null, failed: [], ...patch,
});

describe("伙伴代本人做事（17.4）", () => {
  it("转达给同事的卡：写收件人和要转达的话，「发出（推荐）/ 不发」；答过的收成一行，没收到的人写在后面", () => {
    const open = text(renderToStaticMarkup(<BuddyMessageBox draft={draft()} onDraft={() => undefined} />));
    expect(open).toMatch(/转达给 陈晨星、陈溪南.*接口文档周一前给我.*发出.*推荐.*不发/);
    expect(buddyMessageResolved(draft({ status: "sent" }))).toBe("已发出");
    expect(buddyMessageResolved(draft({ status: "sent", failed: [xinan] }))).toBe("已发出 · 陈溪南 没收到");
    expect(buddyMessageResolved(draft({ status: "cancelled" }))).toBe("不发");
    expect(buddyMessageResolved(draft())).toBeNull();
  });

  it("回执：本人那句旁边两个小勾，送达亮第一个，读到亮第二个；没有回执不画", () => {
    const at = (receipt?: "delivered" | "read") => renderToStaticMarkup(<ConversationTurn message={{ sequence: 1, role: "user", content: "先停一下", ...(receipt ? { receipt } : {}) }} />);
    expect(at("delivered")).toMatch(/data-receipt="delivered"[^>]*aria-label="已送达"/);
    expect(at("read")).toMatch(/data-receipt="read"[^>]*aria-label="已读"/);
    expect(at()).not.toContain("message-receipt");
  });

  it("计划清单：做完的、在做的照状态画；被打断收起时一行「计划 n/m」", () => {
    const entries = [{ content: "归档 Chat 服务", status: "completed" as const }, { content: "切深色", status: "in_progress" as const }, { content: "转达晨星", status: "pending" as const }];
    expect(renderToStaticMarkup(<PlanChecklist entries={entries} />)).toMatch(/data-status="completed">归档 Chat 服务.*data-status="in_progress">切深色.*data-status="pending">转达晨星/);
    expect(text(renderToStaticMarkup(<PlanChecklist entries={entries} collapsed />))).toBe("计划 1/3");
  });

  it("伙伴做过的事：能撤的给「撤销」，撤过的「已撤销」，撤不了的写原因", () => {
    const entry = (id: string, patch: Partial<TBuddyAuditEntry>): TBuddyAuditEntry => ({ id, action: "archive_project", summary: `已归档 ${id}`, at: "2026-11-08T02:00:00Z",
      conversationId: null, undoable: true, undoneAt: null, ...patch });
    const html = text(renderToStaticMarkup(<BuddyLogList onUndo={() => undefined} problem={{ id: "c", text: "项目又改过名了" }}
      entries={[entry("a", {}), entry("b", { undoneAt: "2026-11-08T03:00:00Z" }), entry("c", { undoable: true })]} />));
    expect(html).toMatch(/已归档 a .* 撤销 .*已归档 b .* 已撤销 .*已归档 c .* 项目又改过名了 撤销/);
  });

  it("伙伴打开某一处：同「等你」的 open，另加首页和偏好；回执和打断只在伙伴对话里", () => {
    expect(buddyTargetHref({ kind: "home" })).toBe("/me/work");
    expect(buddyTargetHref({ kind: "preferences" })).toBe("/me/work/settings/preferences");
    expect(buddyTargetHref({ kind: "connections", id: "this_computer" })).toBe("/me/work/settings/connections");
    expect(isBuddyScope("global")).toBe(true);
    expect(isBuddyScope("project:p1")).toBe(true);
    expect(isBuddyScope("mission-card:m1")).toBe(false);
  });
});
