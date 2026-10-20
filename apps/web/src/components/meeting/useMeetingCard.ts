"use client";

import { useEffect, useRef, useState } from "react";
import type { TMeetingCardDraft, TMeetingCardSection, TMeetingCardTargetOption, TMeetingCardView } from "@warmap/contracts";
import { confirmMeetingCard, getMeetingCard, retryMeetingCardSync, saveMeetingCardDraft } from "./meetingCardApi";
import {
  actionItemsAfterDelete, cardDiffers, draftFromConfirmed, draftReady, newSectionId, restoreBlank, syncPending, viewDiffers,
} from "./meetingCardModel";

const SAVE_DELAY = 800;
const NETWORK_RETRY = 3000;
const POLL_MS = 3000;

export type SaveState = "idle" | "saving" | "saved" | "failed";
export type ConfirmInput = { writeToWorld: boolean; kind?: "correction" | "followup"; reason?: string };
type SectionField = "heading" | "body";
/** 「+ 加一段」还没写全的那段：标题和正文都有了才进草稿（空段不拦住其他内容的保存）。 */
type PendingSection = Pick<TMeetingCardSection, "id" | "heading" | "body">;

/** 通知栏和左栏按会议记录状态刷新（确认、放弃修改、重试之后）。 */
const announce = () => window.dispatchEvent(new Event("meeting-changed"));

/**
 * 会议卡的一次编辑：本地草稿 + 停顿 800ms 自动保存（带当前 draftVersion，一次只发一个，存完换成返回的版本）；
 * 409 后停下自动保存，等用户「查看最新」重新读卡（本地没存的丢掉）。确认前先把没存的存掉；确认后同步有在等的项时每 3 秒重读一次。
 */
