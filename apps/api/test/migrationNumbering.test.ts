import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// migrate.ts 以文件名前的编号作 schema_migrations 主键：同号的第二个文件在已执行过该号的库上会被静默跳过。
// 合仓前与 Inception 约定分段（2026-10-21）：099 及以下照旧；100–199 是 Inception 的段（inc 线上已执行到 117）；
// 天枢 MVP 的新迁移从 200 起。
const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const files = readdirSync(MIGRATIONS_DIR).filter((file) => file.endsWith(".sql")).sort();
const numberOf = (file: string) => Number(file.split("_")[0]);

describe("migration numbering", () => {
  it("never reuses a number", () => {
    const seen = new Map<number, string>();
    const duplicates = files.flatMap((file) => {
      const previous = seen.get(numberOf(file));
      seen.set(numberOf(file), file);
      return previous ? [`${previous} / ${file}`] : [];
    });
    expect(duplicates).toEqual([]);
  });

  it("leaves 100–199 to Inception", () => {
    const inInceptionRange = files.filter((file) => numberOf(file) >= 100 && numberOf(file) < 200);
    expect(inInceptionRange, "100–199 是 Inception 的迁移段，天枢 MVP 新迁移请从 200 起编号").toEqual([]);
  });
});
