/**
 * 幂等键这一条钉的不是「函数写对了」，是「和实验台那一份算出同一个键」。
 *
 * 前三条是 tkos-lab `tests/test_end_to_end.py::test_normalize_url_strips_tracking_and_fragment`
 * 的原案，一字不改地搬过来 —— 那一侧改了规则，这一侧的红灯要在同一个地方亮。
 * 后面几条钉的是「用 `new URL` 抄近路就会漂掉」的那几处。
 */
import { describe, expect, it } from "vitest";

import { normalizeUrl } from "./normalize-url";

describe("normalizeUrl", () => {
  it("去 fragment、去追踪参数、scheme 与 host 小写、去末尾斜杠", () => {
    expect(normalizeUrl("HTTPS://A.com/x/?utm_source=w&id=3#frag")).toBe("https://a.com/x?id=3");
  });

  it("加不加 gclid 是同一个键", () => {
    expect(normalizeUrl("https://a.com/x?id=3")).toBe(normalizeUrl("https://a.com/x?id=3&gclid=z"));
  });

  it("空串进空串出", () => {
    expect(normalizeUrl("")).toBe("");
  });

  it("中文路径不做百分号编码 —— Python 那边留原样，`new URL` 会编码", () => {
    expect(normalizeUrl("https://a.com/新闻/1")).toBe("https://a.com/新闻/1");
  });

  it("显式默认端口留着 —— Python 的 netloc 里它还在", () => {
    expect(normalizeUrl("https://A.com:443/x")).toBe("https://a.com:443/x");
  });

  it("query 值按 quote_plus 重编码：空格是 +，`*` 也编码", () => {
    expect(normalizeUrl("https://a.com/x?q=a b*c")).toBe("https://a.com/x?q=a+b%2Ac");
  });

  it("空值参数留着（keep_blank_values），裸参数补成空值", () => {
    expect(normalizeUrl("https://a.com/x?a=&b")).toBe("https://a.com/x?a=&b=");
  });

  it("参数顺序不动 —— 排序会让两边算出不同的键", () => {
    expect(normalizeUrl("https://a.com/x?b=2&a=1")).toBe("https://a.com/x?b=2&a=1");
  });

  it("spm 那一族按前缀去掉", () => {
    expect(normalizeUrl("https://a.com/x?spm_id_from=333&id=1")).toBe("https://a.com/x?id=1");
  });

  it("没有 scheme 的也按同一条规则走（Python 解析成一条纯 path）", () => {
    expect(normalizeUrl("a.com/x?utm_source=w")).toBe("a.com/x");
  });

  it("坏的百分号转义替换成 U+FFFD，不抛 —— 一条畸形参数不该掀掉整轮扫描", () => {
    expect(normalizeUrl("https://a.com/x?q=%E4%B8")).toBe("https://a.com/x?q=%EF%BF%BD");
  });
});
