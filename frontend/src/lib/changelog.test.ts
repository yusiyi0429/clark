/**
 * 更新日志这份数据，没有任何一条坏法会报错。
 *
 * 版本号往下写不是往上写、日期写成 `2026/8/20`、`package.json` 只改了一头 ——
 * 这四样都编译得过、页面也照样渲染，只是屏幕上那份账开始说假话。所以钉在这儿。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { APP_VERSION, CHANGELOG } from "./changelog";

/** `v0.19.0` → `[0, 19, 0]`。不认的形状直接抛，别悄悄当成 0。 */
function parse(version: string): [number, number, number] {
  const m = /^v(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!m) throw new Error(`版本号不是 vX.Y.Z：${version}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** a 比 b 新就是正数。三段依次比，前一段分出胜负就不看后面。 */
function compare(a: string, b: string): number {
  const [x, y] = [parse(a), parse(b)];
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

describe("更新日志", () => {
  it("最新的在最前面", () => {
    for (let i = 1; i < CHANGELOG.length; i += 1) {
      const [newer, older] = [CHANGELOG[i - 1], CHANGELOG[i]];
      expect(
        compare(newer.version, older.version),
        `${newer.version} 排在 ${older.version} 前面，但版本号不比它大`,
      ).toBeGreaterThan(0);
    }
  });

  it("版本号不重复", () => {
    const seen = new Set(CHANGELOG.map((r) => r.version));
    expect(seen.size).toBe(CHANGELOG.length);
  });

  it("日期是 YYYY-MM-DD，且越往后越早", () => {
    for (const release of CHANGELOG) {
      expect(release.date, release.version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    for (let i = 1; i < CHANGELOG.length; i += 1) {
      // 同一天可以有好几版，所以是「不晚于」，不是「早于」。
      expect(
        CHANGELOG[i].date <= CHANGELOG[i - 1].date,
        `${CHANGELOG[i].version}（${CHANGELOG[i].date}）比它上面那版还晚`,
      ).toBe(true);
    }
  });

  it("每一版都说了改了什么", () => {
    for (const release of CHANGELOG) {
      expect(release.changes.length, release.version).toBeGreaterThan(0);
      for (const line of release.changes) {
        expect(line.trim(), release.version).not.toBe("");
      }
    }
  });

  it("package.json 的版本号跟最前面那条一样", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    // `v` 前缀只在屏幕上出现，package.json 里是裸的三段号。
    expect(`v${pkg.version}`).toBe(APP_VERSION);
  });
});
