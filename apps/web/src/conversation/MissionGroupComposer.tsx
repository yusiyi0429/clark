"use client";

import { useEffect, useRef, useState } from "react";
import { TextArea } from "@heroui/react";
import { Mic, X } from "lucide-react";
import clsx from "clsx";
import { HeroButton } from "@/components/HeroButton";
import { ComposerPill, ComposerAction, ChannelSwitch, pillStyles, usePillRows } from "./ComposerPill";
import { columnComposerClass, pressChannel, type ConversationChannel } from "./ConversationColumn";
import { DictationControls } from "./DictationControls";
import { DictationMirror } from "./DictationMirror";
import { useDictation } from "./useDictation";
import { groupInputState, type MissionGroupPhase, type MissionGroupReference } from "./missionCardGroup";
import d from "@/styles/conversation-dock.module.css";
import s from "@/styles/mission-group.module.css";
import ds from "@/styles/dictation.module.css";

export function MissionGroupComposer({ cardId, viewerId, phase, channels, channel, onChannel, narrow, mobileOpen, onMobileOpen, onHeightChange, reference, onRemoveReference, busy, onSend, error, taskId, readOnly = false }: {
  cardId: string; viewerId?: string; phase: MissionGroupPhase; channels: ConversationChannel[]; channel: string; onChannel: (id: string) => void;
  narrow: boolean; mobileOpen: boolean; onMobileOpen: (open: boolean) => void; onHeightChange: (height: number) => void;
  reference: MissionGroupReference | null; onRemoveReference: () => void; busy: boolean;
  onSend: (body: string, reference: MissionGroupReference | null) => Promise<boolean>; error?: string | null;
  taskId?: string; readOnly?: boolean;
}) {
  const draftKey = taskId ? `tianshu-task-group-draft-v1:${viewerId}:${taskId}` : `tianshu-mission-group-draft-v1:${viewerId}:${cardId}`;
  const [input, setInput] = useState("");
  const pill = useRef<HTMLFormElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const submitting = useRef(false);
  const rows = usePillRows(input, pill, field);
  const inputState = groupInputState(phase);
  const writable = !readOnly && inputState.writable;
  const dictation = useDictation({ field, value: input, onValue: (text) => update(text) });
  const placeholder = readOnly ? "已退出该群组" : dictation.phase === "finishing" ? "正在收尾…" : dictation.active ? (dictation.live ? "正在听…" : "正在录音，结束后转写…") : inputState.placeholder;
  useEffect(() => { try { setInput(localStorage.getItem(draftKey) ?? ""); } catch {} }, [draftKey]);
  const update = (text: string) => { setInput(text); dictation.clearError(); try { if (text) localStorage.setItem(draftKey, text); else localStorage.removeItem(draftKey); } catch {} };
  useEffect(() => {
    if (!reference) return;
    const frame = requestAnimationFrame(() => field.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [reference?.nonce]);
  // ■：停下，文字留在输入框，整理在后台进行。
  async function confirmDictation() {
    await dictation.stop();
  }
  // ↑：等整理（最多 1.2 秒，超时发原文），整段直接发出；发不出去时留在输入框里。
  async function sendDictation() {
    const next = await dictation.finish();
    if (next === null) return;
    await submit(next);
  }
  async function submit(raw = input) {
    if (!raw.trim() || !writable || busy || submitting.current) return;
    submitting.current = true;
    try {
      // ■ 之后整理还没完就按了发送：等整理（最多 1.2 秒），发整理后的版本。
      const value = dictation.polishing ? await dictation.settle() : raw;
      if (!value.trim()) return;
      // 留在输入框直到服务端接收；失败与断网保留原文及引用。
      if (await onSend(value.trim(), reference)) { update(""); onRemoveReference(); }
    } finally { submitting.current = false; }
  }
  return <div className={clsx(d.layer, columnComposerClass, s.composer)} data-testid="global-controls" data-conversation-context={taskId ? `task:${taskId}` : `mission-card:${cardId}`} data-detail-context="true" data-composer="pill" data-channel="group">
    <ComposerPill ref={pill} tone="group" onHeight={onHeightChange} dictating={dictation.active} onSubmit={() => { if (composing.current) return; if (dictation.phase === "listening") void sendDictation(); else if (!dictation.active) void submit(); }}
      references={error || dictation.error || reference ? <>
        {error ? <p role="alert" className={s.error}>{error}</p> : null}
        {dictation.error ? <p role="alert" className={ds.error}>{dictation.error}</p> : null}
        {reference ? <div className={s.reference}><span>批注 · v{reference.sourceVersion}　{reference.quote}</span><HeroButton variant="ghost" size="sm" isIconOnly type="button" aria-label="取消批注" onPress={onRemoveReference}><X size={14} /></HeroButton></div> : null}
      </> : undefined}
      leading={<ChannelSwitch channels={channels} channel={channel} onPress={(id) => pressChannel(id, { channel, onChannel, narrow, mobileOpen, onMobileOpen })} />}
      field={<><DictationMirror field={field} value={input} marks={dictation.marks} polishing={dictation.polishing} fresh={dictation.fresh} />
      <TextArea ref={field} rows={rows} value={input} maxLength={4000} disabled={!writable || busy} placeholder={placeholder} aria-label="事项群组输入" onChange={(event) => { if (!dictation.change(event.target.value)) update(event.target.value); }}
        onCompositionStart={() => { composing.current = true; dictation.composition(true); }} onCompositionEnd={() => { composing.current = false; dictation.composition(false); }}
        onKeyDown={(event) => {
          if (dictation.keyDown(event)) return;
          if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || composing.current) { if (event.key === "Escape") event.stopPropagation(); return; }
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); event.currentTarget.blur(); return; }
          if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); }
        }} /></>}
      action={dictation.active
        ? <DictationControls dictation={dictation} onToInput={confirmDictation} onSend={sendDictation} canSend={!busy} />
        : <>
          <button type="button" className={pillStyles.tool} disabled={!writable || busy} onClick={() => void dictation.start()} aria-label="语音输入" title="语音输入"><Mic size={18} strokeWidth={1.8} aria-hidden /></button>
          <ComposerAction state="send" isDisabled={!writable || busy || !input.trim()} sendLabel={busy ? "正在发送" : "发送公开意见"} />
        </>} />
  </div>;
}
