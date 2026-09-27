import { beforeAll, describe, expect, it } from "vitest";
import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import * as contracts from "../src/index.js";
import { buildOpenApiDocument } from "../src/openapi.js";

// 运行时的格式校验在 Fastify（ajv）里；这里只为 Value.Check 局部注册用到的三种格式。
beforeAll(() => {
  FormatRegistry.Set("uuid", (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value));
  FormatRegistry.Set("date", (value) => /^\d{4}-\d{2}-\d{2}$/.test(value));
  FormatRegistry.Set("date-time", (value) => !Number.isNaN(Date.parse(value)) && /T/.test(value));
});

const fingerprint = "a".repeat(64);
const candidate = { sourceFingerprint: fingerprint, directionId: "d_0123456789ab", summary: "一句结论", reason: "和方向的关系", evidenceQuote: "原文", relevance: 4 };

describe("personal radar contract", () => {
  it("publishes every personal and company radar route with its error boundaries", () => {
    const api = buildOpenApiDocument() as any;
    expect(api.paths["/api/me/radar"].get.responses["403"]).toBeDefined();
    expect(api.paths["/api/me/radar"].put.requestBody.content["application/json"].schema.$ref).toBe("#/components/schemas/PutMyRadarRequest");
    expect(api.paths["/api/me/radar/signals"].get.parameters[0]).toMatchObject({ name: "limit", in: "query" });
    expect(api.paths["/api/me/radar/signals/{id}"].get.responses["404"]).toBeDefined();
    expect(api.paths["/api/me/radar/signals/{id}/state"].patch.requestBody.content["application/json"].schema.$ref).toBe("#/components/schemas/SignalStateRequest");
    expect(Object.keys(api.paths["/api/me/radar/scan"].post.responses)).toEqual(expect.arrayContaining(["202", "409", "429"]));
    expect(api.paths["/api/config/radar"].put.responses["400"]).toBeDefined();
    for (const name of ["MyRadar", "PersonalSignal", "PersonalSignalBrief", "MemberRadarBrief", "CompanyRadarSettings"]) expect(api.components.schemas[name]).toBeDefined();
  });

  it("bounds settings at 5 directions and 10 sources", () => {
    const put = (directions: number, sources: number) => Value.Check(contracts.PutMyRadarRequest, {
      enabled: true, directions: Array.from({ length: directions }, (_, index) => `方向 ${index}`), sources: Array.from({ length: sources }, (_, index) => `site${index}.com`),
    });
    expect(put(5, 10)).toBe(true);
    expect(put(6, 0)).toBe(false);
    expect(put(1, 11)).toBe(false);
    expect(Value.Check(contracts.PutCompanyRadarRequest, { directions: [""], sources: [] })).toBe(false);
    expect(contracts.RADAR_DIRECTION_MAX_CHARS).toBe(40);
  });

  it("keeps the judge submission free of promotion or extra fields", () => {
    expect(Value.Check(contracts.PersonalRadarJudgeSubmission, { candidates: [candidate] })).toBe(true);
    expect(Value.Check(contracts.PersonalRadarJudgeSubmission, { candidates: [] })).toBe(true);
    expect(Value.Check(contracts.PersonalRadarJudgeSubmission, { candidates: [{ ...candidate, promotion: {} }] })).toBe(false);
    expect(Value.Check(contracts.PersonalRadarJudgeSubmission, { candidates: [{ ...candidate, relevance: 6 }] })).toBe(false);
    expect(Value.Check(contracts.PersonalRadarJudgeSubmission, { candidates: [{ ...candidate, sourceFingerprint: "not-a-hash" }] })).toBe(false);
  });

  it("lets a list item carry its listing day instead of a publish time", () => {
    const signal = {
      id: "00000000-0000-4000-8000-000000000001",
      source: { type: "list", label: "GitHub Trending", title: "owner/repo", url: "https://github.com/owner/repo", publishedAt: null, listedOn: "2026-10-01",
        listing: { language: "TypeScript", starsInPeriod: 2608, since: "daily" } },
      direction: { id: "d_0123456789ab", text: "1 号位产品的设计" },
      summary: "一句结论", reason: "和方向的关系", relevance: 3,
      state: { read: false, saved: false, dismissed: false }, collectedAt: "2026-10-01T02:00:00.000Z",
    };
    expect(Value.Check(contracts.PersonalSignalBrief, signal)).toBe(true);
    expect(Value.Check(contracts.PersonalSignal, { ...signal, excerpt: "原文", fullText: false, evidenceQuote: "原文" })).toBe(true);
    expect(Value.Check(contracts.PersonalSignalBrief, { ...signal, excerpt: "列表不带原文" })).toBe(false);
    // 榜单的时段只有日／周／月三种；非榜单来源的 listing 为 null
    expect(Value.Check(contracts.PersonalSignalBrief, { ...signal, source: { ...signal.source, listing: { ...signal.source.listing, since: "yearly" } } })).toBe(false);
    expect(Value.Check(contracts.PersonalSignalBrief, { ...signal, source: { ...signal.source, type: "web", publishedAt: "2026-10-01T01:00:00.000Z", listedOn: null, listing: null } })).toBe(true);
  });

  it("adds The Information as an Atom outlet in the shared catalog", () => {
    const outlet = contracts.RADAR_OUTLETS.find((item) => item.outletId === "theinformation");
    expect(outlet?.channels).toEqual([{ kind: "atom", url: "https://www.theinformation.com/feed" }]);
    expect(contracts.RADAR_OUTLETS.every((item) => Value.Check(contracts.RadarOutlet, item))).toBe(true);
  });

  it("reports the radar step in onboarding for both roles", () => {
    const api = buildOpenApiDocument() as any;
    for (const variant of api.components.schemas.OnboardingResponse.anyOf) expect(variant.required).toContain("radar");
  });
});
