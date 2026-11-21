import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 网页从 @warmap/contracts 只许引类型：引值会让 Next / Turbopack 打包 contracts 的源码，
 * 它的 `export * from "./x.js"` 解析不到 .ts，整个 /me/work 布局 500（vitest 和 tsc 都查不出）。
 * 要用 contracts 里的常量，在网页自己的 lib 里放一份。
 */
const SRC = join(__dirname, "..");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

const IMPORT = /import\s+(type\s+)?([^;]*?)\s+from\s+["']@warmap\/contracts["']/gs;

describe("@warmap/contracts 只引类型", () => {
  it("网页源码里每个 contracts 的 import 都只带类型", () => {
    const offenders: string[] = [];
    for (const file of sources(SRC)) {
      for (const match of readFileSync(file, "utf8").matchAll(IMPORT)) {
        if (match[1]) continue;
        const clause = match[2].trim();
        const named = clause.match(/^\{([\s\S]*)\}$/);
        const values = named
          ? named[1].split(",").map((s) => s.trim()).filter((s) => s && !s.startsWith("type "))
          : [clause];
        if (values.length) offenders.push(`${relative(SRC, file)}: ${values.join(", ")}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
