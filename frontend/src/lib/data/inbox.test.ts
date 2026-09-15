/**
 * 跨仓库契约的这一半。另一半是 `tkos-lab/src/tkos_lab/deliver.py` 的
 * `build_payload`，**改它要同时改两处** —— 两边各有测试钉住同一个形状。
 */
import { describe, expect, it } from "vitest";

import { INBOX_TEXT_MAX, inboxEvictees, parseInboxPayload } from "./inbox";
import type { InboxSignal } from "./types";

const sig = (over: Record<string, unknown> = {}) => ({
  dedupe_key: "https://a.com/x",
  title: "大厂把 To B 的销售与交付合并成行业线",
  url: "https://a.com/x?utm_source=w",
  text: "正文",
  published_at: "2026-08-18T02:00:00Z",
  source: "36氪·AI",
  origin: "pinned",
  score: 4.2,
  dimensions: { materiality: 4, novelty: 3 },
  kiq: "KIQ2.2",
  why: "它指向采购决策权的转移。",
  suggested_issue: "入口移到交付侧之后我们的差异还剩多少",
  ...over,
});

const payload = (signals: unknown[]) => ({
  run_id: "RUN-7",
  scanned_at: "2026-08-19T07:00:00Z",
  signals,
});

describe("parseInboxPayload", () => {
  it("蛇形转驼峰，一条不丢", () => {
    const got = parseInboxPayload(payload([sig()]));
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.runId).toBe("RUN-7");
    expect(got.scannedAt).toBe("2026-08-19T07:00:00Z");
    expect(got.signals[0]).toEqual({
      kind: "crawled",
      dedupeKey: "https://a.com/x",
      title: "大厂把 To B 的销售与交付合并成行业线",
      url: "https://a.com/x?utm_source=w",
      text: "正文",
      publishedAt: "2026-08-18T02:00:00Z",
      source: "36氪·AI",
      origin: "pinned",
      score: 4.2,
      dimensions: { materiality: 4, novelty: 3 },
      kiq: "KIQ2.2",
      why: "它指向采购决策权的转移。",
      suggestedIssue: "入口移到交付侧之后我们的差异还剩多少",
      runId: "RUN-7",
      scannedAt: "2026-08-19T07:00:00Z",
    });
  });

  it("空批次是合法的 —— 这一轮什么都没过线也要能回话", () => {
    const got = parseInboxPayload(payload([]));
    expect(got).toEqual({ ok: true, runId: "RUN-7", scannedAt: "2026-08-19T07:00:00Z", signals: [] });
  });

  it("身份字段缺了整批拒收，并且点名是第几条的哪个字段", () => {
    const got = parseInboxPayload(payload([sig(), sig({ dedupe_key: "  " })]));
    expect(got.ok).toBe(false);
    if (got.ok) return;
    expect(got.error).toContain("signals[1].dedupe_key");
  });

  it("分数不是数就拒 —— 它是排序键，NaN 会让整页顺序变成随机", () => {
    const got = parseInboxPayload(payload([sig({ score: "4.2" })]));
    expect(got.ok).toBe(false);
    if (got.ok) return;
    expect(got.error).toContain("signals[0].score");
  });

  it("只用来显示的字段缺了填空串，不拒收", () => {
    const got = parseInboxPayload(payload([sig({ why: undefined, kiq: undefined, text: undefined })]));
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.signals[0].why).toBe("");
    expect(got.signals[0].kiq).toBe("");
    expect(got.signals[0].text).toBe("");
  });

  it("dimensions 缺了当空对象；值不是数就点名那个维度", () => {
    const a = parseInboxPayload(payload([sig({ dimensions: null })]));
    expect(a.ok).toBe(true);
    if (a.ok) expect(a.signals[0].dimensions).toEqual({});

    const b = parseInboxPayload(payload([sig({ dimensions: { materiality: "高" } })]));
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.error).toContain("signals[0].dimensions.materiality");
  });

  it("origin 只认两个值", () => {
    const got = parseInboxPayload(payload([sig({ origin: "manual" })]));
    expect(got.ok).toBe(false);
    if (got.ok) return;
    expect(got.error).toContain("signals[0].origin");
    expect(got.error).toContain("manual");
  });

  it("正文截断 —— 落盘是整个 store 重写一遍，全文进来会把每一次写盘都拖长", () => {
    const got = parseInboxPayload(payload([sig({ text: "字".repeat(INBOX_TEXT_MAX + 500) })]));
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.signals[0].text.length).toBe(INBOX_TEXT_MAX + 1);
    expect(got.signals[0].text.endsWith("…")).toBe(true);
  });

  it("不是对象、signals 不是数组、run_id 空 —— 三种都拒，话说清楚是哪一样", () => {
    expect(parseInboxPayload(null)).toEqual({ ok: false, error: "请求体不是一个对象。" });
    const a = parseInboxPayload({ run_id: "R", scanned_at: "T", signals: {} });
    if (!a.ok) expect(a.error).toContain("signals 不是数组");
    const b = parseInboxPayload(payload([]));
    expect(b.ok).toBe(true);
    const c = parseInboxPayload({ run_id: "", scanned_at: "T", signals: [] });
    if (!c.ok) expect(c.error).toContain("run_id");
  });

  it("published_at 非 ISO 格式归成空串，合规的原样保留", () => {
    const a = parseInboxPayload(payload([sig({ published_at: "2026年8月18日" })]));
    expect(a.ok).toBe(true);
    if (a.ok) expect(a.signals[0].publishedAt).toBe("");

    const b = parseInboxPayload(payload([sig({ published_at: "18/08/2026" })]));
    expect(b.ok).toBe(true);
    if (b.ok) expect(b.signals[0].publishedAt).toBe("");

    const c = parseInboxPayload(payload([sig({ published_at: "未知" })]));
    expect(c.ok).toBe(true);
    if (c.ok) expect(c.signals[0].publishedAt).toBe("");

    const d = parseInboxPayload(payload([sig({ published_at: "2026-08-18T02:00:00Z" })]));
    expect(d.ok).toBe(true);
    if (d.ok) expect(d.signals[0].publishedAt).toBe("2026-08-18T02:00:00Z");
  });

  it("url 协议必须是 http 或 https，拒收时点名字段", () => {
    const a = parseInboxPayload(payload([sig({ url: "javascript:alert(1)" })]));
    expect(a.ok).toBe(false);
    if (!a.ok) {
      expect(a.error).toContain("signals[0].url");
      expect(a.error).toContain("javascript:");
    }

    const b = parseInboxPayload(payload([sig({ url: "data:text/html,<script>alert(1)</script>" })]));
    expect(b.ok).toBe(false);
    if (!b.ok) {
      expect(b.error).toContain("signals[0].url");
      expect(b.error).toContain("data:");
    }

    const c = parseInboxPayload(payload([sig({ url: "ftp://example.com/file" })]));
    expect(c.ok).toBe(false);
    if (!c.ok) {
      expect(c.error).toContain("signals[0].url");
      expect(c.error).toContain("ftp:");
    }

    const d = parseInboxPayload(payload([sig({ url: "https://example.com/article" })]));
    expect(d.ok).toBe(true);

    const e = parseInboxPayload(payload([sig({ url: "http://example.com/article" })]));
    expect(e.ok).toBe(true);
  });
});

