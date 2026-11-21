import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

describe("新首页一种字号（本人 11/18 改 15px）", () => {
  it("新首页统一字号是 15px", () => {
    expect(read("./home-type.css")).toContain("font-size: var(--type-size, 15px) !important;");
    // 原来就小一号的两处跟着往下调同样的差值：「项目」13 → 12，计划清单（和「在做什么」那一行）15 → 14。
    expect(read("../styles/home.module.css")).toContain("--type-size: 12px; --type-lh: 16px; }");
    const session = read("../styles/v2-session.module.css");
    expect(session).toContain(".plan { --type-size: 14px; --type-lh: 22px; }");
    expect(session).toContain(".activity { --type-size: 14px; --type-lh: 22px; }");
  });
});
