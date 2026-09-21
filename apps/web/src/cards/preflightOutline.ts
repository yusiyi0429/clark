import type { TMeetingPreflightEntry } from "@warmap/contracts";

export type PreflightGroup = { key: string; label: string; shortLabel: string; entries: TMeetingPreflightEntry[] };

/* 标题按 pen 页面_Meeting会前预审的 Section Title；另附目录短标签。 */
const SECTION_LABEL: [string, string, string][] = [
  ["core_judgment", "核心判断", "核心判断"],
  ["strategic_alignment", "战略一致性判断", "战略一致性判断"],
  ["positive_signal", "积极信号", "积极信号"],
  ["risk_calibration", "潜在风险 & 待校准问题", "潜在风险与待校准"],
  ["meeting_question", "建议会议重点追问的问题", "建议追问问题"],
  ["next_step", "下阶段推动建议", "下阶段推动建议"],
  ["leader_lens", "一号位追问", "一号位追问"],
];

/** 七段结果按固定顺序分组；核心判断单独作为 Hero，不进目录。旧 preflight 没有 taskDefinition，平铺为单组。 */
export function groupPreflight(entries: TMeetingPreflightEntry[], structured: boolean): PreflightGroup[] {
  if (!structured) return [{ key: "legacy", label: "预审条目", shortLabel: "预审条目", entries }];
  return SECTION_LABEL.filter(([kind]) => kind !== "core_judgment")
    .map(([kind, label, shortLabel]) => ({ key: kind, label, shortLabel, entries: entries.filter((entry) => entry.kind === kind) }))
    .filter((group) => group.entries.length > 0);
}

/** scroll-spy 取最后一个越过分界线的章节；都没有越过时停在核心判断。 */
export function pickActiveSection(sections: { key: string; top: number }[], boundary: number): string {
  let current = "core";
  for (const section of sections) if (section.top <= boundary) current = section.key;
  return current;
}
