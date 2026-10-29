"use client";

/** 选择你的伙伴：上面起名字，下面选一颗胶囊。引导第一步和个人菜单「伙伴形象」共用，保存交给外面。 */

import { CoAgentSkinPicker } from "@/components/coagent/SkinPicker";
import type { Buddy } from "./useBuddy";
import s from "@/styles/buddy-picker.module.css";

export function BuddyPicker({ value, onChange, disabled = false }: { value: Buddy; onChange: (next: Buddy) => void; disabled?: boolean }) {
  return (
    <div className={s.picker}>
      <label className={s.name}>
        名字
        <input type="text" value={value.name} maxLength={12} disabled={disabled} autoComplete="off"
          onChange={(event) => onChange({ ...value, name: event.target.value })} />
      </label>
      <CoAgentSkinPicker value={value.form} onChange={(form) => onChange({ ...value, form })} />
    </div>
  );
}
