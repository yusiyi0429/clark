"use client";

/**
 * 伙伴形象的小号（对话层页头正中、右下角「对话<名字>」那颗胶囊）：本人选的形象，没选时是默认胶囊。
 * - 页头：横放胶囊缩成 104×32；Miles、C妹 按 1 倍画，胶囊大一号（28 高），名字和对话正文一样大（11/03 用户定）。
 * - 入口：横放胶囊按原尺寸（48 高）铺满主按钮，主按钮就是它、不写名字；Miles、C妹 放到 1.1、只露出半身，从入口胶囊的上沿探出来（名字写在入口上）。
 * - 署名（note）：伙伴写的段落左边那一颗（交付物的版本说明），横放胶囊缩成 40×16，Miles、C妹 缩一半。
 * 姿势：在听本人说话（listening，页头那颗在听写时）> 伙伴在说话（active：回答进行中、收着时来了新话）> 待机。
 * 在说时用模拟的声音动起来；在听时跟着本人说话的响度动、整块再变大一圈；待机时安静，不读麦克风。
 */

import { PresenceCapsule } from "@/components/coagent/PresenceCapsule";
import { useSimulatedLevel } from "@/components/coagent/SkinPicker";
import type { Buddy } from "./useBuddy";
import b from "@/styles/buddy-mark.module.css";

export function BuddyMark({ buddy, place, active, listening = false, level = 0 }: {
  buddy: Buddy | null;
  place: "sheet" | "entry" | "note";
  active: boolean;
  /** 在听本人说话（听写中）。 */
  listening?: boolean;
  /** 0–1：在听时本人说话的响度。 */
  level?: number;
}) {
  const speaking = active && !listening;
  const simulated = useSimulatedLevel(speaking);
  const skin = buddy?.form ?? "classic";
  return (
    <span className={b.mark} data-place={place} data-skin={skin} data-listening={listening || undefined} aria-hidden>
      <span className={b.scale}>
        <PresenceCapsule skin={skin} name={buddy?.name ?? ""} milesSize={place === "sheet" ? "header" : "small"}
          pose={listening ? "listening" : speaking ? "speaking" : "idle"} level={listening ? level : speaking ? simulated : 0} />
      </span>
    </span>
  );
}
