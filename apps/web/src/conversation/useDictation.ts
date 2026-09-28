"use client";

/**
 * 输入框语音转文字（像 Claude 的听写）：点麦克风开始录 → 输入条显示「正在听…」和随音量跳动的一排点 →
 * ✕ 丢掉这段，✓ 传给服务端（POST /api/me/dictation，火山极速版）转成文字，交给输入框插进去、不自动发送。
 *
 * 麦克风只在点麦克风这一下请求；结束（✓ / ✕ / 离开页面）就立刻归还。录音不落库。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { components } from "@/lib/api/schema";
import { pickRecordingType } from "@/components/meeting/useMeetingRecorder";

type DictationResult = components["schemas"]["DictationResult"];

export type DictationPhase = "idle" | "starting" | "listening" | "transcribing";

/** 点阵有几颗：最近这么多个音量采样，从右往左推。 */
export const DICTATION_DOTS = 18;
/** 多久采一次音量（毫秒）：再快点阵会抖，再慢跟不上说话。 */
const SAMPLE_MS = 70;

type Capture = {
  media: MediaRecorder;
  stream: MediaStream;
  parts: Blob[];
  timer?: number;
  context?: AudioContext;
};

function release(capture: Capture) {
  if (capture.timer !== undefined) window.clearInterval(capture.timer);
  if (capture.context && capture.context.state !== "closed") void capture.context.close().catch(() => {});
  capture.stream.getTracks().forEach((track) => track.stop());
}

const silent = () => Array<number>(DICTATION_DOTS).fill(0);

/** onCancel：✕ 或 Esc 丢掉这段之后（首页输入条据此缩回原样）。 */
export function useDictation({ onCancel }: { onCancel?: () => void } = {}) {
  const [phase, setPhase] = useState<DictationPhase>("idle");
  const [levels, setLevels] = useState<number[]>(silent);
  const [error, setError] = useState<string | null>(null);
  const capture = useRef<Capture | null>(null);
  const attempt = useRef(0);
  const cancelled = useRef(onCancel);
  cancelled.current = onCancel;

  const discard = useCallback(() => {
    attempt.current += 1;
    const current = capture.current;
    capture.current = null;
    if (!current) return;
    current.media.ondataavailable = null;
    current.media.onstop = null;
    if (current.media.state !== "inactive") current.media.stop();
    release(current);
  }, []);

  useEffect(() => discard, [discard]);

  const start = useCallback(async () => {
    if (capture.current || phase !== "idle") return;
    setError(null);
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError("这个浏览器不能录音，请换 Chrome、Edge 或 Safari。");
      return;
    }
    const request = ++attempt.current;
    setPhase("starting");
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      if (request === attempt.current) {
        setPhase("idle");
        setError("麦克风没有授权，说不了话。可以在浏览器地址栏左边打开麦克风权限。");
      }
      return;
    }
    // 权限弹窗还开着时按了 ✕ 或离开了：迟到的授权也立即归还麦克风。
    if (request !== attempt.current) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    const type = pickRecordingType((candidate) => MediaRecorder.isTypeSupported(candidate));
    const media = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    const current: Capture = { media, stream, parts: [] };
    capture.current = current;
    media.ondataavailable = (event) => {
      if (event.data.size) current.parts.push(event.data);
    };
    media.start();
    setLevels(silent());
    setPhase("listening");

    // 音量和录音来自同一条流，不另开麦克风，也不把声音送到扬声器；取不到音量时点阵保持平的，录音照常。
    const AudioContextClass = window.AudioContext ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;
    try {
      const context = new AudioContextClass();
      current.context = context;
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      context.createMediaStreamSource(stream).connect(analyser);
      void context.resume().catch(() => {});
      const samples = new Uint8Array(analyser.fftSize);
      current.timer = window.setInterval(() => {
        analyser.getByteTimeDomainData(samples);
        let energy = 0;
        for (const sample of samples) energy += ((sample - 128) / 128) ** 2;
        const level = Math.min(1, Math.sqrt(energy / samples.length) * 5);
        setLevels((previous) => [...previous.slice(1), level]);
      }, SAMPLE_MS);
    } catch {
      /* 同上 */
    }
  }, [phase]);

  /** ✕：丢掉这段录音。 */
  const cancel = useCallback(() => {
    if (phase === "transcribing") return;
    discard();
    setLevels(silent());
    setPhase("idle");
    cancelled.current?.();
  }, [discard, phase]);

  /** ✓：停下、传上去转文字。返回转好的文字；没听清或失败时返回 null（原因在 error 里）。 */
  const confirm = useCallback(async (): Promise<string | null> => {
    const current = capture.current;
    if (!current || phase !== "listening") return null;
    const request = attempt.current;
    setPhase("transcribing");
    await new Promise<void>((resolve) => {
      current.media.onstop = () => resolve();
      current.media.stop();
    });
    capture.current = null;
    release(current);
    setLevels(silent());
    const clip = new Blob(current.parts, { type: current.media.mimeType || "audio/webm" });
    const form = new FormData();
    form.append("audio", clip, clip.type.includes("mp4") ? "dictation.m4a" : "dictation.webm");
    const response = await fetch("/api/me/dictation", { method: "POST", body: form }).catch(() => null);
    const body = (await response?.json().catch(() => ({}))) as Partial<DictationResult> & { message?: string };
    // 转写途中离开了页面：结果不再往回送。
    if (request !== attempt.current) return null;
    setPhase("idle");
    if (!response?.ok) {
      setError(body?.message ?? "没转成文字，请检查网络后再说一次。");
      return null;
    }
    const text = body.text?.trim() ?? "";
    if (!text) {
      setError("没听清，靠近麦克风再说一次试试。");
      return null;
    }
    return text;
  }, [phase]);

  // 正在听时按 Esc 就是 ✕；先于输入框和浮层自己的 Esc 处理（它们会收起输入框）。
  useEffect(() => {
    if (phase !== "listening" && phase !== "starting") return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      cancel();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [phase, cancel]);

  return {
    phase,
    /** 正在听或正在转：输入框只读，操作区换成点阵 + ✕ + ✓。 */
    active: phase !== "idle",
    levels,
    error,
    clearError: () => setError(null),
    start,
    cancel,
    confirm,
  };
}

export type Dictation = ReturnType<typeof useDictation>;

/** 转好的文字接在已有输入后面（中文不补空格）。 */
export function withDictation(input: string, text: string): string {
  return input ? `${input}${text}` : text;
}
