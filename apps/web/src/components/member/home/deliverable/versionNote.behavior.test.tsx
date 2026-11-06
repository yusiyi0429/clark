import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import type { TDeliverableVersion } from "@warmap/contracts";

/* 把版本说明当函数调用：hooks 用按调用顺序存值的小仓库代替（同 meetingBooking.behavior.test），按下「改一改」再调一次看表单。 */
const hooks = vi.hoisted(() => ({ values: [] as unknown[], index: 0,
  useState(initial: unknown) {
    const index = hooks.index++;
    if (!(index in hooks.values)) hooks.values[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
    return [hooks.values[index], (next: unknown) => {
      hooks.values[index] = typeof next === "function" ? (next as (value: unknown) => unknown)(hooks.values[index]) : next;
    }];
  },
}));
vi.mock("react", async (original) => ({ ...(await original<typeof import("react")>()), useState: hooks.useState, useEffect: () => undefined }));
vi.mock("@/components/buddy/useBuddy", () => ({ useBuddy: () => ({ buddy: null, loading: false }) }));

import { VersionNote } from "./VersionNote";

type Node = { type?: unknown; props?: Record<string, unknown> };
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object") return [];
  const node = value as Node;
  return node.props ? [node, ...nodes(node.props.children)] : [];
}
const text = (node: Node): string => {
  const children = node.props?.children;
  return (Array.isArray(children) ? children : [children]).map((child) => (typeof child === "string" ? child : child && typeof child === "object" ? text(child as Node) : "")).join("");
};

const version = {
  id: "11111111-1111-4111-8111-111111111111", number: 2, statement: null, createdAt: "2026-10-29T10:00:00.000Z", items: [],
  review: { status: "done", phase: null, startedAt: null, finishedAt: null, expectedSeconds: 120, basis: "acceptance", headline: null, summary: null, gain: null,
    mismatch: null, score: 100, met: 1, total: 1, ready: true, criteria: [], beyondScope: [], error: null },
  deliveredAt: "2026-10-29T10:10:00.000Z",
  note: { status: "done", achieved: "v2 达成了", gain: "补上题库评测", why: "口径定了", lesson: null, edited: false, dismissed: false },
} satisfies TDeliverableVersion;
const render = () => {
  hooks.index = 0;
  return nodes(VersionNote({ version, canEdit: true, onPatch: async () => null, onWithdraw: async () => null }) as ReactElement);
};

beforeEach(() => { hooks.values = []; });

describe("版本说明「改一改」", () => {
  it("四个框各有看得见的字段名：达成了什么、这一版多做到的、为什么变了、经验", () => {
    const edit = render().find((node) => node.type === "button" && text(node) === "改一改")!;
    (edit.props!.onClick as () => void)();
    const labels = render().filter((node) => node.type === "label");
    expect(labels.map((label) => nodes(label.props!.children).find((node) => node.type === "span") ?? null).map((span) => span && text(span)))
      .toEqual(["达成了什么", "这一版多做到的", "为什么变了", "经验"]);
    for (const label of labels) expect(nodes(label.props!.children).some((node) => node.type === "input" || node.type === "textarea")).toBe(true);
    expect(labels.map((label) => nodes(label.props!.children).find((node) => node.type === "input" || node.type === "textarea")!.props!.value))
      .toEqual(["v2 达成了", "补上题库评测", "口径定了", ""]);
  });
});
