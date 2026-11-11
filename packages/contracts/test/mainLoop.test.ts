import { beforeAll, describe, expect, it } from "vitest";
import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { buildOpenApiDocument } from "../src/openapi.js";
import {
  CardAcceptanceCriterion, CardAgreementChangeListResponse, CardHandbackBrief, CardRelayRequest, DecideAgreementProposalRequest, LOCAL_RUNNER_CARD_AGREEMENT_PATH,
  LOCAL_RUNNER_PROTOCOL, LocalAgreementProposal, LocalCardAgreementResponse, LocalPermissionBrief, LocalSendMessageRequest, LocalSessionEvent, LocalSyncBatchRequest,
  PatchCardRequest, ProjectFeedItem, SessionCommand, TaskCard, UpdateCardActionParams, WaitingItem, WorkerMark,
} from "../src/index.js";

/** 主循环修复（设计第 60–65 条）的契约：新字段都可选、新值只加不改，老的本机和老网页发的、收的照旧合法。 */

const uuid = "6b0f3a52-4d0c-4c1e-9a43-1f7d2c9b8e10";
const deviceId = "0d2f9a1e-7c44-4b5e-8f3a-2a9e6c1d7b55";
const at = "2026-11-11T08:00:00.000Z";
const key = `${deviceId}:${uuid}:7`;

beforeAll(() => {
  FormatRegistry.Set("uuid", (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v));
  FormatRegistry.Set("date-time", (v) => !Number.isNaN(Date.parse(v)) && /T/.test(v));
});

const batch = (type: string, data: unknown) => ({
  deviceId, runnerVersion: "0.9.0", slots: { max: 2, running: 0, queued: 0 },
  items: [{ key, sessionId: uuid, subject: { kind: "card", cardId: uuid }, occurredAt: at, type, data }],
});
const brief = { id: uuid, attempt: 1, status: "done", outcome: "fail", met: 1, total: 2, headline: null, returnText: "改", returnedAt: null, overruled: false,
  createdAt: at, finishedAt: at, git: null, sourceWordIssues: [] };

describe("主循环契约：卡的约定（第 60 条）", () => {
  it("本人在会话详情里改：PATCH 卡带整份完成标准和原因；一条标准不能换行", () => {
    expect(Value.Check(PatchCardRequest, { version: 3, standards: ["列出 3 个候选名", "每个附近似商标的申请号"], reason: "本人加了英文名" })).toBe(true);
    expect(Value.Check(PatchCardRequest, { version: 3, brief: "只改交代" })).toBe(true);
    expect(Value.Check(PatchCardRequest, { version: 3, standards: ["第一条\n第二条"] })).toBe(false);
    expect(Value.Check(PatchCardRequest, { version: 3, standards: [] })).toBe(false);
  });

  it("修改记录：谁、什么时候、改前改后、原因", () => {
    expect(Value.Check(CardAgreementChangeListResponse, { changes: [{ id: uuid, revision: 2, at, by: { kind: "worker", name: "Claude Code" },
      before: { brief: null, standards: ["a"] }, after: { brief: null, standards: ["a", "b"] }, reason: "要本人登录的那条改成本人补" }] })).toBe(true);
    expect(Value.Check(CardAgreementChangeListResponse, { changes: [{ id: uuid, revision: 1, at, by: { kind: "person", name: null },
      before: { brief: null, standards: [] }, after: { brief: null, standards: [] }, reason: null }] })).toBe(false);
  });

  it("管线的 update_card：按字母或卡 id，原因必带", () => {
    expect(Value.Check(UpdateCardActionParams, { letter: "B", standards: ["x"], reason: "本人说加一条" })).toBe(true);
    expect(Value.Check(UpdateCardActionParams, { cardId: uuid, brief: "新交代", reason: "改范围" })).toBe(true);
    expect(Value.Check(UpdateCardActionParams, { letter: "B", standards: ["x"] })).toBe(false);
  });

  it("执行方提议：工具入参、会话里的事件、同步条目同一个形状；本人拍板 accept / reject", () => {
    const proposal = { standards: ["列出候选名", "近似商标由本人查"], reason: "商标网拦自动访问" };
    expect(Value.Check(LocalAgreementProposal, proposal)).toBe(true);
    expect(Value.Check(LocalAgreementProposal, { ...proposal, brief: "" })).toBe(false);
    expect(Value.Check(LocalSessionEvent, { seq: 9, at, sessionId: uuid, type: "agreement_proposal", proposalKey: key, ...proposal })).toBe(true);
    expect(Value.Check(LocalSyncBatchRequest, batch("agreement_proposal", proposal))).toBe(true);
    expect(Value.Check(DecideAgreementProposalRequest, { decision: "accept" })).toBe(true);
    expect(Value.Check(DecideAgreementProposalRequest, { decision: "later" })).toBe(false);
  });

  it("交回时本机取最新约定；网页转「约定改了」时带版本号（protocol 3），老的转话不带照旧合法", () => {
    expect(LOCAL_RUNNER_CARD_AGREEMENT_PATH).toBe("/api/local-runner/card-agreement");
    expect(Value.Check(LocalCardAgreementResponse, { cardId: uuid, revision: 2, brief: null, standards: ["a", "b"] })).toBe(true);
    expect(LOCAL_RUNNER_PROTOCOL).toBe(3);
    expect(Value.Check(LocalSendMessageRequest, { text: "约定改了", agreementRevision: 2 })).toBe(true);
    expect(Value.Check(SessionCommand, { type: "message", text: "约定改了", agreementRevision: 2 })).toBe(true);
    expect(Value.Check(SessionCommand, { type: "message", text: "接着做" })).toBe(true);
  });
});

