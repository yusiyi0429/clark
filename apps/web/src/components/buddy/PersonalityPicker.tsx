"use client";

/**
 * 选伙伴的性格：每种是名字，加一句它在「进度落后」这个场景里会说的话，不写说明。引导里左右切换着选（onboarding/BuddyCarousel），
 * 设置 › 伙伴形象里是四格。四种和示例是 11/08 调研后定的（新首页设计稿 17.3），要换只改下面这张表；
 * 每种三个场景的示例和说话规矩在 apps/api/src/buddyPersona.ts，这里的 sample 和那边的 behind 是同一句。
 */

import type { components } from "@/lib/api/schema";
import s from "@/styles/buddy-personality.module.css";

export type BuddyPersonality = components["schemas"]["BuddyPersonality"];

export const BUDDY_PERSONALITIES: { id: BuddyPersonality; label: string; sample: string }[] = [
  { id: "steady", label: "沉稳靠谱", sample: "全链路这条比计划晚两天。能先交的我拆出来了，周三前补齐，你看行不行。" },
  { id: "direct", label: "直言不讳", sample: "照现在的速度周五交不了。卡在没有真会议的读回，这条不解决，别的做完也不算数。" },
  { id: "warm", label: "温和体贴", sample: "这周会多、事也杂，晚两天不奇怪。剩下的我排好了，周一录完会就能追回来。" },
  { id: "coach", label: "启发追问", sample: "晚了两天。主要卡在排期，还是读回本身难做？说清楚了，再看哪块能挪。" },
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
