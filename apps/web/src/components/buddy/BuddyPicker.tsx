"use client";

/** 伙伴形象（个人菜单）：上面改名字，中间选样子，下面选性格，保存交给外面。引导里起名字、选样子、选性格分成三页，共用这里的名字框和性格格子。 */

import type { RefObject } from "react";
import { CoAgentSkinPicker } from "@/components/coagent/SkinPicker";
import { PersonalityPicker } from "./PersonalityPicker";
import { clampBuddyName, type Buddy } from "./useBuddy";
import s from "@/styles/buddy-picker.module.css";

/** 伙伴名字框：超宽的打不进去；输入法还在组字时先原样放着，组完再截，免得截掉半个字。onEnter：回车（不在组字时）。 */
export function BuddyNameInput({ value, onChange, disabled = false, onEnter, inputRef, className, label }: {
  value: string;
  onChange: (name: string) => void;
  disabled?: boolean;
  onEnter?: () => void;
  inputRef?: RefObject<HTMLInputElement | null>;
  className?: string;
  /** 外面没有包 label 时给读屏的名字。 */
  label?: string;
}) {
  return (
    <input ref={inputRef} type="text" className={className} aria-label={label} value={value} disabled={disabled} autoComplete="off"
      onChange={(event) => {
        const name = event.target.value;
        onChange((event.nativeEvent as InputEvent).isComposing ? name : clampBuddyName(name));
      }}
      onCompositionEnd={(event) => onChange(clampBuddyName(event.currentTarget.value))}
      onKeyDown={onEnter ? (event) => {
        if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
        event.preventDefault();
        onEnter();
      } : undefined} />
  );
}

export function BuddyPicker({ value, onChange, disabled = false }: { value: Buddy; onChange: (next: Buddy) => void; disabled?: boolean }) {
  return (
    <div className={s.picker}>
      <label className={s.name}>
        名字
        <BuddyNameInput value={value.name} disabled={disabled} onChange={(name) => onChange({ ...value, name })} />
      </label>
      <CoAgentSkinPicker value={value.form} name={value.name} onChange={(form) => onChange({ ...value, form })} />
      <div className={s.name}>
        性格
        <PersonalityPicker value={value.personality ?? "steady"} disabled={disabled} onChange={(personality) => onChange({ ...value, personality })} />
      </div>
    </div>
  );
}
