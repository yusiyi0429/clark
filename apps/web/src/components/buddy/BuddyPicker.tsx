"use client";

/** 选择你的伙伴：上面起名字，下面选一颗胶囊。引导第一步和个人菜单「伙伴形象」共用，保存交给外面。 */

import { CoAgentSkinPicker } from "@/components/coagent/SkinPicker";
import { clampBuddyName, type Buddy } from "./useBuddy";
import s from "@/styles/buddy-picker.module.css";

export function BuddyPicker({ value, onChange, disabled = false }: { value: Buddy; onChange: (next: Buddy) => void; disabled?: boolean }) {
  return (
    <div className={s.picker}>
      <label className={s.name}>
        名字
        {/* 超宽的打不进去；输入法还在组字时先原样放着，组完再截，免得截掉半个字。 */}
        <input type="text" value={value.name} disabled={disabled} autoComplete="off"
          onChange={(event) => {
            const name = event.target.value;
            onChange({ ...value, name: (event.nativeEvent as InputEvent).isComposing ? name : clampBuddyName(name) });
          }}
          onCompositionEnd={(event) => onChange({ ...value, name: clampBuddyName(event.currentTarget.value) })} />
      </label>
      <CoAgentSkinPicker value={value.form} name={value.name} onChange={(form) => onChange({ ...value, form })} />
    </div>
  );
}
