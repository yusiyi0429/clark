"use client";

import { useEffect, useRef, useState } from "react";
import { TextArea } from "@heroui/react";
import { X } from "lucide-react";
import clsx from "clsx";
import { HeroButton } from "@/components/HeroButton";
import { ComposerPill, ComposerAction, ChannelSwitch, usePillRows } from "./ComposerPill";
import { columnComposerClass, pressChannel, type ConversationChannel } from "./ConversationColumn";
import { DictationControls } from "./DictationControls";
import { useDictation, withDictation } from "./useDictation";
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
  const dictation = useDictation();
  const placeholder = readOnly ? "你已不在这个群" : dictation.phase === "transcribing" ? "正在转成文字…" : dictation.active ? "正在听…" : inputState.placeholder;
  useEffect(() => { try { setInput(localStorage.getItem(draftKey) ?? ""); } catch {} }, [draftKey]);
  const update = (text: string) => { setInput(text); dictation.clearError(); try { if (text) localStorage.setItem(draftKey, text); else localStorage.removeItem(draftKey); } catch {} };
  useEffect(() => {
    if (!reference) return;
    const frame = requestAnimationFrame(() => field.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [reference?.nonce]);
  async function confirmDictation() {
    const text = await dictation.confirm();
    if (!text) return;
    const next = withDictation(input, text);
    update(next);
    requestAnimationFrame(() => { field.current?.focus({ preventScroll: true }); field.current?.setSelectionRange(next.length, next.length); });
  }
  async function submit() {
    if (!input.trim() || !writable || busy || dictation.active || submitting.current) return;
    submitting.current = true;
    try {
      // 留在输入框直到服务端接收；失败与断网保留原文及引用。
      if (await onSend(input.trim(), reference)) { update(""); onRemoveReference(); }
    } finally { submitting.current = false; }
  }
  return <div className={clsx(d.layer, columnComposerClass, s.composer)} data-testid="global-controls" data-conversation-context={taskId ? `task:${taskId}` : `mission-card:${cardId}`} data-detail-context="true" data-composer="pill" data-channel="group">
    <ComposerPill ref={pill} tone="group" onHeight={onHeightChange} onSubmit={() => { if (!composing.current) void submit(); }}
      references={error || dictation.error || reference ? <>
        {error ? <p role="alert" className={s.error}>{error}</p> : null}
        {dictation.error ? <p role="alert" className={ds.error}>{dictation.error}</p> : null}
        {reference ? <div className={s.reference}><span>引用 · v{reference.sourceVersion}　{reference.quote}</span><HeroButton variant="ghost" size="sm" isIconOnly type="button" aria-label="取消引用" onPress={onRemoveReference}><X size={14} /></HeroButton></div> : null}
      </> : undefined}
      leading={<ChannelSwitch channels={channels} channel={channel} onPress={(id) => pressChannel(id, { channel, onChannel, narrow, mobileOpen, onMobileOpen })} />}
      field={<TextArea ref={field} rows={rows} value={input} maxLength={4000} disabled={!writable || busy} readOnly={dictation.active} placeholder={placeholder} aria-label="事项群组输入" onChange={(event) => update(event.target.value)}
        onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || composing.current) { if (event.key === "Escape") event.stopPropagation(); return; }
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); event.currentTarget.blur(); return; }
          if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); }
        }} />}
      action={dictation.active
        ? <DictationControls dictation={dictation} onConfirm={() => void confirmDictation()} />
        : <ComposerAction state={input.trim() ? "send" : "mic"} isDisabled={!writable || busy} onMic={() => void dictation.start()} sendLabel={busy ? "正在发送" : "发送公开意见"} />} />
  </div>;
}
