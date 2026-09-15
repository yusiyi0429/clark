import { describe, expect, it } from "vitest";

import type { ContextBundle } from "./recipes";
import { contextExists, freezeContext, loadContext, stableStringify } from "./snapshot";

const bundle = (over: Partial<ContextBundle> = {}): ContextBundle => ({
  query: "GPU 供给还够不够撑到明年二季度",
  recipe: "S02",
  anchorCode: "ISS-D6",
  renderedMarkdown: "【公司经营状态】\n……",
  memberIds: ["ISS-D6", "JDG-01"],
  calls: [{ point: "P1", path: "/api/v1/entities/ISS-D6", view: "latest" }],
  warnings: [],
  viewer: "PSN-01",
  asOf: "2026-08-18",
  sourceBaseUrl: "https://example.test/graph",
  ...over,
});

describe("stableStringify", () => {
  it("键序不影响结果 —— 否则同一份上下文会算出两个 id", () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
  });

  it("数组次序**是**内容，不排序", () => {
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]));
  });
});

describe("freezeContext", () => {
  it("id 是内容哈希：同样的上下文冻出同一个 id", () => {
    const a = freezeContext(bundle());
    const b = freezeContext(bundle());
    expect(a).toBe(b);
    expect(a).toMatch(/^ctx-[0-9a-f]{16}$/);
  });

  it("正文变一个字就是另一份快照", () => {
    expect(freezeContext(bundle())).not.toBe(
      freezeContext(bundle({ renderedMarkdown: "【公司经营状态】\n…" }))
    );
  });

  it("冻结之后读回来一模一样 —— 后续步骤只读快照，不再访问图谱", () => {
    const id = freezeContext(bundle());
    expect(contextExists(id)).toBe(true);
    expect(loadContext(id)).toEqual(bundle());
  });

  it("不存在的快照要报出 id，不能返回一个空 bundle", () => {
    expect(() => loadContext("ctx-0000000000000000")).toThrow(/ctx-0000000000000000/);
  });
});
