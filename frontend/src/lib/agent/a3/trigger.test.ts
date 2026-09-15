import { describe, expect, it } from "vitest";
import { makeProvenance } from "./provenance";
import { expireTriggers, proposeTrigger, TRIGGER_TTL_DAYS } from "./trigger";
import type { TargetRef } from "./stages";

const target: TargetRef = { kind: "judgment", id: "J-2", text: "这个市场今年不会有新玩家", href: "/judgments/J-2" };
const prov = makeProvenance("I-7");

describe("proposeTrigger", () => {
  it("预研只写得到 proposed —— 一条都不布控", () => {
    const t = proposeTrigger({
      seq: 1, condition: "该公司公开发布同类产品", targetRef: target,
      source: "watch", onFire: "proposeDiscuss", nowIso: "2026-08-27T00:00:00.000Z", provenance: prov,
    });
    expect(t.status).toBe("proposed");
    expect(t.id).toBe("TG-I-7-1");
    expect(t.onFire).toBe("proposeDiscuss");
  });

  it("到期日必填，默认 90 天", () => {
    const t = proposeTrigger({
      seq: 1, condition: "该公司公开发布同类产品", targetRef: target,
      source: "watch", onFire: "notify", nowIso: "2026-08-27T00:00:00.000Z", provenance: prov,
    });
    expect(TRIGGER_TTL_DAYS).toBe(90);
    expect(t.expiresAt).toBe("2026-11-25T00:00:00.000Z");
  });

  it("条件是空串或超长直接抛 —— 核不了的监控条件等于没有", () => {
    const base = { seq: 1, targetRef: target, source: "watch", onFire: "notify", nowIso: "2026-08-27T00:00:00.000Z", provenance: prov } as const;
    expect(() => proposeTrigger({ ...base, condition: "  " })).toThrow(/条件/);
    expect(() => proposeTrigger({ ...base, condition: "长".repeat(81) })).toThrow(/条件/);
  });
});

describe("expireTriggers", () => {
  const t = proposeTrigger({
    seq: 1, condition: "该公司公开发布同类产品", targetRef: target,
    source: "watch", onFire: "proposeDiscuss", nowIso: "2026-08-27T00:00:00.000Z", provenance: prov,
  });

  it("过了到期日的转 expired，并报出是哪几条", () => {
    const r = expireTriggers([{ ...t, status: "active" }], "2026-12-01T00:00:00.000Z");
    expect(r.next[0].status).toBe("expired");
    expect(r.expired).toEqual(["TG-I-7-1"]);
  });

  it("没到期的原样留着", () => {
    const r = expireTriggers([{ ...t, status: "active" }], "2026-09-01T00:00:00.000Z");
    expect(r.next[0].status).toBe("active");
    expect(r.expired).toEqual([]);
  });

  it("已经开过火的不再改 —— fired 是终态", () => {
    const r = expireTriggers([{ ...t, status: "fired", firedAt: "2026-09-01T00:00:00.000Z" }], "2026-12-01T00:00:00.000Z");
    expect(r.next[0].status).toBe("fired");
    expect(r.expired).toEqual([]);
  });
});
