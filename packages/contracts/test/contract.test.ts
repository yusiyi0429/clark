import { describe, expect, it } from "vitest";
import { buildOpenApiDocument } from "../src/openapi.js";
import { ApiError, ActionDescriptor, Card, ConversationMessageRequest, ConversationScope, ConversationSseEvent } from "../src/index.js";
import { Value } from "@sinclair/typebox/value";

describe("openapi contract", () => {
  const doc = buildOpenApiDocument();

  it("exposes the public API surface", () => {
    const paths = Object.keys(doc.paths);
    expect(paths).toEqual(
      expect.arrayContaining([
        "/api/auth/login",
        "/api/auth/logout",
        "/api/auth/session",
        "/api/cards/home",
        "/api/cards/issues/{id}",
        "/api/actions/execute",
        "/api/conversations/{scope}/messages",
        "/healthz",
      ]),
    );
  });

  it("publishes card, action and error schemas as components", () => {
    expect(Object.keys(doc.components.schemas)).toEqual(
      expect.arrayContaining(["Card", "ActionDescriptor", "ApiError"]),
    );
  });

  it("version conflict responses document ApiError", () => {
    const execute = doc.paths["/api/actions/execute"].post;
    expect(execute.responses["409"]).toBeDefined();
    expect(execute.responses["409"].content["application/json"].schema).toMatchObject({
      $ref: "#/components/schemas/ApiError",
    });
  });
});

describe("card envelope schema", () => {
  it("rejects a card without kind, version or actions", () => {
    const bad = { schemaVersion: 1, id: "home", title: "x" };
    expect(Value.Check(Card, bad)).toBe(false);
  });

  it("accepts a well-formed card with one action descriptor", () => {
    const card = {
      schemaVersion: 1,
      id: "home:default",
      version: 3,
      kind: "home",
      objectRef: { type: "home", id: "default", version: 3 },
      title: "首页",
      payload: {},
      actions: [
        { actionId: "tok", actionType: "home.dismiss_notice", label: "知道了" },
      ],
    };
    expect(Value.Check(Card, card)).toBe(true);
    expect(Value.Check(ActionDescriptor, card.actions[0])).toBe(true);
  });
});

describe("conversation public contract", () => {
  it("accepts stable global/object scopes and trusted-reference input only", () => {
    expect(Value.Check(ConversationScope, "global")).toBe(true);
    for (const type of ["issue", "signal", "meeting", "monthly-plan"]) {
      expect(Value.Check(ConversationScope, `${type}:fixture-001`)).toBe(true);
    }
    expect(Value.Check(ConversationScope, "home:default")).toBe(false);
    expect(Value.Check(ConversationMessageRequest, {
      message: "比较这些依据",
      references: [{ cardId: "home:default", version: 1 }],
    })).toBe(true);
    expect(Value.Check(ConversationMessageRequest, {
      message: "伪造",
      references: [{ cardId: "home:default", version: 1, payload: { trusted: false } }],
    })).toBe(false);
  });

  it("defines message, tool lifecycle, usage, error and done SSE events", () => {
    const common = { runId: "run-1", scope: "global", sequence: 1 };
    for (const event of [
      { ...common, type: "message", delta: "回答" },
      { ...common, type: "tool", phase: "started", toolCallId: "tool-1", name: "search_people" },
      { ...common, type: "tool", phase: "completed", toolCallId: "tool-1", name: "search_people", isError: false },
      { ...common, type: "usage", input: 3, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 5 },
      { ...common, type: "error", code: "RUNTIME_FAILED", message: "模型失败" },
      { ...common, type: "done", status: "completed" },
    ]) expect(Value.Check(ConversationSseEvent, event)).toBe(true);
  });
});

describe("error envelope schema", () => {
  it("carries code, retryable and optional latestCard for version conflicts", () => {
    const err = {
      code: "VERSION_CONFLICT",
      message: "对象已被修改",
      retryable: false,
      requestId: "req_1",
      latestCard: {
        schemaVersion: 1,
        id: "home:default",
        version: 4,
        kind: "home",
        objectRef: { type: "home", id: "default", version: 4 },
        title: "首页",
        payload: {},
        actions: [],
      },
    };
    expect(Value.Check(ApiError, err)).toBe(true);
    expect(Value.Check(ApiError, { code: "X" })).toBe(false);
  });
});