describe("主循环契约：要本人补、受阻、就到这里（第 61、62 条）", () => {
  it("交回自评多 needs_person 带 need；老的三种照旧", () => {
    const handback = (criteria: unknown[]) => batch("handback", { summary: "做完了能做的", criteria, outputKeys: [] });
    expect(Value.Check(LocalSyncBatchRequest, handback([{ index: 1, result: "met", evidence: "见 A1" },
      { index: 2, result: "needs_person", evidence: "商标网要登录", need: "登录商标网查这 3 个名字，把申请号贴回来" }]))).toBe(true);
    expect(Value.Check(LocalSyncBatchRequest, handback([{ index: 1, result: "unmet", evidence: "" }]))).toBe(true);
    expect(Value.Check(LocalSyncBatchRequest, handback([{ index: 1, result: "blocked", evidence: "" }]))).toBe(false);
  });

  it("验收判定多 needs_person 和 fixBy；老验收员不带 fixBy 照旧合法", () => {
    const verdict = (criteria: unknown[]) => batch("verdict", { passed: false, summary: "就差申请号，要你登录商标网查", criteria, beyondScope: [], modelLabel: "Opus 5.5",
      roleId: null, roleVersion: null });
    expect(Value.Check(LocalSyncBatchRequest, verdict([{ index: 1, verdict: "needs_person", reason: "要登录", evidence: null, fix: "登录查", fixBy: "person" }]))).toBe(true);
    expect(Value.Check(LocalSyncBatchRequest, verdict([{ index: 1, verdict: "unmet", reason: "没写", evidence: null, fix: "补上" }]))).toBe(true);
    expect(Value.Check(LocalSyncBatchRequest, verdict([{ index: 1, verdict: "unmet", reason: "没写", evidence: null, fix: "补上", fixBy: "boss" }]))).toBe(false);
    expect(Value.Check(CardAcceptanceCriterion, { index: 1, text: "申请号", verdict: "needs_person", reason: "要登录", evidence: null, fix: "登录查", fixBy: "person" })).toBe(true);
  });

  it("卡的标记、交回结论多 needs_person；交回摘要带逐条、手机登记、有缺口通过；老的摘要不带也合法", () => {
    const card = { stage: "doing", wait: "needs_person", role: null, executor: "claude_code", model: null, criterion: null, run: null, deliverable: null, after: [], sourceWords: [],
      handback: { ...brief, outcome: "needs_person", headline: "就差申请号，要你登录商标网查",
        gaps: [{ index: 2, short: "近似商标的申请号", verdict: "needs_person", fixBy: "person", fix: "登录商标网查这 3 个名字" }],
        relay: { id: uuid, kind: "supply", state: "pending", text: "申请号：…", requestedAt: at, doneAt: null, message: null },
        passedWithGap: null } };
    expect(Value.Check(TaskCard, card)).toBe(true);
    expect(Value.Check(CardHandbackBrief, brief)).toBe(true);
    expect(Value.Check(CardHandbackBrief, { ...brief, overruled: true, passedWithGap: { reason: "申请号先不要了", at } })).toBe(true);
    expect(Value.Check(CardHandbackBrief, { ...brief, relay: { id: uuid, kind: "supply", state: "queued", text: "x", requestedAt: at, doneAt: null, message: null } })).toBe(false);
  });

  it("手机登记：再改一轮不带话，我来补必须带话", () => {
    expect(Value.Check(CardRelayRequest, { kind: "return" })).toBe(true);
    expect(Value.Check(CardRelayRequest, { kind: "supply", text: "申请号是 123" })).toBe(true);
    expect(Value.Check(CardRelayRequest, { kind: "supply" })).toBe(false);
  });

  it("首页等你多 needs_person 和第二行摘要；项目动态多 card_needs_person，过了的行带缺口原因", () => {
    const row = { id: `needs_person:card:${uuid}`, kind: "needs_person", title: "等你补", source: "候选名初查", at, open: { kind: "card", id: uuid }, taskId: null, projectId: uuid,
      sessionId: null, deviceId: null, deviceName: null, letter: "A", dueAt: null, answer: "open", person: null, month: null, question: null, permission: null,
      summary: "就差申请号，要你登录商标网查" };
    expect(Value.Check(WaitingItem, row)).toBe(true);
    const { summary: _drop, ...old } = row;
    expect(Value.Check(WaitingItem, { ...old, kind: "verdict" })).toBe(true);
    expect(Value.Check(ProjectFeedItem, { kind: "card_needs_person", id: "n1", at, cardId: uuid, title: "初查", handbackId: uuid, fix: null, sourceWordIssues: [],
      handback: { ...brief, outcome: "needs_person" } })).toBe(true);
    expect(Value.Check(ProjectFeedItem, { kind: "card_passed", id: "p1", at, cardId: uuid, title: "初查", met: 2, total: 3, merge: null, gap: "申请号先不要了" })).toBe(true);
    expect(Value.Check(WorkerMark, "needs_person")).toBe(true);
  });
});

