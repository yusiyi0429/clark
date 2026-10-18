"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { browserApi } from "@/lib/api/client";
import type { components } from "@/lib/api/schema";
import { pickRecordingType } from "@/components/meeting/useMeetingRecorder";

export const VOICEPRINT_SCRIPT =
  "我是天枢的成员。开会时，我会把判断、依据和下一步说清楚：这件事为什么现在做，需要谁来配合，什么时候给出结果。会上定下来的事情，我会放进执行事项里跟进，并及时同步进展。遇到拿不准的地方，我会先说清楚还缺什么信息，再约相关的同事一起对齐。";
export const VOICEPRINT_CONSENT = "我同意天枢保存我的声纹特征，只用于在公司会议录音里认出我的发言；我可以随时删除。";
export const MIN_SECONDS = 15;
export const MAX_SECONDS = 30;

export type VoiceprintStatus = components["schemas"]["VoiceprintStatus"];
type Phase = "idle" | "recording" | "recorded" | "saving";
type Capture = {
  media: MediaRecorder;
  stream: MediaStream;
  began: number;
  timer?: number;
  frame?: number;
  context?: AudioContext;
  source?: MediaStreamAudioSourceNode;
  analyser?: AnalyserNode;
};

function release(capture: Capture) {
  if (capture.timer !== undefined) window.clearInterval(capture.timer);
  if (capture.frame !== undefined) window.cancelAnimationFrame(capture.frame);
  capture.source?.disconnect();
  capture.analyser?.disconnect();
  if (capture.context && capture.context.state !== "closed") void capture.context.close().catch(() => {});
  capture.stream.getTracks().forEach((track) => track.stop());
}

