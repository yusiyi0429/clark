"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Listener, type ListenerState } from "@/lib/stage/listener";
import { Speaker } from "@/lib/stage/speaker";

type VoiceOptions = {
  onCommit: (text: string) => void;
  onCaption: (text: string) => void;
};

/** Real microphone input and streamed speech, isolated from company data. */
export function usePrototypeVoice(options: VoiceOptions) {
  const callbacks = useRef(options);
  const listener = useRef<Listener | null>(null);
  const speaker = useRef<Speaker | null>(null);
  const mutedRef = useRef(false);
  const [muted, setMuted] = useState(false);
  const [state, setState] = useState<ListenerState>("off");
  const [speaking, setSpeaking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { callbacks.current = options; }, [options]);
  // Announce a new failure once; do not let an old caption hide the reason.
  useEffect(() => { if (error) callbacks.current.onCaption(error); }, [error]);

  useEffect(() => {
    let mounted = true;
    const playback = new Speaker({
      onCaption: (text) => { if (mounted) callbacks.current.onCaption(text); },
      onSpeaking: (on) => {
        if (!mounted) return;
        setSpeaking(on);
        input.agentSpeaking(on);
      },
      onError: (message) => {
        if (!mounted) return;
        playback.stop();
        mutedRef.current = true;
        setMuted(true);
        setError(/Arrearage|good standing|欠费|余额不足/i.test(message)
          ? "语音播报账户暂不可用，已切换为文字。"
          : "语音播报暂不可用，已切换为文字；麦克风识别仍可继续。");
      },
    });
    const input = new Listener({
      onHeard: (text) => { if (mounted) callbacks.current.onCaption(text); },
      onCommit: (text) => {
        if (!mounted) return;
        playback.stop();
        callbacks.current.onCommit(text);
      },
      onBargeIn: () => { playback.stop(); },
      onState: (next) => { if (mounted) setState(next); },
      onError: (message) => {
        if (mounted) setError(/Arrearage|good standing|欠费|余额不足/i.test(message)
          ? "语音识别账户暂不可用，请用键盘继续。"
          : /权限|NotAllowed|SecurityError/.test(message)
            ? "麦克风权限未开启，请允许访问，或用键盘继续。"
            : "语音识别连接中断，请用键盘继续，或重新开启语音。");
      },
    }, `warmap-${crypto.randomUUID()}`);
    listener.current = input;
    speaker.current = playback;
    return () => {
      mounted = false;
      input.stop();
      playback.dispose();
      listener.current = null;
      speaker.current = null;
    };
  }, []);

  const stop = useCallback(() => {
    speaker.current?.stop();
    listener.current?.stop();
  }, []);

  const interrupt = useCallback(() => {
    speaker.current?.stop();
  }, []);

  const toggle = useCallback(async () => {
    const input = listener.current;
    if (!input) return;
    if (input.current === "starting") return;
    if (input.current !== "off" && input.current !== "failed") {
      stop();
      return;
    }
    setError(null);
    try {
      // Unlock while the click gesture is still available, before waiting for ASR.
      if (!mutedRef.current) void speaker.current?.unlock();
      await input.start();
    } catch {
      input.stop();
      setError("无法开启语音，请允许麦克风访问，或使用键盘继续。");
    }
  }, [stop]);

  const toggleMuted = useCallback(() => {
    const next = !mutedRef.current;
    mutedRef.current = next;
    setMuted(next);
    if (next) speaker.current?.stop();
    else void speaker.current?.unlock();
    // This is output mute; the microphone stays live.
  }, []);

  const speak = useCallback((text: string) => {
    const clean = text.trim();
    if (!clean) return;
    callbacks.current.onCaption(clean);
    const inputState = listener.current?.current;
    if (mutedRef.current || (inputState !== "listening" && inputState !== "muted")) return;
    speaker.current?.speak({ text: clean });
  }, []);

  const active = state === "listening" || state === "muted";
  const status = state === "starting" ? "正在连接"
    : state === "failed" ? "语音未连接"
    : !active ? "开始对话"
    : speaking ? "正在回答"
    : muted ? "聆听中 · 静音" : "聆听中";

  return { active, muted, status, error, toggle, toggleMuted, speak, stop, interrupt };
}
