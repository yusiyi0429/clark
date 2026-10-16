import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 全站输入框 / 文本框 / 下拉的统一样式（用户 2026-10-12：以对话输入条为准——不用虚线框，聚焦不用粗蓝色双层框）。
 * 共享样式在 globals.css 的 --field-* 变量与 @layer base 末尾的基础样式；这里守三件事：
 * 输入类规则里不能再出现 dashed、聚焦不能再叠 ≥2px 的 outline 或 0 0 0 Npx 的色块阴影、globals.css 那套变量与手持 16 号字还在。
 */
const SRC = fileURLToPath(new URL("..", import.meta.url));

/** 不在扫描范围的目录 / 文件：这些页面已恢复为 MVP 版本，沿用 MVP 自己的输入框样式，不受这套统一样式约束。 */
const EXCLUDED_DIRS: string[] = [
  "components/missionCards/",
  "components/tasks/",
  "styles/monthly-workspace.module.css",
  "styles/access.module.css",
];

function cssFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) cssFiles(path, out);
    else if (name.endsWith(".css")) out.push(path);
  }
  return out;
}

type Rule = { file: string; selector: string; body: string };

/** 简单切块：去掉注释，按 `{` `}` 切；只要叶子规则（体内没有再嵌套），@media / @container 等头跳过、里面的规则照样收。 */
function parseRules(file: string, source: string): Rule[] {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: Rule[] = [];
  const stack: { head: string; bodyStart: number }[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === "{") {
      stack.push({ head: text.slice(start, i).trim(), bodyStart: i + 1 });
      start = i + 1;
    } else if (char === "}") {
      const open = stack.pop();
      if (open) {
        const body = text.slice(open.bodyStart, i);
        if (!body.includes("{") && !open.head.startsWith("@")) rules.push({ file, selector: open.head, body: body.trim() });
      }
      start = i + 1;
    } else if (char === ";" && stack.length === 0) {
      start = i + 1;
    }
  }
  return rules;
}

const allFiles = cssFiles(SRC)
  .map((path) => ({ path, rel: relative(SRC, path).replace(/\\/g, "/") }))
  .filter(({ rel }) => !EXCLUDED_DIRS.some((dir) => rel.startsWith(dir)));
const allRules = allFiles.flatMap(({ path, rel }) => parseRules(rel, readFileSync(path, "utf8")));

/**
 * 输入类选择器：标签 textarea / input / select，[contenteditable]，或类名以 field / input / editor / note / textarea / select 收尾
 * （.passwordField、.titleInput、.editor、.note 算；.noteApply、.notesToggle、.battlefield 不算——按钮和卡片不是输入框）。
 */
