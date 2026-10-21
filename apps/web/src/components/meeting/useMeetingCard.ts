"use client";

import { useEffect, useRef, useState } from "react";
import type { TMeetingActionItem, TMeetingCardDraft, TMeetingCardSection, TMeetingCardTargetOption, TMeetingCardView } from "@warmap/contracts";
import { confirmMeetingCard, getMeetingCard, retryMeetingCardSync, saveMeetingCardDraft, type CardResult } from "./meetingCardApi";
import {
  cardDiffers, draftFromConfirmed, draftReady, itemsDiffer, itemsWithoutSection, newItemId, newSectionId, restoreBlank, restoreBlankItems,
  syncPending,
} from "./meetingCardModel";

const SAVE_DELAY = 800;
const NETWORK_RETRY = 3000;
const POLL_MS = 3000;
/** 同步一直在等（本体长时间连不上）时轮询的上限；之后等用户下一次操作或重新打开会议页再接着问。 */
const POLL_LIMIT_MS = 10 * 60_000;

/** 自动保存的状态（卡顶右侧的小字）：保存中、已保存、保存失败、网络不通。 */
export type SaveState = "idle" | "saving" | "saved" | "failed" | "offline";
/** 确认、重试、重读出错时的标签（不显示服务端原话）。 */
export type ActionError = "确认失败" | "重试失败" | "本体暂不可用" | "网络不通";
export type ConfirmInput = { writeToWorld: boolean; kind?: "correction" | "followup"; reason?: string };
type SectionField = "heading" | "body";
type ItemField = "text" | "ownerPersonId" | "dueDate";
/** 「+ 加一段」还没写全的那段：标题和正文都有了才进草稿（空段不拦住其他内容的保存）；touched 是离开过一次。 */
type PendingSection = Pick<TMeetingCardSection, "id" | "heading" | "body"> & { touched: boolean };

/** 通知栏、左栏和页头按会议记录状态刷新（确认、放弃修改、重试之后，存草稿后差别变了，同步写完了）。 */
const announce = () => window.dispatchEvent(new Event("meeting-changed"));
const actionError = (result: { status: number; code: string }, fallback: ActionError): ActionError =>
  result.status === 0 ? "网络不通" : result.status === 503 || result.code === "WORLD_UNAVAILABLE" ? "本体暂不可用" : fallback;

/** 会议卡卸载时最后一次保存（每场会一份，还在路上的）：读卡和新挂上的会议卡先等它，不拿旧的草稿版本和它抢。 */
const leaving = new Map<string, Promise<TMeetingCardView | null>>();
export async function readMeetingCard(meetingId: string): Promise<CardResult> {
  await leaving.get(meetingId);
  return getMeetingCard(meetingId);
}

/**
 * 会议卡的一次编辑：本地草稿和行动项 + 停顿 800ms 自动保存（带当前 draftVersion，一次只发一个，存完换成返回的版本；行动项改过才交整份 actionItems）；
 * 409 后停下自动保存，等用户「查看最新」重新读卡（本地没存的丢掉）。确认前先把没存的存掉，确认、放弃修改进行中不能改；
 * 确认后同步有在等的项时每 3 秒重读一次（最多 10 分钟）。onView 收到每一份服务端的最新视图（会议页记着，会议卡重新挂上时从最新的接着显示）。
 */
