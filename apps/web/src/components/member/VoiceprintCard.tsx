"use client";

/**
 * 我的声纹：录一段约 30 秒的朗读，会后天枢用它认出录音里哪段话是我说的，预填进「确认每位说话人是谁」，由人确认，不自动确认。
 *
 * 声纹是敏感个人信息（个人信息保护法）：录之前单独勾选同意、写明用途；本人随时可以删除，删除后腾讯云和天枢一起删。
 * 录音用浏览器 MediaRecorder，最少 15 秒、最多 30 秒（和火山实时声纹注册的 15–30 秒同一个口径，以后换过去不用重录）。
 */

import { Button, Checkbox, Label } from "ts-design/primitives";
import { Mic, Square } from "lucide-react";
import { monthDayTime } from "@/lib/companyTime";
import { MAX_SECONDS, MIN_SECONDS, useVoiceprintEnrollment, VOICEPRINT_CONSENT, VOICEPRINT_SCRIPT } from "./useVoiceprintEnrollment";
import s from "@/styles/voiceprint.module.css";

export { VOICEPRINT_SCRIPT } from "./useVoiceprintEnrollment";

export function VoiceprintCard() {
  const { status, consent, setConsent, phase, seconds, error, note, recording, tooShort, start, stop, save, remove } = useVoiceprintEnrollment();
  // 服务器没配声纹识别：个人菜单本就不给入口；万一打开了，也不出任何说明。
  if (status && !status.configured) return null;

  return (
    <section className={s.card} aria-labelledby="voiceprint-title">
      <header className={s.head}>
        <h2 id="voiceprint-title">我的声纹</h2>
        <span className={s.state} data-enrolled={status?.enrolled || undefined}>
          {status?.enrolled ? `已录好${status.updatedAt ? ` · ${monthDayTime(status.updatedAt)}` : ""}` : "还没录"}
        </span>
      </header>
      {!status?.enrolled || phase !== "idle" ? (
        <>
          <Checkbox className={s.consent} isSelected={consent} onChange={setConsent} isDisabled={recording || phase === "saving"}>
            <Checkbox.Control>
              <Checkbox.Indicator />
            </Checkbox.Control>
            <Label>{VOICEPRINT_CONSENT}</Label>
          </Checkbox>
          <blockquote className={s.script} aria-label="请朗读这段文字">
            {VOICEPRINT_SCRIPT}
          </blockquote>
          <p className={s.hint}>{MIN_SECONDS}–{MAX_SECONDS} 秒</p>
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