export function useVoiceprintEnrollment({
  initialStatus,
}: { initialStatus?: VoiceprintStatus } = {}) {
  const [status, setStatus] = useState<VoiceprintStatus | null>(initialStatus ?? null);
  const [consent, setConsent] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [seconds, setSeconds] = useState(0);
  const [level, setLevel] = useState(0);
  const [starting, setStarting] = useState(false);
  const [clip, setClip] = useState<Blob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const capture = useRef<Capture | null>(null);
  const hasInitialStatus = useRef(initialStatus !== undefined);
  const mounted = useRef(true);
  const attempt = useRef(0);
  const requesting = useRef(false);
  const saving = useRef(false);

  const load = useCallback(async () => {
    try {
      const { data } = await browserApi.GET("/api/me/voiceprint");
      if (mounted.current && data) setStatus(data);
    } catch {
      if (mounted.current) setError("声纹状态没能读到，请稍后重试。");
    }
  }, []);

  const discardCapture = useCallback(() => {
    attempt.current += 1;
    requesting.current = false;
    const current = capture.current;
    capture.current = null;
    if (!current) return;
    current.media.ondataavailable = null;
    current.media.onstop = null;
    current.media.onerror = null;
    if (current.media.state !== "inactive") current.media.stop();
    release(current);
  }, []);

  useEffect(() => {
    mounted.current = true;
    if (!hasInitialStatus.current) void load();
    return () => {
      mounted.current = false;
      discardCapture();
    };
  }, [load, discardCapture]);

  const cancel = useCallback(() => {
    discardCapture();
    // 已提交的保存继续接收真实结果；失败时仍可回来重试这段录音。
    if (saving.current) return;
    setStarting(false);
    setLevel(0);
    setSeconds(0);
    setClip(null);
    setPhase("idle");
  }, [discardCapture]);

  const stop = useCallback(() => {
    const current = capture.current;
    if (!current || current.media.state !== "recording") return;
    if (current.timer !== undefined) window.clearInterval(current.timer);
    setSeconds(Math.min(MAX_SECONDS, Math.floor((Date.now() - current.began) / 1000)));
    current.media.stop();
  }, []);

  const start = async () => {
    if (!consent || status?.configured === false || requesting.current || capture.current || saving.current) return;
    setError(null);
    setNote(null);
    setClip(null);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError("这个浏览器不能录音，请换 Chrome 或 Edge。");
      return;
    }
    const request = ++attempt.current;
    requesting.current = true;
    setStarting(true);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      if (mounted.current && request === attempt.current) {
        requesting.current = false;
        setStarting(false);
        setError("麦克风没有授权，录不了声纹。");
      }
      return;
    }
    // 用户可能在权限弹窗还开着时跳过；迟到的授权也必须立即归还麦克风。
    if (!mounted.current || request !== attempt.current) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    requesting.current = false;
    setStarting(false);
    try {
      const type = pickRecordingType((candidate) => MediaRecorder.isTypeSupported(candidate));
      const media = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
      const current: Capture = { media, stream, began: Date.now() };
      capture.current = current;
      const parts: Blob[] = [];
      media.ondataavailable = (event) => {
        if (event.data.size) parts.push(event.data);
      };
      media.onstop = () => {
        if (capture.current !== current) return;
        capture.current = null;
        release(current);
        setLevel(0);
        setClip(new Blob(parts, { type: media.mimeType || "audio/webm" }));
        setPhase("recorded");
      };
      media.onerror = () => {
        discardCapture();
        setLevel(0);
        setPhase("idle");
        setError("录音中断了，请重新录制。");
      };
      media.start();
      setSeconds(0);
      setPhase("recording");
      current.timer = window.setInterval(() => {
        const elapsed = Math.min(MAX_SECONDS, Math.floor((Date.now() - current.began) / 1000));
        setSeconds(elapsed);
        if (elapsed >= MAX_SECONDS) stop();
      }, 250);

      // 音量和上传音频来自同一条流，不另开麦克风，也不把声音送到扬声器。
      const AudioContextClass = window.AudioContext ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (AudioContextClass) {
        try {
          const context = new AudioContextClass();
          current.context = context;
          const source = context.createMediaStreamSource(stream);
          current.source = source;
          const analyser = context.createAnalyser();
          current.analyser = analyser;
          analyser.fftSize = 256;
          source.connect(analyser);
          void context.resume().catch(() => {});
          const samples = new Uint8Array(analyser.fftSize);
          const measure = () => {
            if (capture.current !== current) return;
            analyser.getByteTimeDomainData(samples);
            let energy = 0;
            for (const sample of samples) energy += ((sample - 128) / 128) ** 2;
            setLevel(Math.min(1, Math.sqrt(energy / samples.length) * 4));
            current.frame = window.requestAnimationFrame(measure);
          };
          measure();
        } catch {
          // 音量可视化不可用时仍保留可用的录音，计时和按钮照常工作。
          setLevel(0);
        }
      }
    } catch {
      if (capture.current) discardCapture();
      else stream.getTracks().forEach((track) => track.stop());
      setPhase("idle");
      setError("录音没有开始，请重试。");
    }
  };

  const save = async (): Promise<VoiceprintStatus | null> => {
    if (!clip || seconds < MIN_SECONDS || saving.current) return null;
    saving.current = true;
    setPhase("saving");
    setError(null);
    const form = new FormData();
    form.append("audio", clip, clip.type.includes("mp4") ? "voiceprint.m4a" : "voiceprint.webm");
    form.append("consent", "true");
    const response = await fetch("/api/me/voiceprint", { method: "POST", body: form }).catch(() => null);
    const body = (await response?.json().catch(() => ({}))) as (VoiceprintStatus & { message?: string }) | undefined;
    saving.current = false;
    if (!mounted.current) return null;
    if (!response?.ok || !body?.enrolled) {
      setPhase("recorded");
      setError(body?.message ?? "没录上，请重试。");
      return null;
    }
    setStatus(body);
    setClip(null);
    setPhase("idle");
    setNote("已录好");
    return body;
  };

  const remove = async () => {
    setError(null);
    const result = await browserApi.DELETE("/api/me/voiceprint").catch(() => null);
    if (!mounted.current) return;
    if (!result?.response.ok) return setError("没删掉，请重试。");
    setNote("已删除");
    void load();
  };

  return {
    status, consent, setConsent, phase, seconds, level, starting,
    recording: phase === "recording",
    canStop: phase === "recording" && seconds >= MIN_SECONDS,
    tooShort: phase === "recorded" && seconds < MIN_SECONDS,
    error, note, start, stop, save, remove, cancel,
  };
}
