"use client";

/**
 * 选伙伴的性格（设计稿 .scratch/next-phase/设计_伙伴性格_2026-11-03.md 第 1、4 节）：四格两列，每格是性格的名字，
 * 加一句它在同一个场景里会说的话（交付物 v2 评完了，2 条里达到 1 条），不写说明。引导第三页和设置 › 伙伴形象共用。
 */

import type { components } from "@/lib/api/schema";
import s from "@/styles/buddy-personality.module.css";

export type BuddyPersonality = components["schemas"]["BuddyPersonality"];

export const BUDDY_PERSONALITIES: { id: BuddyPersonality; label: string; sample: string }[] = [
  { id: "steady", label: "沉稳靠谱", sample: "v2 评完了，还差「全链路」一条。周一录一次会就能补上。" },
  { id: "cheerful", label: "乐观开朗", sample: "飞书那条过了，挺不容易 👏 就差全链路一条，周一录个会就齐！" },
  { id: "calm", label: "理性冷静", sample: "v2：1/2。缺全链路读回记录，建议周一补录。" },
  { id: "critical", label: "较真犀利", sample: "还差最关键的一条：没有真实会议的读回，链路通不通说不清。" },
];

export function PersonalityPicker({ value, onChange, disabled = false }: { value: BuddyPersonality; onChange: (next: BuddyPersonality) => void; disabled?: boolean }) {
  return (
    <div className={s.options} role="radiogroup" aria-label="伙伴的性格">
      {BUDDY_PERSONALITIES.map((item) => (
        <label key={item.id} className={s.option} data-selected={value === item.id || undefined}>
          <input type="radio" name="buddy-personality" value={item.id} checked={value === item.id} disabled={disabled} onChange={() => onChange(item.id)} />
          <span className={s.label}>{item.label}</span>
          <span className={s.sample}>{item.sample}</span>
        </label>
      ))}
    </div>
  );
}
