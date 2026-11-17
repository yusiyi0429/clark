"use client";

/**
 * 伙伴形象的小号（对话层页头正中、右下角「对话<名字>」那颗胶囊）：本人选的形象，没选时是默认胶囊。
 * - 页头：横放胶囊缩成 104×32；Miles、C妹 按 1 倍画，胶囊大一号（28 高），名字和对话正文一样大（11/03 用户定）。
 * - 入口：横放胶囊按原尺寸（48 高）铺满主按钮，主按钮就是它、不写名字；Miles、C妹 放到 1.1、只露出半身，从入口胶囊的上沿探出来（名字写在入口上）。
 * - 署名（note）：伙伴写的段落左边那一颗（交付物的版本说明），横放胶囊缩成 40×16，Miles、C妹 缩一半。
 * 姿势：在听本人说话（listening，页头那颗在听写时）> 伙伴在说话（active：回答进行中、收着时来了新话）> 待机。
 * 在说时用模拟的声音动起来；在听时跟着本人说话的响度动、整块再变大一圈；待机时安静，不读麦克风。
 *
 * 新首页的两处（11/17 设计 5.1、5.2）：页头正中（head）、左上角伙伴名片（card）。胶囊类横放、不写名字；
 * Miles、C妹 是 Q 版圆形头像（data-shape="circle"）。样子照传进来的 state 画，不自己计时（做完了持续多久由调用方管）。
 */

import { PresenceCapsule, type CapsulePose } from "@/components/coagent/PresenceCapsule";
import { useSimulatedLevel } from "@/components/coagent/SkinPicker";
import { isFigureSkin } from "@/components/coagent/skin";
import type { Buddy } from "./useBuddy";
import b from "@/styles/buddy-mark.module.css";

export type BuddyState = "idle" | "thinking" | "typing" | "done" | "listening";

export function BuddyMark({ buddy, place, active = false, listening = false, level = 0, state = "idle" }: {
  buddy: Buddy | null;
  /** stage：新首页左栏顶上的伙伴台（正方形里居中，比页头大一号，设计 9.2）。head、card：新首页页头正中、左上角伙伴名片。 */
  place: "sheet" | "entry" | "note" | "stage" | "head" | "card";
  active?: boolean;
  /** 在听本人说话（听写中）。 */
  listening?: boolean;
  /** 0–1：在听时本人说话的响度。 */
  level?: number;
  /** 只有 head、card 用。 */
  state?: BuddyState;
}) {
  const placed = place === "head" || place === "card";
  const speaking = !placed && active && !listening;
  const simulated = useSimulatedLevel(speaking);
  const skin = buddy?.form ?? "classic";
  const circle = placed && isFigureSkin(skin);
  const pose: CapsulePose = placed ? state : listening ? "listening" : speaking ? "speaking" : "idle";
  const poseLevel = placed ? (state === "listening" ? level : 0) : listening ? level : speaking ? simulated : 0;
  return (
    <span className={b.mark} data-place={place} data-skin={skin} data-state={placed ? state : undefined} data-shape={circle ? "circle" : undefined}
      data-listening={listening || undefined} aria-hidden>
      <span className={b.scale}>
        <PresenceCapsule skin={skin} name={buddy?.name ?? ""} milesSize={place === "sheet" || place === "stage" ? "header" : "small"}
          shape={circle ? "circle" : undefined} pose={pose} level={poseLevel} />
      </span>
    </span>
  );
}