export function useMeetingCard(meetingId: string, initial: TMeetingCardView, onView?: (view: TMeetingCardView) => void) {
  const [view, setView] = useState(initial);
  const [draft, setDraft] = useState(initial.draft);
  const [items, setItems] = useState(initial.actionItems);
  /** 离开过一次的行动项（还空着事项就标红）。 */
  const [leftItems, setLeftItems] = useState<string[]>([]);
  const [pending, setPending] = useState<PendingSection | null>(null);
  const [editing, setEditing] = useState(() => initial.draftChange !== "none");
  const [timeInFooter, setTimeInFooter] = useState(() => !initial.confirmed && !initial.draft?.occurredAt);
  const [timeRejected, setTimeRejected] = useState(false);
  const [focus, setFocus] = useState<"title" | "confirmed" | null>(null);
  const [conflict, setConflict] = useState(false);
  const [unsaved, setUnsaved] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ActionError | null>(null);
  const [tick, setTick] = useState(0);
  /** 轮询到这一刻为止（打开、确认、重试、重读时重新算）。 */
  const [pollUntil, setPollUntil] = useState(() => Date.now() + POLL_LIMIT_MS);
  const viewRef = useRef(initial);
  const draftRef = useRef(initial.draft);
  const itemsRef = useRef(initial.actionItems);
  /** 行动项改过、还没存：存的时候交整份 actionItems（没改过不交，服务端沿用已存的）。 */
  const itemsDirtyRef = useRef(false);
  const versionRef = useRef(initial.draftVersion);
  const dirtyRef = useRef(false);
  const conflictRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savingRef = useRef<Promise<void> | null>(null);
  const aliveRef = useRef(true);
  const onViewRef = useRef(onView);
  onViewRef.current = onView;

  const remember = (next: TMeetingCardView) => { viewRef.current = next; onViewRef.current?.(next); };
  const showDraft = (next: TMeetingCardDraft | null) => { draftRef.current = next; setDraft(next); };
  const showItems = (next: TMeetingActionItem[]) => { itemsRef.current = next; setItems(next); };
  const adopt = (next: TMeetingCardView, withDraft: boolean) => {
    remember(next);
    setView(next);
    if (!withDraft) return;
    versionRef.current = next.draftVersion;
    showDraft(next.draft);
    showItems(next.actionItems);
  };
  const stopTimer = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
  };

  /**
   * 存一次（串行）：没改过、409 之后、还有空着的必填项都不发；返回此刻的修改是否都已存下。卸载后只存不改界面、不再排重试。
   * 行动项改过才交：还没写事项的新一条不交（不拦住别的内容），清空了事项的交上次存下的文字；存完不换成返回的（存草稿不改 taskId），本地的空行留着。
   */
  const save = async (): Promise<boolean> => {
    while (savingRef.current) await savingRef.current;
    if (conflictRef.current) return false;
    if (!dirtyRef.current) return true;
    const sent = draftRef.current;
    const sentItems = itemsDirtyRef.current ? restoreBlankItems(itemsRef.current, viewRef.current.actionItems, true) : undefined;
    if (!sent || !draftReady(sent)) return false;
    dirtyRef.current = false;
    itemsDirtyRef.current = false;
    let finish!: () => void;
    savingRef.current = new Promise<void>((resolve) => { finish = resolve; });
    if (aliveRef.current) setSaveState("saving");
    try {
      const result = await saveMeetingCardDraft(meetingId, versionRef.current, sent, sentItems);
      if (result.ok) {
        const changed = result.view.draftChange !== viewRef.current.draftChange;
        versionRef.current = result.view.draftVersion;
        remember(result.view);
        if (changed) announce();
        if (aliveRef.current) {
          setView(result.view);
          // 存的时候用户又改了：留着本地的，等下一次存（原内容、版本、stale 每次存都由服务端重算）。
          if (!dirtyRef.current) { showDraft(result.view.draft); setUnsaved(false); }
          setSaveState(dirtyRef.current ? "idle" : "saved");
        }
        return !dirtyRef.current;
      }
      dirtyRef.current = true;
      if (sentItems) itemsDirtyRef.current = true;
      if (result.code === "DRAFT_CHANGED") {
        conflictRef.current = true;
        if (aliveRef.current) { stopTimer(); setConflict(true); setSaveState("idle"); }
        return false;
      }
      if (aliveRef.current) {
        setSaveState(result.status === 0 ? "offline" : "failed");
        if (result.status === 0) schedule(NETWORK_RETRY);
      }
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

  /** 改了一处：文字停顿后存，选目标、移段、删除、改时间、选负责人这类一下就完的马上存。 */
  const touch = (now: boolean) => {
    dirtyRef.current = true;
    setUnsaved(true);
    setSaveState((state) => (state === "saved" ? "idle" : state));
    if (conflictRef.current) return;
    if (now) void flush();
    else schedule(SAVE_DELAY);
  };
  const edit = (next: TMeetingCardDraft, now = false) => { showDraft(next); touch(now); };
  const editItems = (next: TMeetingActionItem[], now = false) => { showItems(next); itemsDirtyRef.current = true; touch(now); };
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

  const setOccurredAt = (occurredAt: string | null) => {
    setTimeRejected(false);
    update((current) => ({ ...current, occurredAt }), true);
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
  /** 删一段：引它为依据的修改和行动项去掉那段（行动项改了才交）。 */
  const deleteSection = (id: string) => {
    const items = itemsWithoutSection(itemsRef.current, id);
    if (items !== itemsRef.current) { showItems(items); itemsDirtyRef.current = true; }
    update((current) => ({
      ...current,
      sections: current.sections.filter((section) => section.id !== id),
      objectChanges: current.objectChanges.map((change) => ({ ...change, basisSectionIds: change.basisSectionIds.filter((sectionId) => sectionId !== id) })),
    }), true);
  };
  const addSection = () => {
    if (!pending && draftRef.current) setPending({ id: newSectionId(draftRef.current.sections), heading: "", body: "", touched: false });
  };
  const setPendingField = (field: SectionField, value: string) => {
    if (!pending) return;
    const next = { ...pending, [field]: value };
    if (!next.heading.trim() || !next.body.trim()) { setPending(next); return; }
    setPending(null);
    update((current) => ({ ...current, sections: [...current.sections, { id: next.id, heading: next.heading, body: next.body, sourceRefs: [] }] }));
  };
  /** 离开新加的那段：两项都空就去掉；写了一半的留着，空着的那项标红。 */
  const leavePending = () => {
    if (!pending) return;
    if (!pending.heading.trim() && !pending.body.trim()) setPending(null);
    else setPending({ ...pending, touched: true });
  };
  const setAfter = (id: string, text: string) =>
    update((current) => ({ ...current, objectChanges: current.objectChanges.map((change) => (change.id === id ? { ...change, after: { text } } : change)) }));
  const setTarget = (id: string, option: TMeetingCardTargetOption) => update((current) => ({
    ...current,
    objectChanges: current.objectChanges.map((change) => (change.id === id
      ? { ...change, targetRef: option.targetRef, targetTitle: option.title, before: { text: option.text }, stale: false } : change)),
  }), true);
  const deleteChange = (id: string) => update((current) => ({ ...current, objectChanges: current.objectChanges.filter((change) => change.id !== id) }), true);

  /** 「+ 加一条」：本地先加一条空的，写了事项才存（空的不拦住别的内容保存）。 */
  const addItem = () => showItems([...itemsRef.current, { id: newItemId(itemsRef.current), text: "", ownerPersonId: null, dueDate: null, basisSectionIds: [], taskId: null }]);
  const setItem = (id: string, field: ItemField, value: string | null) =>
    editItems(itemsRef.current.map((item) => (item.id === id ? { ...item, [field]: value } : item)), field !== "text");
  const deleteItem = (id: string) => editItems(itemsRef.current.filter((item) => item.id !== id), true);
  /** 离开一条行动项：清空了的事项恢复，没写过的新一条留着、之后标红（删掉走「⋯ 删除」），马上存。 */
  const leaveItem = (id: string) => {
    const fixed = restoreBlankItems(itemsRef.current, viewRef.current.actionItems);
    if (fixed !== itemsRef.current) showItems(fixed);
    setLeftItems((ids) => (ids.includes(id) ? ids : [...ids, id]));
    void flush();
  };

  /** 「查看最新」：重读卡，本地没存的丢掉，恢复自动保存。 */
  const reload = async () => {
    setBusy(true);
    const result = await readMeetingCard(meetingId);
    if (!aliveRef.current) return;
    setBusy(false);
    if (!result.ok) { setError(actionError(result, "网络不通")); return; }
    stopTimer();
    dirtyRef.current = false;
    itemsDirtyRef.current = false;
    conflictRef.current = false;
    setConflict(false);
    setUnsaved(false);
    setSaveState("idle");
    setError(null);
    setTimeRejected(false);
    setPending(null);
    adopt(result.view, true);
    setPollUntil(Date.now() + POLL_LIMIT_MS);
    setEditing((current) => result.view.draftChange !== "none" || (current && Boolean(result.view.confirmed)));
    setTimeInFooter(!result.view.confirmed && !result.view.draft?.occurredAt);
  };

  /**
   * 整卡确认（第一次或「确认修改」）：先存掉没存的（含刚填的实际时间），再带最新的 draftVersion 确认；进行中不能改。
   * 修改原因按存完后服务端给的 draftChange：content 才带（还没选就先不发，等界面出现原因再选）；只改了行动项或没改不带。
   */
  const confirm = async (input: ConfirmInput) => {
    setBusy(true);
    setError(null);
    try {
      if (!(await flush())) return;
      const content = viewRef.current.confirmed !== null && viewRef.current.draftChange === "content";
      if (content && !input.kind) return;
      const reason = content ? input.reason?.trim() : undefined;
      const result = await confirmMeetingCard(meetingId, {
        draftVersion: versionRef.current, writeToWorld: input.writeToWorld, ...(content && input.kind ? { kind: input.kind } : {}), ...(reason ? { reason } : {}),
      });
      if (!aliveRef.current) return;
      if (result.ok) {
        adopt(result.view, true);
        setEditing(false);
        setTimeInFooter(false);
        setSaveState("idle");
        setFocus("confirmed");
        setPollUntil(Date.now() + POLL_LIMIT_MS);
        announce();
      } else if (result.code === "DRAFT_CHANGED") {
        conflictRef.current = true;
        stopTimer();
        setConflict(true);
      } else if (result.code === "OCCURRED_AT_REQUIRED") setTimeRejected(true);
      else setError(actionError(result, "确认失败"));
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  };

  /** 「放弃修改」：把草稿存回确认版的内容（本来就一样时不用存）；进行中不能改。 */
  const discard = async () => {
    const confirmed = viewRef.current.confirmed;
    if (!confirmed || !draftRef.current) return;
    setPending(null);
    setFocus(null);
    const itemsChanged = itemsDiffer(itemsRef.current, confirmed.actionItems);
    if (!dirtyRef.current && !itemsChanged && !cardDiffers(draftRef.current, confirmed.payload)) { setEditing(false); setSaveState("idle"); return; }
    setBusy(true);
    showDraft(draftFromConfirmed(draftRef.current, confirmed.payload));
    if (itemsChanged) { showItems(confirmed.actionItems); itemsDirtyRef.current = true; }
    dirtyRef.current = true;
    setUnsaved(true);
    const saved = await flush();
    if (!aliveRef.current) return;
    setBusy(false);
    if (!saved) return;
    setEditing(false);
    setSaveState("idle");
    announce();
  };

  /** 重试会议事件写入；服务端说没有要重试的（别处已经重试过）就重读一次。 */
  const retry = async () => {
    setBusy(true);
    const first = await retryMeetingCardSync(meetingId);
    const result = first.ok || first.code !== "NOTHING_TO_RETRY" ? first : await getMeetingCard(meetingId);
    if (!aliveRef.current) return;
    setBusy(false);
    if (!result.ok) { setError(actionError(result, "重试失败")); return; }
    adopt(result.view, !dirtyRef.current && !conflictRef.current);
    setError(null);
    setPollUntil(Date.now() + POLL_LIMIT_MS);
    announce();
  };

  // 会议事件或对象修改还在等：每 3 秒重读一次，最多问到 pollUntil；用户正在改的草稿不被盖掉。写完了（不再等）通知页头和通知栏。
  const waiting = syncPending(view.sync);
  useEffect(() => {
    if (!waiting || Date.now() > pollUntil) return;
    let live = true;
    const timer = setTimeout(() => void getMeetingCard(meetingId).then((result) => {
      if (!live) return;
      if (result.ok) {
        adopt(result.view, !dirtyRef.current && !savingRef.current && !conflictRef.current);
        if (!syncPending(result.view.sync)) announce();
      }
      setTick((value) => value + 1);
    }), POLL_MS);
    return () => { live = false; clearTimeout(timer); };
  }, [meetingId, waiting, tick, pollUntil]); // eslint-disable-line react-hooks/exhaustive-deps

  // 挂上时：上一个会议卡卸载前的最后一次保存还在路上，先不能改，等它回来用它的结果。
  // 卸载时：清空了的必填项先恢复，还有没存的（或正在存的）就存最后一次；不再改界面、不排重试，新挂上的会议卡和读卡等它。
  useEffect(() => {
    aliveRef.current = true;
    const last = leaving.get(meetingId);
    if (last) {
      setBusy(true);
      void last.then((latest) => {
        if (!aliveRef.current) return;
        if (latest) adopt(latest, true);
        setBusy(false);
      });
    }
    return () => {
      aliveRef.current = false;
      stopTimer();
      if (!dirtyRef.current && !savingRef.current) return;
      if (draftRef.current) draftRef.current = restoreBlank(draftRef.current, viewRef.current.draft);
      const final = save().then((saved) => (saved ? viewRef.current : null));
      leaving.set(meetingId, final);
      void final.finally(() => { if (leaving.get(meetingId) === final) leaving.delete(meetingId); });
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    view, draft, items, leftItems, pending, editing, timeInFooter, timeRejected, focus, conflict, unsaved, saveState, busy, error,
    edit: update, leave, setOccurredAt, setSection, moveSection, deleteSection, addSection, setPendingField, leavePending, setAfter, setTarget, deleteChange,
    addItem, setItem, deleteItem, leaveItem,
    startEditing: () => { setSaveState("idle"); setFocus("title"); setEditing(true); }, reload, confirm, discard, retry,
  };
}
