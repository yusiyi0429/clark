import { describe, expect, it } from "vitest";
import { decideFailure, NOTICE_PROXY, NOTICE_QUOTA, NOTICE_UNAVAILABLE, parseAsrMessage } from "./dictationAsr";
import { RUN_20_SLICES, tencentMessage } from "./dictationFixture";

describe("腾讯实时识别的消息", () => {
  it("老格式 result.slice_type：句子序号、稳态、文字、结束时间", () => {
    const message = parseAsrMessage(tencentMessage(RUN_20_SLICES[16]));
    expect(message).toEqual({ code: 0, message: "success", final: false, slice: { index: 0, type: 2, text: RUN_20_SLICES[16][3], endMs: 9360 } });
  });

  it("握手（code:0、没有 result）、final、错误码", () => {
    expect(parseAsrMessage(tencentMessage(null))).toEqual({ code: 0, message: "success", final: false, slice: null });
    expect(parseAsrMessage(tencentMessage(null, { final: 1 }))?.final).toBe(true);
    expect(parseAsrMessage(JSON.stringify({ code: 4004, message: "资源包用完" }))).toMatchObject({ code: 4004, slice: null });
  });

  it("V2 文档的 sentences 格式也认", () => {
    const raw = JSON.stringify({ code: 0, sentences: { sentence: "你好。", sentence_type: 2, sentence_id: 3, end_time: 900 } });
    expect(parseAsrMessage(raw)?.slice).toEqual({ index: 3, type: 2, text: "你好。", endMs: 900 });
  });

  it("不是 JSON / 不是文本：忽略", () => {
    expect(parseAsrMessage("not json")).toBeNull();
    expect(parseAsrMessage(new ArrayBuffer(2))).toBeNull();
    expect(parseAsrMessage("3")).toBeNull();
  });
});

describe("出错了走哪条路（调研 §6）", () => {
  const decide = (stage: "session" | "handshake" | "streaming", detail: { code?: number; status?: number } = {}, reconnected = false) =>
    decideFailure({ stage, ...detail, reconnected });

  it("签发接口：503 没配置 → 后备、本页不再试；429 / 断网 → 后备这一次", () => {
    expect(decide("session", { status: 503 })).toEqual({ action: "fallback", notice: NOTICE_UNAVAILABLE, disableRealtime: true });
    expect(decide("session", { status: 429 })).toEqual({ action: "fallback", notice: NOTICE_UNAVAILABLE, disableRealtime: false });
    expect(decide("session", { status: 0 }).action).toBe("fallback");
  });

  it("额度用完 / 欠费 → 后备 + 额度提示，本页不再试", () => {
    for (const code of [4004, 4005]) {
      expect(decide("handshake", { code })).toEqual({ action: "fallback", notice: NOTICE_QUOTA, disableRealtime: true });
      expect(decide("streaming", { code })).toEqual({ action: "fallback", notice: NOTICE_QUOTA, disableRealtime: true });
    }
  });

  it("境外代理 6001 → 后备 + 代理提示", () => {
    expect(decide("handshake", { code: 6001 })).toEqual({ action: "fallback", notice: NOTICE_PROXY, disableRealtime: false });
  });

  it("握手错误（参数 / 鉴权 / 未开通 / 并发 / 连不上）→ 后备这一次", () => {
    for (const code of [4001, 4002, 4003, 4006, undefined]) {
      expect(decide("handshake", { code })).toEqual({ action: "fallback", notice: NOTICE_UNAVAILABLE, disableRealtime: false });
    }
  });

  it("握手后断线、5000–5002、4009 → 重连一次；重连过了 → 后备", () => {
    for (const code of [undefined, 5000, 5001, 5002, 4009, 4000, 4008]) {
      expect(decide("streaming", { code }).action).toBe("reconnect");
      expect(decide("streaming", { code }, true).action).toBe("fallback");
    }
    expect(decide("handshake", { code: 5001 }).action).toBe("reconnect");
    expect(decide("handshake", { code: 5001 }, true).action).toBe("fallback");
  });
});