const INPUT_WORDS = /(?:^|[\s>+~(])(?:textarea|input|select)(?![\w-])|contenteditable|\.[\w-]*?(?:field|input|editor|note|textarea|select)(?![\w-])/i;
/** 勾选 / 单选 / 滑块等非文字输入、按钮，和只是借了 input 字样的选择器（:has(input:focus-visible) 画在外层卡片上的选中环）不在此列。 */
const NOT_TEXT = /checkbox|radio|range|file|:checked|:has\(\s*input|\.consent\b|button|summary/i;

function inputSelectors(selector: string): string[] {
  return selector
    .split(",")
    .map((part) => part.trim())
    .filter((part) => INPUT_WORDS.test(part) && !NOT_TEXT.test(part));
}

const inputRules = allRules.filter((rule) => inputSelectors(rule.selector).length > 0);

describe("统一输入框样式：扫描范围", () => {
  it("扫得到全站的 css（含 globals.css 与组件的 CSS Modules），也扫得到输入类规则", () => {
    expect(allFiles.length).toBeGreaterThan(50);
    expect(allFiles.some(({ rel }) => rel === "app/globals.css")).toBe(true);
    expect(inputRules.length).toBeGreaterThan(40);
    // 对话输入条（标准）也在被扫描之列，它的无边框文字框不会误报。
    expect(inputRules.some((rule) => rule.file === "styles/composer-pill.module.css")).toBe(true);
    expect(inputRules.some((rule) => rule.file === "styles/conversation-dock.module.css")).toBe(true);
  });
});

describe("统一输入框样式：没有虚线框", () => {
  it("输入类选择器的规则体里没有 dashed", () => {
    const hits = inputRules.filter((rule) => /dashed/i.test(rule.body)).map((rule) => `${rule.file}: ${rule.selector}`);
    expect(hits).toEqual([]);
  });
});

describe("统一输入框样式：聚焦只换边色，不叠粗框", () => {
  const focusRules = inputRules.filter((rule) => inputSelectors(rule.selector).some((part) => /:focus/.test(part)));

  it("有聚焦规则可查", () => {
    expect(focusRules.length).toBeGreaterThan(0);
  });

  it("聚焦规则里没有 ≥2px 的 outline", () => {
    const hits = focusRules
      .filter((rule) => {
        const outlines = [...rule.body.matchAll(/outline(?:-width)?\s*:\s*([^;]+)/gi)].map((match) => match[1]);
        return outlines.some((value) => [...value.matchAll(/(\d+(?:\.\d+)?)px/g)].some((width) => Number(width[1]) >= 2));
      })
      .map((rule) => `${rule.file}: ${rule.selector}`);
    expect(hits).toEqual([]);
  });

  it("聚焦规则里没有 0 0 0 Npx（N≥2）的色块阴影；要用光晕只能是 var(--field-focus-ring)", () => {
    const hits = focusRules
      .filter((rule) => [...rule.body.matchAll(/0(?:px)?\s+0(?:px)?\s+0(?:px)?\s+(\d+(?:\.\d+)?)px/g)].some((match) => Number(match[1]) >= 2))
      .map((rule) => `${rule.file}: ${rule.selector}`);
    expect(hits).toEqual([]);
  });
});

describe("统一输入框样式：文本域不留手动拉高的手柄", () => {
  it("textarea 规则里没有 resize: vertical / both", () => {
    const hits = allRules
      .filter((rule) => /textarea|editor|\.note\b/i.test(rule.selector) && /resize\s*:\s*(vertical|both|horizontal)/i.test(rule.body))
      .map((rule) => `${rule.file}: ${rule.selector}`);
    expect(hits).toEqual([]);
  });
});

describe("统一输入框样式：globals.css 里的共享变量与基础样式", () => {
  const globals = readFileSync(join(SRC, "app/globals.css"), "utf8");

  it("定义了 --field-* 变量", () => {
    for (const name of [
      "--field-bg", "--field-ink", "--field-placeholder", "--field-border", "--field-border-hover", "--field-border-focus",
      "--field-focus-ring", "--field-radius", "--field-radius-line", "--field-pad-y", "--field-pad-x", "--field-font", "--field-line", "--field-caret",
    ]) {
      expect(globals).toMatch(new RegExp(`${name}:\\s*[^;]+;`));
    }
  });

  it("默认浅灰细边、聚焦 1px 黑灰（不用蓝）", () => {
    expect(globals).toMatch(/--field-border:\s*#dfe5ee;/);
    expect(globals).toMatch(/--field-border-focus:\s*#3a3a40;/);
    expect(globals).toMatch(/--field-focus-ring:\s*0 0 0 3px rgb\(58 58 64 \/ 7%\);/);
  });

  it("手持与触屏字号 16（iOS 小于 16 聚焦会放大整页），ts-design 的 [data-ts-theme] 里同样", () => {
    const coarse = globals.match(/@media \(max-width: 959px\), \(pointer: coarse\) \{\s*:root(?:, :root \[data-ts-theme\])? \{ --field-font: 16px;[^}]*\}/);
    expect(coarse).not.toBeNull();
    expect(coarse?.[0]).toContain(":root [data-ts-theme]");
    expect(globals).toMatch(/--field-font:\s*14px;/);
  });

  it("变量块同时挂在 :root [data-ts-theme] 下：ts-design 的 [data-ts-theme] 会把同名的 HeroUI 字段变量重新赋值（边 transparent），必须压回来", () => {
    expect(globals).toMatch(/:root,\s*:root \[data-ts-theme\] \{\s*--field-bg:/);
  });

  it("基础样式：文字 input / textarea / select 1px 细边、圆角取变量、聚焦只换边色、不叠 outline、textarea 不可拖拉", () => {
    const base = globals.slice(globals.indexOf("文字输入的基础样式"));
    expect(base).toMatch(/border:\s*1px solid var\(--field-border\);/);
    expect(base).toMatch(/border-radius:\s*var\(--field-radius-line\);/);
    expect(base).toMatch(/:where\(textarea\) \{ border-radius: var\(--field-radius\); resize: none; \}/);
    expect(base).toMatch(/padding:\s*var\(--field-pad-y\) var\(--field-pad-x\);/);
    expect(base).toMatch(/font-size:\s*var\(--field-font\);/);
    expect(base).toMatch(/line-height:\s*var\(--field-line\);/);
    expect(base).toMatch(/border-color:\s*var\(--field-border-hover\);/);
    expect(base).toMatch(/border-color:\s*var\(--field-border-focus\);/);
    expect(base).toMatch(/textarea, select\):where\(:focus-visible\) \{\s*outline: none;/);
    // 不分层、零特指度：压过 Tailwind / HeroUI 预检（同在 base 层时 HeroUI 那份后加载，会把 textarea 改回可拖拉、圆角 0）。
    const layer = globals.slice(globals.indexOf("@layer base {"), globals.indexOf("文字输入的基础样式"));
    expect(layer).not.toMatch(/--field-border\)/);
  });

  it("HeroUI / ts-design 的文本框（Input、TextArea、Select 触发器）也对齐：单行圆角取变量、去掉 2px 聚焦圈", () => {
    expect(globals).toMatch(/:where\(input\[data-slot="input"\], \[data-slot="select-trigger"\]\) \{\s*border-radius: var\(--field-radius-line\);/);
    expect(globals).toMatch(/\[data-focus-visible="true"\]\) \{\s*border-color: var\(--field-border-focus\);\s*outline: none;\s*box-shadow: none;/);
  });
});

describe("统一输入框样式：heroui-tianshu.css 不再覆盖同名变量", () => {
  const tianshu = readFileSync(join(SRC, "app/heroui-tianshu.css"), "utf8");
  it("--field-border / -hover / -focus / -placeholder / -radius 只在 globals.css 里赋值", () => {
    for (const name of ["--field-border", "--field-border-hover", "--field-border-focus", "--field-placeholder", "--field-radius"]) {
      expect(tianshu).not.toMatch(new RegExp(`${name}:`));
    }
  });
});
