import { describe, expect, it } from "vitest";
import type { TMeetingPreflightEntry } from "@warmap/contracts";
import { groupPreflight, pickActiveSection } from "./preflightOutline";

function entry(id: string, kind: string): TMeetingPreflightEntry {
  return { id, kind, title: `${kind} 标题`, body: "正文", sourceRefs: [`memory:${id}`] } as TMeetingPreflightEntry;
}

describe("Meeting 评审目录", () => {
  it("把七段结果按固定顺序分组，并把核心判断排除在目录外", () => {
    const groups = groupPreflight(
      [
        entry("a", "risk_calibration"),
        entry("b", "core_judgment"),
        entry("c", "strategic_alignment"),
        entry("d", "meeting_question"),
        entry("e", "meeting_question"),
      ],
      true,
    );
    expect(groups.map((group) => group.key)).toEqual([
      "strategic_alignment",
      "risk_calibration",
      "meeting_question",
    ]);
    expect(groups.every((group) => group.key !== "core_judgment")).toBe(true);
    expect(groups.find((group) => group.key === "meeting_question")?.entries).toHaveLength(2);
  });

  it("丢弃没有条目的章节，避免渲染空目录项", () => {
    const groups = groupPreflight([entry("a", "next_step")], true);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ key: "next_step", label: "下阶段推动建议" });
  });

  it("旧 preflight 没有 taskDefinition 时平铺为单组", () => {
    const groups = groupPreflight([entry("a", "core_judgment"), entry("b", "unknown_kind")], false);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ key: "legacy", label: "预审条目" });
    expect(groups[0].entries).toHaveLength(2);
  });

  it("scroll-spy 取最后一个越过分界线的章节，都没有越过时停在核心判断", () => {
    const sections = [
      { key: "core", top: -300 },
      { key: "strategic_alignment", top: -120 },
      { key: "positive_signal", top: 40 },
    ];
    expect(pickActiveSection(sections, 0)).toBe("strategic_alignment");
    expect(pickActiveSection(sections, -400)).toBe("core");
    expect(pickActiveSection([], 0)).toBe("core");
  });
});
