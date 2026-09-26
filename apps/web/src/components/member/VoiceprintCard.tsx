"use client";

/**
 * 我的声纹：录一段约 30 秒的朗读，会后天枢用它认出录音里哪段话是我说的，预填进「确认每位说话人是谁」，由人确认，不自动确认。
 *
 * 声纹是敏感个人信息（个人信息保护法）：录之前单独勾选同意、写明用途；本人随时可以删除，删除后腾讯云和天枢一起删。
 * 录音用浏览器 MediaRecorder，最少 15 秒、最多 30 秒（和火山实时声纹注册的 15–30 秒同一个口径，以后换过去不用重录）。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Checkbox, Label } from "ts-design/primitives";
import { Mic, Square } from "lucide-react";
import { browserApi } from "@/lib/api/client";
import { monthDayTime } from "@/lib/companyTime";
import { pickRecordingType } from "@/components/meeting/useMeetingRecorder";
import s from "@/styles/voiceprint.module.css";

export const VOICEPRINT_SCRIPT =
  "我是天枢的成员。开会时，我会把判断、依据和下一步说清楚：这件事为什么现在做，需要谁来配合，什么时候给出结果。会上定下来的事情，我会放进执行事项里跟进，并及时同步进展。遇到拿不准的地方，我会先说清楚还缺什么信息，再约相关的同事一起对齐。";

const MIN_SECONDS = 15;
const MAX_SECONDS = 30;

type Status = { enrolled: boolean; updatedAt: string | null; configured: boolean };
type Phase = "idle" | "recording" | "recorded" | "saving";

export function VoiceprintCard() {
  const [status, setStatus] = useState<Status | null>(null);
  const [consent, setConsent] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [seconds, setSeconds] = useState(0);
  const [clip, setClip] = useState<Blob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const timer = useRef<number | null>(null);

  const load = useCallback(async () => {
    const { data } = await browserApi.GET("/api/me/voiceprint");
    if (data) setStatus(data as Status);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(
    () => () => {
      if (timer.current) window.clearInterval(timer.current);
      recorder.current?.stream.getTracks().forEach((track) => track.stop());
    },
    [],
  );

  const stop = () => {
    if (timer.current) window.clearInterval(timer.current);
    timer.current = null;
    recorder.current?.stop();
  };

  const start = async () => {
    setError(null);
    setNote(null);
    setClip(null);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") return setError("这个浏览器不能录音，请换 Chrome 或 Edge。");
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      return setError("麦克风没有授权，录不了声纹。");
    }
    const type = pickRecordingType((candidate) => MediaRecorder.isTypeSupported(candidate));
    const media = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    const parts: Blob[] = [];
    media.ondataavailable = (event) => {
      if (event.data.size) parts.push(event.data);
    };
    media.onstop = () => {
      stream.getTracks().forEach((track) => track.stop());
      setClip(new Blob(parts, { type: media.mimeType || "audio/webm" }));
      setPhase("recorded");
    };
    media.start();
    recorder.current = media;
    setSeconds(0);
    setPhase("recording");
    const began = Date.now();
    timer.current = window.setInterval(() => {
      const elapsed = Math.floor((Date.now() - began) / 1000);
      setSeconds(elapsed);
      if (elapsed >= MAX_SECONDS) stop();
    }, 250);
  };

  const save = async () => {
    if (!clip) return;
    setPhase("saving");
    setError(null);
    const form = new FormData();
    form.append("audio", clip, clip.type.includes("mp4") ? "voiceprint.m4a" : "voiceprint.webm");
    form.append("consent", "true");
    const response = await fetch("/api/me/voiceprint", { method: "POST", body: form }).catch(() => null);
    const body = (await response?.json().catch(() => ({}))) as (Status & { message?: string }) | undefined;
    if (!response?.ok || !body) {
      setPhase("recorded");
      return setError(body?.message ?? "没录上，请重试。");
    }
    setStatus(body);
    setClip(null);
    setPhase("idle");
    setNote("已录好。之后的会议录音里，天枢会用它预填你是哪位说话人。");
  };

  const remove = async () => {
    setError(null);
    const { response } = await browserApi.DELETE("/api/me/voiceprint");
    if (!response.ok) return setError("没删掉，请重试。");
    setNote("已删除。腾讯云和天枢里都不再保存你的声纹。");
    void load();
  };

  const recording = phase === "recording";
  const tooShort = phase === "recorded" && seconds < MIN_SECONDS;

  return (
    <section className={s.card} aria-labelledby="voiceprint-title">
      <header className={s.head}>
        <h2 id="voiceprint-title">我的声纹</h2>
        <span className={s.state} data-enrolled={status?.enrolled || undefined}>
          {status?.enrolled ? `已录好${status.updatedAt ? ` · ${monthDayTime(status.updatedAt)}` : ""}` : "还没录"}
        </span>
      </header>
      <p className={s.lead}>开会录音后，天枢用声纹认出哪段话是你说的，预填到会议记录的「确认每位说话人是谁」里，由人确认。</p>
      {status && !status.configured ? (
        <p className={s.note}>声纹识别还没开通（服务器还没配腾讯云），暂时不能录入。</p>
      ) : (
        <>
          {!status?.enrolled || phase !== "idle" ? (
            <>
              <Checkbox className={s.consent} isSelected={consent} onChange={setConsent} isDisabled={recording || phase === "saving"}>
                <Checkbox.Control>
                  <Checkbox.Indicator />
                </Checkbox.Control>
                <Label>我同意天枢保存我的声纹特征，只用于在公司会议录音里认出我的发言；我可以随时删除。</Label>
              </Checkbox>
              <blockquote className={s.script} aria-label="请朗读这段文字">
                {VOICEPRINT_SCRIPT}
              </blockquote>
              <p className={s.hint}>在安静的地方、用平时开会的那只麦克风，正常语速读完这段（{MIN_SECONDS}–{MAX_SECONDS} 秒）。</p>
            </>
          ) : null}
          <div className={s.actions}>
            {recording ? (
              <Button variant="ghost" size="sm" data-emphasis onPress={stop}>
                <Square size={14} aria-hidden="true" />
                停止 · {seconds} 秒
              </Button>
            ) : phase === "recorded" ? (
              <>
                <Button variant="ghost" size="sm" data-emphasis isDisabled={tooShort} onPress={() => void save()}>
                  {tooShort ? `太短了（${seconds} 秒）` : "保存声纹"}
                </Button>
                <Button variant="ghost" size="sm" onPress={() => void start()}>
                  重录
                </Button>
              </>
            ) : phase === "saving" ? (
              <Button variant="ghost" size="sm" isDisabled>
                保存中…
              </Button>
            ) : status?.enrolled ? (
              <>
                <Button variant="ghost" size="sm" onPress={() => void start()} isDisabled={!consent}>
                  重新录制
                </Button>
                <Button variant="ghost" size="sm" onPress={() => void remove()}>
                  删除我的声纹
                </Button>
              </>
            ) : (
              <Button variant="ghost" size="sm" data-emphasis isDisabled={!consent} onPress={() => void start()}>
                <Mic size={14} aria-hidden="true" />
                开始录制
              </Button>
            )}
          </div>
          {status?.enrolled && phase === "idle" ? (
            <Checkbox className={s.consent} isSelected={consent} onChange={setConsent}>
              <Checkbox.Control>
                <Checkbox.Indicator />
              </Checkbox.Control>
              <Label>重新录制前再确认一次：同意天枢保存我的声纹特征，只用于认出我的会议发言。</Label>
            </Checkbox>
          ) : null}
        </>
      )}
      {error ? (
        <p className={s.error} role="alert">
          {error}
        </p>
      ) : null}
      {note ? (
        <p className={s.note} role="status">
          {note}
        </p>
      ) : null}
    </section>
  );
}
