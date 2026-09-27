import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import * as contracts from "../src/index.js";
import { buildOpenApiDocument } from "../src/openapi.js";

describe("member home contract", () => {
  it("requires shared current-month work alongside execution items", () => {
    expect(Value.Check(contracts.MeHomeResponse, { myTasks: [] })).toBe(false);
    expect(Value.Check(contracts.MeHomeResponse, { myTasks: [], work: {
      period: "2026-10", planStatus: "none", battlefields: [], missions: [], missionCards: [],
    } })).toBe(true);
  });
  it("publishes member battlefield detail with its 404 boundary and named work schema", () => {
    const api = buildOpenApiDocument() as any;
    expect(api.components.schemas.MemberWork).toBeDefined();
    expect(api.components.schemas.MemberBattlefieldResponse).toBeDefined();
    expect(api.paths["/api/me/battlefields/{id}"].get.responses["404"]).toBeDefined();
  });
});
