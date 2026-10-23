import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import * as contracts from "../src/index.js";
import { buildOpenApiDocument } from "../src/openapi.js";

const item = (suggestion: unknown, otherAttendees = 0) => ({
  minuteToken: "obcn123",
  title: "临时对一下",
  startsAt: "2026-10-23T02:00:00.000Z",
  endsAt: "2026-10-23T02:30:00.000Z",
  attendees: [{ personId: "p1", displayName: "孙明泽" }],
  otherAttendees,
  suggestion,
});

describe("feishu minute inbox contract", () => {
  it("accepts pending minutes with or without a suggested meeting", () => {
    const sample = { minutes: [item(null, 2), item({ meetingId: "m1", title: "Inception 设计会" })] };
    expect(Value.Check(contracts.FeishuMinuteInboxResponse, sample)).toBe(true);
    expect(Value.Check(contracts.FeishuMinuteInboxResponse, { minutes: [item(null, -1)] })).toBe(false);
  });

  it("bounds the organize request", () => {
    const anchor = { kind: "mission", id: "mission:M1" };
    expect(Value.Check(contracts.OrganizeFeishuMinuteRequest, { title: "临时对一下", anchors: [anchor] })).toBe(true);
    expect(Value.Check(contracts.OrganizeFeishuMinuteRequest, { title: "临时对一下", anchors: [] })).toBe(false);
    expect(Value.Check(contracts.OrganizeFeishuMinuteRequest, { title: "临时对一下", anchors: Array(11).fill(anchor) })).toBe(false);
    expect(Value.Check(contracts.OrganizeFeishuMinuteRequest, { title: "字".repeat(201), anchors: [anchor] })).toBe(false);
  });

  it("publishes the four inbox paths and their schemas", () => {
    const api = buildOpenApiDocument() as any;
    expect(api.paths["/api/me/feishu-minutes"].get.operationId).toBe("listMyFeishuMinutes");
    expect(api.paths["/api/me/feishu-minutes/{token}/organize"].post.operationId).toBe("organizeFeishuMinute");
    expect(api.paths["/api/me/feishu-minutes/{token}/attach"].post.operationId).toBe("attachFeishuMinute");
    expect(api.paths["/api/me/feishu-minutes/{token}/ignore"].post.responses["204"]).toBeDefined();
    for (const name of ["FeishuMinuteInboxResponse", "OrganizeFeishuMinuteRequest", "AttachFeishuMinuteRequest", "FeishuMinuteMeetingResponse"]) {
      expect(api.components.schemas[name]).toBeDefined();
    }
  });
});
