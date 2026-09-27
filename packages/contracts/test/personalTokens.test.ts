import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { AppendTaskProgressRequest, MissionCardItemsResponse, TaskProgressEntry, TaskView,
  CreatePersonalTokenRequest, CreatePersonalTokenResponse, ListPersonalTokensResponse } from "../src/index.js";
import { buildOpenApiDocument } from "../src/openapi.js";

describe("工单 06 契约", () => {
  it("个人令牌只能选择客户端和有效期，列表不包含明文", () => {
    expect(Value.Check(CreatePersonalTokenRequest, { name: "工作机", client: "codex", expiresInDays: 30 })).toBe(true);
    expect(Value.Check(CreatePersonalTokenRequest, { name: "工作机", client: "claude", expiresInDays: null })).toBe(true);
    expect(Value.Check(CreatePersonalTokenRequest, { name: "", client: "codex", expiresInDays: 60 })).toBe(false);
    expect(Value.Check(ListPersonalTokensResponse, { tokens: [], mcpPath: "/mcp/me" })).toBe(true);
    expect(Value.Check(ListPersonalTokensResponse, { tokens: [], mcpPath: "/mcp/me", token: "secret" })).toBe(false);
    expect(CreatePersonalTokenResponse.properties).toHaveProperty("token");
  });
  it("进展正文、证据链接和读摘要有明确上限", () => {
    const request = { clientEventId: "00000000-0000-4000-8000-000000000001", body: "完成核对", links: [{ url: "https://example.com/pr" }] };
    const withoutFormat = { ...AppendTaskProgressRequest, properties: { ...AppendTaskProgressRequest.properties,
      clientEventId: { ...AppendTaskProgressRequest.properties.clientEventId, format: undefined } } };
    expect(Value.Check(withoutFormat, request)).toBe(true);
    expect(Value.Check(withoutFormat, { ...request, body: "x".repeat(2001) })).toBe(false);
    expect(Value.Check(withoutFormat, { ...request, links: [{ url: "file:///etc/passwd" }] })).toBe(false);
    expect(Value.Check(withoutFormat, { ...request, links: Array(6).fill({ url: "https://example.com" }) })).toBe(false);
    expect(TaskView.properties).toHaveProperty("latestProgress");
    expect(TaskProgressEntry.properties).toHaveProperty("links");
    expect(MissionCardItemsResponse.properties).toHaveProperty("missions");
  });
  it("REST 路由登记在 OpenAPI", () => {
    const paths = buildOpenApiDocument().paths;
    expect(paths["/api/me/tokens"]?.get).toBeDefined();
    expect(paths["/api/me/tokens"]?.post).toBeDefined();
    expect(paths["/api/me/tokens/{id}"]?.delete).toBeDefined();
    expect(paths["/api/me/tasks/{id}/progress"]?.post).toBeDefined();
    expect(paths["/api/mission-cards/{cardId}/items"]?.get).toBeDefined();
  });
});