describe("主循环契约：批准说人话、停了有交代（第 64、65 条）", () => {
  it("批准带 description 和会动的路径；老本机不带照旧合法", () => {
    const permission = { requestId: "r1", toolName: "Bash", title: "运行 curl …", outsidePaths: [] };
    expect(Value.Check(LocalPermissionBrief, permission)).toBe(true);
    expect(Value.Check(LocalPermissionBrief, { ...permission, description: "查商标网上这 3 个名字", paths: ["notes/候选名.md"] })).toBe(true);
    expect(Value.Check(LocalSessionEvent, { seq: 3, at, sessionId: uuid, type: "permission_request", request: { requestId: "r1", toolName: "Bash", title: "运行 curl …",
      input: {}, outsidePaths: [], canAllowForSession: false, requestedAt: at, description: "查商标网上这 3 个名字" } })).toBe(true);
  });

  it("停下原因多 runner_restart：同步条目和状态事件都认", () => {
    expect(Value.Check(LocalSyncBatchRequest, batch("stopped", { why: "runner_restart", summary: null, blocker: null, outputs: [] }))).toBe(true);
    expect(Value.Check(LocalSessionEvent, { seq: 4, at, sessionId: uuid, type: "status", status: "exited", reason: "本机程序重启", why: "runner_restart" })).toBe(true);
    expect(Value.Check(LocalSessionEvent, { seq: 4, at, sessionId: uuid, type: "status", status: "exited" })).toBe(true);
    expect(Value.Check(LocalSessionEvent, { seq: 5, at, sessionId: uuid, type: "verdict", handbackKey: key, passed: false, summary: "就差申请号", criteria: [], beyondScope: [],
      failStreak: 0, blocked: false, returnText: null, needsPerson: true })).toBe(true);
  });
});

it("OpenAPI 里列了主循环的三个新接口", () => {
  const doc = buildOpenApiDocument() as { paths: Record<string, Record<string, unknown>> };
  expect(doc.paths["/api/me/cards/{id}/handbacks/{handbackId}/relay"]?.post).toBeTruthy();
  expect(doc.paths["/api/me/cards/{id}/agreement-changes"]?.get).toBeTruthy();
  expect(doc.paths["/api/me/cards/{id}/agreement-proposals/{proposalId}/decision"]?.post).toBeTruthy();
});
