"use client";

/** 伙伴形象（「我 › 伙伴」）：上面改名字，中间选样子，下面选性格；什么时候存交给外面，没存成的那一项下面一行写原因。引导里起名字、选样子、选性格分成三页，共用这里的名字框和性格格子。 */

import { useState, type RefObject } from "react";
import { CoAgentSkinPicker } from "@/components/coagent/SkinPicker";
import { PersonalityPicker } from "./PersonalityPicker";
import { clampBuddyName, type Buddy } from "./useBuddy";
import s from "@/styles/buddy-picker.module.css";

/**
 * 伙伴名字框：超宽的打不进去；输入法还在组字时先原样放着，组完再截，免得截掉半个字。onEnter：回车（不在组字时）；onBlur：失焦。
 * 真有字被截掉时，框下面写一句「名字已到最长」，删掉一个字或再打得进去时消失。
 */
export function BuddyNameInput({ value, onChange, disabled = false, onEnter, onBlur, inputRef, className, label }: {
  value: string;
  onChange: (name: string) => void;
  disabled?: boolean;
  onEnter?: () => void;
  onBlur?: () => void;
  inputRef?: RefObject<HTMLInputElement | null>;
  className?: string;
  /** 外面没有包 label 时给读屏的名字。 */
  label?: string;
}) {
  const [full, setFull] = useState(false);
  const clamp = (name: string) => {
    const kept = clampBuddyName(name);
    setFull(kept !== name);
    onChange(kept);
  };
  return <>
    <input ref={inputRef} type="text" className={className} aria-label={label} value={value} disabled={disabled} autoComplete="off"
      onChange={(event) => {
        const name = event.target.value;
        if ((event.nativeEvent as InputEvent).isComposing) onChange(name);
        else clamp(name);
      }}
      onCompositionEnd={(event) => clamp(event.currentTarget.value)}
      onBlur={onBlur}
      onKeyDown={onEnter ? (event) => {
        if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
        event.preventDefault();
        onEnter();
      } : undefined} />
    {full ? <span className={s.limit} role="status">名字已到最长</span> : null}
  </>;
}

export type BuddyField = "name" | "form" | "personality";
export type BuddyFieldError = { field: BuddyField; reason: string };

export function BuddyPicker({ value, name, onName, onCommitName, onPick, error = null, disabled = false }: {
  /** 选定的那份（存着的，或正在存的）。 */
  value: Buddy;
  /** 名字框里正在打的字；失焦或回车时 onCommitName。 */
  name: string;
  onName: (name: string) => void;
  onCommitName: () => void;
  onPick: (patch: Pick<Buddy, "form"> | Pick<Buddy, "personality">) => void;
  error?: BuddyFieldError | null;
  disabled?: boolean;
}) {
  const failed = (field: BuddyField) => (error?.field === field ? <span className={s.error} role="alert">{error.reason}</span> : null);
  return (
    <div className={s.picker}>
      <label className={s.name}>
        名字
        <BuddyNameInput value={name} disabled={disabled} onChange={onName} onEnter={onCommitName} onBlur={onCommitName} />
        {failed("name")}
      </label>
      <div className={s.field}>
        <CoAgentSkinPicker value={value.form} name={name} onChange={(form) => onPick({ form })} />
        {failed("form")}
      </div>
      <div className={s.name}>
        性格
        <PersonalityPicker value={value.personality ?? "steady"} disabled={disabled} onChange={(personality) => onPick({ personality })} />
        {failed("personality")}
      </div>
    </div>
  );
}
