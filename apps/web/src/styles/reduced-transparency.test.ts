import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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

describe("backdrop-filter declaration order", () => {
  // Lightning CSS (inside Turbopack) folds `backdrop-filter` and `-webkit-backdrop-filter` in one block into the
  // last declaration, prefix included. Standard-first compiles to the prefixed declaration alone, which Chromium
  // ignores: the blur disappears, and a reduced-transparency `none` no longer overrides a standard blur.
  it("keeps the standard declaration last in every CSS block", () => {
    const root = fileURLToPath(new URL("../", import.meta.url));
    const offenders = readdirSync(root, { recursive: true, encoding: "utf8" })
      .filter((file) => file.endsWith(".css"))
      .flatMap((file) => {
        const source = readFileSync(join(root, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
        return [...source.matchAll(/([^{}]*)\{([^{}]*)\}/g)].flatMap((block) => {
          const [, selector, body] = block;
          const properties = body.split(";").map((declaration) => declaration.split(":")[0].trim()).filter((property) => /^(-webkit-)?backdrop-filter$/.test(property));
          if (properties.length === 0 || properties.at(-1) === "backdrop-filter") return [];
          const line = source.slice(0, block.index + selector.length).split("\n").length;
          return [`${file.replaceAll("\\", "/")}:${line} ${selector.trim()}`];
        });
      });

    expect(offenders).toEqual([]);
  });
});
