import { describe, expect, it } from "vitest";
import type { Card } from "./api/client";
import { interpretActionResponse, replaceActionCard } from "./actionResponse";

const card = (version: number): Card =>
  ({ schemaVersion: 1, id: "issue:1", version, kind: "issue", objectRef: { type: "issue", id: "1", version }, title: "对象", payload: {}, actions: [] }) as Card;

describe("Action response → 展示状态", () => {
  it("成功时返回新 Card，交给页面更新 cache", () => {
    const outcome = interpretActionResponse(200, { cards: [card(2)] }, undefined);
    expect(outcome).toEqual({ kind: "ok", card: expect.objectContaining({ version: 2 }) });
  });

  it("409 带 latestCard：先刷新对象，再要求重新核对", () => {
    const outcome = interpretActionResponse(409, undefined, {
      code: "CARD_VERSION_CONFLICT",
      message: "对象已被修改",
      retryable: true,
      requestId: "req-1",
      latestCard: card(3),
    });
    expect(outcome).toEqual({ kind: "conflict", message: "对象已被修改", latestCard: expect.objectContaining({ version: 3 }) });
  });

  it("409 缺 latestCard 时仍给出可读提示", () => {
    const outcome = interpretActionResponse(409, undefined, { code: "CONFLICT", retryable: true, requestId: "req-2" });
    expect(outcome).toEqual({ kind: "conflict", message: "对象已被修改，请基于最新内容重新核对" });
  });

  it("业务失败展示服务端 message 并可重试", () => {
    const outcome = interpretActionResponse(400, undefined, {
      code: "MONTHLY_PLAN_UNCHECKED_ITEMS",
      message: "签发前必须核对企业结果、战场结果与普通待办",
      retryable: false,
      requestId: "req-3",
    });
    expect(outcome).toEqual({ kind: "error", message: "签发前必须核对企业结果、战场结果与普通待办" });
  });

  it("401 不带业务提示，交给调用方跳转访问口令页", () => {
    expect(interpretActionResponse(401, undefined, { message: "未登录" })).toEqual({ kind: "unauthorized" });
  });
});

describe("首页动作后的 Card 替换", () => {
  it("新轮次按战场与月份替换原 slot，保留其他战场和月份", () => {
    const slot = (battlefieldId: string, period: string) => ({ ...card(1), id: `slot:${battlefieldId}:${period}`, kind: "mission-round", payload: { battlefieldId, period }, objectRef: { type: "mission-round-slot", id: `${battlefieldId}:${period}`, version: 1 } }) as Card;
    const current = [card(1), slot("01", "2026-10"), slot("02", "2026-10"), slot("01", "2026-11")];
    const actual = { ...slot("01", "2026-10"), id: "mission-round:actual", objectRef: { type: "mission-round", id: "actual", version: 1 } } as Card;
    expect(replaceActionCard(current, actual)).toEqual([current[0], actual, current[2], current[3]]);
    expect(replaceActionCard([actual], { ...actual, version: 2 })).toEqual([{ ...actual, version: 2 }]);
  });

  it("其他对象仍按 id 替换，不把不在首页的对象加入首页", () => {
    expect(replaceActionCard([card(1)], card(2))).toEqual([card(2)]);
    expect(replaceActionCard([card(1)], { ...card(2), id: "issue:2" })).toEqual([card(1)]);
  });
});
