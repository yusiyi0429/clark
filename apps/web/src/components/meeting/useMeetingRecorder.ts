"use client";

/**
 * 会议录音（浏览器端）：按下「开始会议」时请求麦克风并开始录，每 10 秒切一片按序号传上去；「这场会开完了」时停下、
 * 把最后一片传完，再通知服务端「录完了」—— 服务端接着转码、上传对象存储、送火山引擎识别，识别完生成一份会议记录候选
 * （和妙记导入同一条确认路径）。
 *
 * 麦克风只在按下「开始会议」这一下请求（用户动作）；不给权限照样开会计时，只是没有录音。离开会议页时如果还在录，
 * 就地停下并把已经录到的传完、交给服务端转写，不丢已录的部分。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { announceLevel, announceListening } from "@/components/coagent/presence";

export type RecorderStatus = "idle" | "starting" | "recording" | "stopping" | "finished" | "denied" | "unsupported" | "failed";

export interface RecorderState {
  status: RecorderStatus;
  /** 失败时给人看的一句话。 */
  error?: string;
  /** 服务端这份录音的 id（录上以后才有，结束后留着，好查转写走到哪一步）。 */
  recordingId?: string;
}

/** 每一片多长：够短，断网丢一片也只丢几秒；够长，一小时的会不到 400 次请求。 */
const SLICE_MS = 10_000;

/** 选浏览器支持的格式：Chrome / Edge 录 webm(opus)，Safari 录 mp4。服务端都过一遍 ffmpeg。 */
export function pickRecordingType(isSupported: (type: string) => boolean): string | undefined {
  return ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((type) => isSupported(type));
}

export function useMeetingRecorder(meetingId: string) {
  const [state, setState] = useState<RecorderState>({ status: "idle" });
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const recordingId = useRef<string | null>(null);
  const seq = useRef(0);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const failed = useRef<string | null>(null);
  const meter = useRef<{ context: AudioContext; timer: number } | null>(null);
  const base = `/api/meetings/${encodeURIComponent(meetingId)}/recordings`;

  // 一片一片按顺序传：前一片没传完不传下一片；失败重试一次，再失败记下来，结束时告诉人。
  const upload = useCallback(
    (blob: Blob) => {
      const id = recordingId.current;
      if (!id || !blob.size) return;
      const n = seq.current++;
      queue.current = queue.current.then(async () => {
        const send = () =>
          fetch(`${base}/${encodeURIComponent(id)}/chunks/${n}`, { method: "PUT", headers: { "content-type": blob.type || "audio/webm" }, body: blob });
        let response = await send().catch(() => null);
        if (!response?.ok) response = await send().catch(() => null);
        if (!response?.ok) failed.current = "部分录音片段上传失败，转写内容可能不完整。";
      });
    },
    [base],
  );

  const releaseMic = () => {
    if (meter.current) {
      window.clearInterval(meter.current.timer);
      void meter.current.context.close().catch(() => {});
      meter.current = null;
    }
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
  };

  // 响度只给 Co-Agent 胶囊看（光或眼睛跟着声音动），和录音是同一条流、不送到扬声器；取不到就不动，录音照常。
  const startMeter = (source: MediaStream) => {
    const AudioContextClass = window.AudioContext ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;
    try {
      const context = new AudioContextClass();
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      context.createMediaStreamSource(source).connect(analyser);
      void context.resume().catch(() => {});
      const samples = new Uint8Array(analyser.fftSize);
      const timer = window.setInterval(() => {
        analyser.getByteTimeDomainData(samples);
        let energy = 0;
        for (const sample of samples) energy += ((sample - 128) / 128) ** 2;
        announceLevel(Math.min(1, Math.sqrt(energy / samples.length) * 5));
      }, 60);
      meter.current = { context, timer };
    } catch {
      /* 同上 */
    }
  };

  const start = useCallback(async () => {
    if (recorder.current) return;
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setState({ status: "unsupported", error: "当前浏览器不支持录音，该会议将没有录音。" });
      return;
    }
    const type = pickRecordingType((candidate) => MediaRecorder.isTypeSupported(candidate));
    setState({ status: "starting" });
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setState({ status: "denied", error: "麦克风未授权，该会议将没有录音。" });
      return;
    }
    const response = await fetch(base, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).catch(() => null);
    const body = (await response?.json().catch(() => ({}))) as { recordingId?: string; message?: string } | undefined;
    if (!response?.ok || !body?.recordingId) {
      releaseMic();
      setState({ status: "failed", error: body?.message ?? "录音未能启动，该会议将没有录音。" });
      return;
    }
    recordingId.current = body.recordingId;
    // 刷新页面后再按开始：服务端还是同一份录音，序号从已经收到的片数往后接（重复的序号服务端会忽略）。
    const existing = response.status === 200 ? await fetch(`${base}/${encodeURIComponent(body.recordingId)}`).then((res) => (res.ok ? res.json() : null)).catch(() => null) : null;
    seq.current = (existing as { chunkCount?: number } | null)?.chunkCount ?? 0;
    failed.current = null;
    const media = new MediaRecorder(stream.current, type ? { mimeType: type } : undefined);
    media.ondataavailable = (event) => upload(event.data);
    media.start(SLICE_MS);
    recorder.current = media;
    startMeter(stream.current);
    setState({ status: "recording", recordingId: body.recordingId });
  }, [base, upload]);

  /** 停下、传完最后一片、告诉服务端录完了。没在录就什么都不做。返回服务端是否接下了转写。 */
  const stop = useCallback(async (): Promise<boolean> => {
    const media = recorder.current;
    const id = recordingId.current;
    if (!media || !id) return false;
    setState({ status: "stopping", recordingId: id });
    await new Promise<void>((resolve) => {
      media.addEventListener("stop", () => resolve(), { once: true });
      media.stop();
    });
    recorder.current = null;
    releaseMic();
    await queue.current;
    const response = await fetch(`${base}/${encodeURIComponent(id)}/finish`, { method: "POST" }).catch(() => null);
    recordingId.current = null;
    if (!response?.ok) {
      const body = (await response?.json().catch(() => ({}))) as { message?: string } | undefined;
      setState({ status: "failed", error: body?.message ?? "录音未能提交转写，请稍后在「会议记录」中导入妙记。", recordingId: id });
      return false;
    }
    setState(failed.current ? { status: "finished", error: failed.current, recordingId: id } : { status: "finished", recordingId: id });
    return true;
  }, [base]);

  // 离开会议页时还在录：停下，把录到的传完并交给服务端转写（不丢已录的部分）。
  const stopRef = useRef(stop);
  useEffect(() => {
    stopRef.current = stop;
  }, [stop]);
  useEffect(
    () => () => {
      if (recorder.current) void stopRef.current();
    },
    [],
  );

  // 在录的时候，右列顶上摆出 Co-Agent 胶囊（会议页的右列读 `meeting:<id>`）。
  const recording = state.status === "recording";
  useEffect(() => {
    if (!recording) return;
    announceListening(`meeting:${meetingId}`);
    return () => announceListening(null);
  }, [recording, meetingId]);

  // 录音中刷新或关掉标签页：浏览器会拦一下，提醒这场会还在录。
  useEffect(() => {
    if (state.status !== "recording") return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [state.status]);

  return { state, start, stop };
}
