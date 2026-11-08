"use client";

/**
 * 「我 › 伙伴」：点一个形象、一种性格就存；名字失焦或回车时存，不合法不存。没有保存按钮，存好不提示，看得到的变化就是反馈。
 * 没存成：那一项下面一行原因，选择退回原来那个。旧个人菜单的「伙伴形象」弹窗也用它。
 */

import { useRef, useState } from "react";
import { BuddyPicker, type BuddyField, type BuddyFieldError } from "./BuddyPicker";
import { buddyNameValid, initialBuddyDraft, saveBuddy, useBuddy, type Buddy } from "./useBuddy";

/**
 * 一次只发一个；发着时又改了，只记最后一次，前一个回来后接着发它。服务端最后存的和页面上停着的都是最后一次，先发的晚回来也盖不回去。
 * 存成的每次都报 saved（退回时以它为准）；被后来者顶掉的那次没成不报，最后一次没成才报 failed。
 */
export function liveBuddySaver(save: (next: Buddy) => Promise<Buddy>, on: { saved: (buddy: Buddy) => void; failed: (error: BuddyFieldError) => void }) {
  let sending = false;
  let queued: { next: Buddy; field: BuddyField } | null = null;
  const send = (next: Buddy, field: BuddyField) => {
    sending = true;
    void save(next)
      .then((saved): BuddyFieldError | null => { on.saved(saved); return null; }, (cause: unknown) => ({ field, reason: cause instanceof Error ? cause.message : "未保存，请重试。" }))
      .then((error) => {
        sending = false;
        if (queued) {
          const later = queued;
          queued = null;
          send(later.next, later.field);
        } else if (error) on.failed(error);
      });
  };
  return (next: Buddy, field: BuddyField) => {
    if (sending) queued = { next, field };
    else send(next, field);
  };
}

export function BuddySettings() {
  const { buddy, loading } = useBuddy();
  // chosen：点过以后页面上停着的那份；typed：名字框里还没存的字。都为空时跟着读到的伙伴。
  const [chosen, setChosen] = useState<Buddy | null>(null);
  const [typed, setTyped] = useState<string | null>(null);
  const [error, setError] = useState<BuddyFieldError | null>(null);
  const saved = useRef<Buddy | null>(null);
  const [push] = useState(() => liveBuddySaver(saveBuddy, {
    saved: (next) => { saved.current = next; },
    failed: (failure) => {
      setChosen(saved.current);
      if (failure.field === "name") setTyped(null);
      setError(failure);
    },
  }));
  const value = chosen ?? initialBuddyDraft(buddy);
  const change = (patch: Partial<Buddy>, field: BuddyField) => {
    if (loading) return;
    saved.current ??= value;
    const next = { ...value, ...patch };
    setChosen(next);
    setError(null);
    push(next, field);
  };
  const commitName = () => {
    if (typed === null) return;
    const name = typed.trim();
    if (!buddyNameValid(name)) return;
    setTyped(null);
    if (name !== value.name) change({ name }, "name");
  };
  return (
    <section aria-label="伙伴">
      <BuddyPicker value={value} name={typed ?? value.name} onName={setTyped} onCommitName={commitName}
        onPick={(patch) => change(patch, "form" in patch ? "form" : "personality")} error={error} disabled={loading} />
    </section>
  );
}
