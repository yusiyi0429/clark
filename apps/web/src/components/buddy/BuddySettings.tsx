"use client";

/** 个人菜单 › 设置 › 伙伴形象：改名字、换胶囊，保存后关掉弹窗。 */

import { useState, type FormEvent } from "react";
import { Button } from "ts-design/primitives";
import { BuddyPicker } from "./BuddyPicker";
import { buddyNameValid, initialBuddyDraft, saveBuddy, useBuddy, type Buddy } from "./useBuddy";
import m from "@/styles/account-menu.module.css";

export function BuddySettings({ onDone }: { onDone: () => void }) {
  const { buddy, loading } = useBuddy();
  const [draft, setDraft] = useState<Buddy | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const value = draft ?? initialBuddyDraft(buddy);
  const ready = !loading && !busy && buddyNameValid(value.name);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError("");
    try {
      await saveBuddy(value);
      onDone();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "未保存，请重试。");
      setBusy(false);
    }
  };
  return (
    <form className={m.form} onSubmit={(event) => void submit(event)} aria-label="伙伴">
      <BuddyPicker value={value} onChange={setDraft} disabled={loading || busy} />
      {error ? <p role="alert" className={m.error}>{error}</p> : null}
      <div className={m.formActions}><Button type="submit" className={m.primary} isDisabled={!ready}>{busy ? "保存中…" : "保存"}</Button></div>
    </form>
  );
}
