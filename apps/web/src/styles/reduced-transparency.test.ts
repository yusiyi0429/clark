import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("onboarding reduced-transparency CSS", () => {
  it.each([
    ["../components/onboarding/foundation.module.css", ".glass"],
    ["./access.module.css", ".codeCell, .passwordField"],
  ])("neutralizes both backdrop-filter variants in %s", (file, selector) => {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    const base = source.slice(source.indexOf(`${selector} {`)).match(/^[^{]+\{([^}]+)\}/)?.[1];
    const reduced = source.match(/@media\s*\(prefers-reduced-transparency:\s*reduce\)\s*\{([^}]+\})\s*\}/)?.[1];

    expect(base).toBeDefined();
    expect(reduced).toBeDefined();
    for (const property of ["-webkit-backdrop-filter", "backdrop-filter"]) {
      expect(base?.split(";").map((declaration) => declaration.trim())).toContain(`${property}: blur(var(--onboarding-blur)) saturate(var(--onboarding-sat))`);
    }
    expect(reduced).toContain(`${selector} {`);
    expect(reduced).toMatch(/--onboarding-blur:\s*0px\s*;/);
    expect(reduced).toMatch(/--onboarding-sat:\s*100%\s*;/);
    expect(reduced).toMatch(/background:\s*var\(--morning-start\)\s*;/);
    // Turbopack can deduplicate the two `none` declarations to the prefixed one.
    // Keep the fallback on the shared variables so Chromium's standard property changes too.
    expect(reduced).not.toMatch(/backdrop-filter\s*:/);
  });
});
