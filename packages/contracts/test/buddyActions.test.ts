import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { beforeAll, describe, expect, it } from "vitest";
import { BUDDY_ACTION_NAMES, BuddyActionParams, MAIN_ONLY_ACTIONS, BuddyAuthority, BuddyMessageDraft, BuddyPlan, BuddyUiEffect, ClaimSessionStopsResponse, ConversationSseEvent } from "../src/index.js";

const uuid = "11111111-1111-4111-8111-111111111111";
const at = "2026-11-08T02:00:00.000Z";

beforeAll(() => {
  FormatRegistry.Set("uuid", (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v));
  FormatRegistry.Set("date-time", (v) => !Number.isNaN(Date.parse(v)) && /T/.test(v));
});

describe("伙伴代本人做事（17.4）", () => {
  it("第一批动作的参数：名字齐全；写错的参数不收", () => {
    expect(BUDDY_ACTION_NAMES).toEqual(expect.arrayContaining(["message_project", "set_appearance", "open_page", "start_sub_session", "stop_sub_session", "archive_sub_session",
      "delete_sub_session", "create_project", "rename_project", "archive_project", "link_task_to_project", "transfer_project", "split_cards", "set_budget",
      "set_feishu_push", "send_message", "update_plan"]));
    expect(Value.Check(BuddyActionParams.set_appearance, { appearance: "dark" })).toBe(true);
    expect(Value.Check(BuddyActionParams.set_appearance, { appearance: "blue" })).toBe(false);
    expect(Value.Check(BuddyActionParams.open_page, { target: { kind: "project", id: uuid } })).toBe(true);
    expect(Value.Check(BuddyActionParams.open_page, { target: { kind: "preferences" } })).toBe(true);
    expect(Value.Check(BuddyActionParams.send_message, { toPersonIds: [], text: "周五前给我报价" })).toBe(false);
    expect(Value.Check(BuddyActionParams.update_plan, { entries: [{ content: "归档三个项目", status: "in_progress" }, { content: "告诉晨星", status: "pending" }] })).toBe(true);
  });

  it("授权、转达草稿、本机停掉、插进对话流的计划清单、界面效果和回执", () => {
    expect(Value.Check(BuddyAuthority, { authority: "full", grantedAt: at })).toBe(true);
    expect(Value.Check(BuddyAuthority, { authority: "none", grantedAt: null })).toBe(true);
    expect(Value.Check(BuddyMessageDraft, { id: uuid, to: [{ personId: "p-2", name: "晨星" }], text: "周五前给我报价", status: "draft", createdAt: at, sentAt: null, failed: [], unknown: [] })).toBe(true);
    expect(Value.Check(BuddyMessageDraft, { id: uuid, to: [{ personId: "p-2", name: "晨星" }, { personId: "p-3", name: "溪南" }], text: "周五前给我报价", status: "sent", createdAt: at, sentAt: at,
      failed: [{ personId: "p-3", name: "溪南" }], unknown: [{ personId: "p-2", name: "晨星" }] })).toBe(true);
    expect(Value.Check(ClaimSessionStopsResponse, { stops: [{ id: uuid, kind: "card", subSessionId: uuid, sessionId: uuid, deviceId: uuid, requestedAt: at }] })).toBe(true);
    const base = { runId: "r-1", scope: "global", sequence: 3 };
    expect(Value.Check(BuddyPlan, { entries: [{ content: "归档", status: "completed" }], collapsed: false })).toBe(true);
    expect(Value.Check(ConversationSseEvent, { ...base, type: "plan", plan: { entries: [{ content: "归档", status: "completed" }, { content: "告诉晨星", status: "in_progress" }], collapsed: false } })).toBe(true);
    expect(Value.Check(ConversationSseEvent, { ...base, type: "ui", ui: { kind: "appearance", appearance: "dark" } })).toBe(true);
    // 这一轮实际用的来源和模型（只这两样）。
    expect(Value.Check(ConversationSseEvent, { ...base, type: "model", provider: "tokenhub", model: "claude-opus-5-5" })).toBe(true);
    expect(Value.Check(ConversationSseEvent, { ...base, type: "model", provider: "tokenhub", model: "claude-opus-5-5", apiKey: "x" })).toBe(false);
    expect(Value.Check(ConversationSseEvent, { ...base, type: "ui", ui: { kind: "refresh", what: ["work_home", "project"], id: uuid } })).toBe(true);
    expect(Value.Check(BuddyUiEffect, { kind: "refresh", what: [] })).toBe(false);
    expect(Value.Check(ConversationSseEvent, { ...base, type: "receipt", state: "read", messageId: "m1" })).toBe(true);
    // 中途插话时 delivered 先到，还没有这一轮：不带 runId；messageId 必带。
    const { runId: _runId, ...noRun } = base;
    expect(Value.Check(ConversationSseEvent, { ...noRun, type: "receipt", state: "delivered", messageId: "m1" })).toBe(true);
    expect(Value.Check(ConversationSseEvent, { ...base, type: "receipt", state: "read" })).toBe(false);
    expect(Value.Check(ConversationSseEvent, { ...noRun, type: "error", code: "TURN_IN_PROGRESS", message: "上一轮停不下来" })).toBe(true);
  });

  it("读同事资料的两个动作：参数和只在主线用", () => {
    expect(Value.Check(BuddyActionParams.read_colleague_catalog, { query: "研发" })).toBe(true);
    expect(Value.Check(BuddyActionParams.read_colleague_catalog, { query: "研" })).toBe(false);
    expect(Value.Check(BuddyActionParams.read_colleague_item, { personId: "p-2", itemId: "task:a:b" })).toBe(true);
    expect(Value.Check(BuddyActionParams.read_colleague_item, { personId: "p-2" })).toBe(false);
    expect(MAIN_ONLY_ACTIONS).toEqual(["open_session", "tell_session", "read_colleague_catalog", "read_colleague_item", "ask_colleague_buddy"]);
  });
});
