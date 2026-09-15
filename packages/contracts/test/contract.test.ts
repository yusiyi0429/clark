import { describe, expect, it } from "vitest";
import { buildOpenApiDocument } from "../src/openapi.js";
import { ApiError, ActionDescriptor, Card } from "../src/index.js";
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
        "/api/actions/execute",
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