export function useMeetingCard(meetingId: string, initial: TMeetingCardView) {
  const [view, setView] = useState(initial);
  const [draft, setDraft] = useState(initial.draft);
  const [pending, setPending] = useState<PendingSection | null>(null);
  const [editing, setEditing] = useState(() => viewDiffers(initial));
  const [timeInFooter, setTimeInFooter] = useState(() => !initial.confirmed && !initial.draft?.occurredAt);
  const [conflict, setConflict] = useState(false);
  const [unsaved, setUnsaved] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const viewRef = useRef(initial);
  const draftRef = useRef(initial.draft);
  const versionRef = useRef(initial.draftVersion);
  const dirtyRef = useRef(false);
  const conflictRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savingRef = useRef<Promise<void> | null>(null);

  const showDraft = (next: TMeetingCardDraft | null) => { draftRef.current = next; setDraft(next); };
  const adopt = (next: TMeetingCardView, withDraft: boolean) => {
    viewRef.current = next;
    setView(next);
    if (!withDraft) return;
    versionRef.current = next.draftVersion;
    showDraft(next.draft);
  };
  const stopTimer = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
  };
  const markConflict = () => { stopTimer(); conflictRef.current = true; setConflict(true); };

  /** 存一次（串行）：没改过、409 之后、还有空着的必填项都不发；返回此刻的修改是否都已存下。 */
  const save = async (): Promise<boolean> => {
    while (savingRef.current) await savingRef.current;
    if (conflictRef.current) return false;
    if (!dirtyRef.current) return true;
    const sent = draftRef.current;
    if (!sent || !draftReady(sent)) return false;
    dirtyRef.current = false;
    let finish!: () => void;
    savingRef.current = new Promise<void>((resolve) => { finish = resolve; });
    setSaveState("saving");
    try {
      const result = await saveMeetingCardDraft(meetingId, versionRef.current, sent, actionItemsAfterDelete(sent, viewRef.current.actionItems));
      if (result.ok) {
        versionRef.current = result.view.draftVersion;
        viewRef.current = result.view;
        setView(result.view);
        // 存的时候用户又改了：留着本地的，等下一次存（原内容、版本、stale 每次存都由服务端重算）。
        if (!dirtyRef.current) { showDraft(result.view.draft); setUnsaved(false); }
        setSaveState("saved");
        setError(null);
        return !dirtyRef.current;
      }
      dirtyRef.current = true;
      if (result.code === "DRAFT_CHANGED") { markConflict(); setSaveState("idle"); return false; }
      setSaveState("failed");
      setError(result.message);
      if (result.status === 0) schedule(NETWORK_RETRY);
      return false;
    } finally {
      savingRef.current = null;
      finish();
    }
  };
  function schedule(delay: number) {
    stopTimer();
    timerRef.current = setTimeout(() => { timerRef.current = null; void save(); }, delay);
  }
  const flush = () => { stopTimer(); return save(); };

  /** 改了一处：文字停顿后存，选目标、移段、删段这类一下就完的马上存。 */
  const edit = (next: TMeetingCardDraft, now = false) => {
    showDraft(next);
    dirtyRef.current = true;
    setUnsaved(true);
    setSaveState((state) => (state === "saved" ? "idle" : state));
    if (conflictRef.current) return;
    if (now) void flush();
    else schedule(SAVE_DELAY);
  };
  const update = (change: (current: TMeetingCardDraft) => TMeetingCardDraft, now = false) => {
    if (draftRef.current) edit(change(draftRef.current), now);
  };
  /** 离开一个字段：清空了的必填项恢复，马上存。 */
  const leave = () => {
    const local = draftRef.current;
    if (!local) return;
    const fixed = restoreBlank(local, viewRef.current.draft);
    if (fixed !== local) showDraft(fixed);
    void flush();
  };

  const setSection = (id: string, field: SectionField, value: string) =>
    update((current) => ({ ...current, sections: current.sections.map((section) => (section.id === id ? { ...section, [field]: value } : section)) }));
  const moveSection = (id: string, delta: -1 | 1) => update((current) => {
    const from = current.sections.findIndex((section) => section.id === id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= current.sections.length) return current;
    const sections = [...current.sections];
    [sections[from], sections[to]] = [sections[to], sections[from]];
    return { ...current, sections };
  }, true);
  const deleteSection = (id: string) => update((current) => ({
    ...current,
    sections: current.sections.filter((section) => section.id !== id),
    objectChanges: current.objectChanges.map((change) => ({ ...change, basisSectionIds: change.basisSectionIds.filter((sectionId) => sectionId !== id) })),
  }), true);
  const addSection = () => {
    if (!pending && draftRef.current) setPending({ id: newSectionId(draftRef.current.sections), heading: "", body: "" });
  };
  const setPendingField = (field: SectionField, value: string) => {
    if (!pending) return;
    const next = { ...pending, [field]: value };
    if (!next.heading.trim() || !next.body.trim()) { setPending(next); return; }
    setPending(null);
    update((current) => ({ ...current, sections: [...current.sections, { ...next, sourceRefs: [] }] }));
  };
  const leavePending = () => { if (pending && !pending.heading.trim() && !pending.body.trim()) setPending(null); };
  const setAfter = (id: string, text: string) =>
    update((current) => ({ ...current, objectChanges: current.objectChanges.map((change) => (change.id === id ? { ...change, after: { text } } : change)) }));
  const setTarget = (id: string, option: TMeetingCardTargetOption) => update((current) => ({
    ...current,
    objectChanges: current.objectChanges.map((change) => (change.id === id
      ? { ...change, targetRef: option.targetRef, targetTitle: option.title, before: { text: option.text }, stale: false } : change)),
  }), true);

  /** 「查看最新」：重读卡，本地没存的丢掉，恢复自动保存。 */
  const reload = async () => {
    setBusy(true);
    const result = await getMeetingCard(meetingId);
    setBusy(false);
    if (!result.ok) { setError(result.message); return; }
    stopTimer();
    dirtyRef.current = false;
    conflictRef.current = false;
    setConflict(false);
    setUnsaved(false);
    setSaveState("idle");
    setError(null);
    setPending(null);
    adopt(result.view, true);
    setEditing((current) => viewDiffers(result.view) || (current && Boolean(result.view.confirmed)));
    setTimeInFooter(!result.view.confirmed && !result.view.draft?.occurredAt);
  };

  /** 整卡确认（第一次或「确认修改」）：先存掉没存的（含刚填的实际时间），再带最新的 draftVersion 确认。 */
  const confirm = async (input: ConfirmInput) => {
    setBusy(true);
    setError(null);
    try {
      if (!(await flush())) return;
      const reason = input.reason?.trim();
      const result = await confirmMeetingCard(meetingId, {
        draftVersion: versionRef.current, writeToWorld: input.writeToWorld, ...(input.kind ? { kind: input.kind } : {}), ...(reason ? { reason } : {}),
      });
      if (result.ok) {
        adopt(result.view, !dirtyRef.current);
        setEditing(false);
        setTimeInFooter(false);
        setSaveState("idle");
        announce();
      } else if (result.code === "DRAFT_CHANGED") markConflict();
      else setError(result.message);
    } finally {
      setBusy(false);
    }
  };

  /** 「放弃修改」：把草稿存回确认版的内容（本来就一样时不用存）。 */
  const discard = async () => {
    const confirmed = viewRef.current.confirmed;
    if (!confirmed || !draftRef.current) return;
    setPending(null);
    if (!dirtyRef.current && !cardDiffers(draftRef.current, confirmed.payload)) { setEditing(false); setSaveState("idle"); return; }
    setBusy(true);
    showDraft(draftFromConfirmed(draftRef.current, confirmed.payload));
    dirtyRef.current = true;
    setUnsaved(true);
    const saved = await flush();
    setBusy(false);
    if (!saved) return;
    setEditing(false);
    setSaveState("idle");
    announce();
  };

  const retry = async () => {
    setBusy(true);
    const result = await retryMeetingCardSync(meetingId);
    setBusy(false);
    if (!result.ok) { setError(result.message); return; }
    adopt(result.view, !dirtyRef.current && !conflictRef.current);
    setError(null);
    announce();
  };

  // 会议事件或对象修改还在等：每 3 秒重读一次；用户正在改的草稿不被盖掉。
  const waiting = syncPending(view.sync);
  useEffect(() => {
    if (!waiting) return;
    let live = true;
    const timer = setTimeout(() => void getMeetingCard(meetingId).then((result) => {
      if (!live) return;
      if (result.ok) adopt(result.view, !dirtyRef.current && !savingRef.current && !conflictRef.current);
      setTick((value) => value + 1);
    }), POLL_MS);
    return () => { live = false; clearTimeout(timer); };
  }, [meetingId, waiting, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  // 离开会议页时还有没存的：马上存。
  useEffect(() => () => { if (timerRef.current) void flush(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    view, draft, pending, editing, timeInFooter, conflict, unsaved, saveState, busy, error,
    edit: update, leave, setSection, moveSection, deleteSection, addSection, setPendingField, leavePending, setAfter, setTarget,
    startEditing: () => { setSaveState("idle"); setEditing(true); }, reload, confirm, discard, retry,
  };
}