const stored = (key: string, at: string, disposed?: boolean): InboxSignal => ({
  kind: "crawled",
  dedupeKey: key,
  title: key,
  url: `https://a.com/${key}`,
  text: "",
  publishedAt: "",
  source: "s",
  origin: "pinned",
  score: 4,
  dimensions: {},
  kiq: "",
  why: "",
  suggestedIssue: "",
  runId: "RUN-7",
  scannedAt: at,
  receivedAt: at,
  ...(disposed ? { disposedAs: "watch" as const, disposedAt: at } : {}),
});

describe("inboxEvictees", () => {
  it("没超上限不丢东西", () => {
    expect(inboxEvictees([stored("a", "2026-08-01"), stored("b", "2026-08-02")], 2)).toEqual([]);
  });

  it("先丢已处置的最老那几条", () => {
    const list = [
      stored("open-old", "2026-08-01"),
      stored("done-new", "2026-08-04", true),
      stored("done-old", "2026-08-02", true),
      stored("open-new", "2026-08-03"),
    ];
    expect(inboxEvictees(list, 2).map((s) => s.dedupeKey)).toEqual(["done-old", "done-new"]);
  });

  it("已处置的不够，才动未处置的 —— 顺序仍是老的先走", () => {
    const list = [
      stored("done", "2026-08-01", true),
      stored("open-old", "2026-08-02"),
      stored("open-new", "2026-08-03"),
    ];
    expect(inboxEvictees(list, 1).map((s) => s.dedupeKey)).toEqual(["done", "open-old"]);
  });
});
