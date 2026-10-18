import { describe, expect, it } from "vitest";
import type { TRequestListItem } from "@warmap/contracts";
import { docChangeSteps } from "./DocChange";
import { impactStatus } from "./ImpactCard";
import { impactNotices, requestNotices } from "./RequestNotices";

const item = (overrides: Partial<TRequestListItem>): TRequestListItem => ({
  id: "r1", kind: "relay", title: "t", status: "open", initiatorName: "测试乙", createdAt: "2026-10-19T06:00:00.000Z", sentAt: "2026-10-19T06:00:00.000Z",
  myStatus: "pending", recipientNames: ["测试丙"], recipientsDone: 0, openQuestions: 0, unread: true, ...overrides,
});

describe("文档变更", () => {
  it("步骤：服务端的 current 是 StepList 的 active，结果原样跟在后面", () => {
    expect(docChangeSteps({ steps: [
      { label: "读文档信息", status: "done", result: null }, { label: "找相关文档", status: "done", result: "2 份候选" },
      { label: "确认关系", status: "current", result: null }, { label: "推送影响卡", status: "pending", result: null },
    ] })).toEqual([
      { id: "读文档信息", label: "读文档信息", status: "done" }, { id: "找相关文档", label: "找相关文档", status: "done", result: "2 份候选" },
      { id: "确认关系", label: "确认关系", status: "active" }, { id: "推送影响卡", label: "推送影响卡", status: "pending" },
    ]);
  });

  it("作者的确认卡进「请求」，文档变更推来的影响卡进「影响」", () => {
    const inbox = [item({ id: "a", kind: "doc_change", title: "《M2 战略解码》修订或取代了哪份" }), item({ id: "b", kind: "impact", title: "《M1-B》已被《M2》取代" })];
    expect(requestNotices(inbox, []).map((notice) => notice.id)).toEqual(["a"]);
    expect(impactNotices(inbox).map((notice) => notice.id)).toEqual(["b"]);
  });

  it("卡头状态：选过之后写选了什么", () => {
    const viewer = { viewer: { isInitiator: false, isRecipient: true, myStatus: "done" as const } };
    expect(impactStatus({ status: "delivered", basisChoice: { choice: "keep", until: "2026-11-10", reason: "验收按旧方法", at: "2026-10-19T06:00:00.000Z" } }, viewer))
      .toEqual({ label: "用旧版到 11月10日", tone: "done" });
    expect(impactStatus({ status: "delivered", basisChoice: { choice: "switch", until: null, reason: null, at: "2026-10-19T06:00:00.000Z" } }, viewer))
      .toEqual({ label: "已换新版", tone: "done" });
    expect(impactStatus({ status: "delivered", basisChoice: null }, viewer)).toEqual({ label: "已知悉", tone: "done" });
  });
});
