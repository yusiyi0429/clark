"use client";

/**
 * 伙伴形象的小号（对话层页头正中、右下角「对话<名字>」那颗胶囊）：本人选的形象，没选时是默认胶囊。
 * - 页头：横放胶囊缩成 104×32；Miles 整块（半身 + 写名字的小胶囊）缩到 0.8。
 * - 入口：横放胶囊缩成 34×22，放在「对话<名字>」前面；Miles 缩到 0.8、只露出半身，从入口胶囊的上沿探出来（名字已经写在入口上）。
 * active：伙伴在说话（回答进行中、收着时来了新话），换成说话的姿势、用模拟的声音动起来；平时安静，不读麦克风。
 */

import { PresenceCapsule } from "@/components/coagent/PresenceCapsule";
import { useSimulatedLevel } from "@/components/coagent/SkinPicker";
import type { Buddy } from "./useBuddy";
import b from "@/styles/buddy-mark.module.css";

export function BuddyMark({ buddy, place, active }: { buddy: Buddy | null; place: "sheet" | "entry"; active: boolean }) {
  const level = useSimulatedLevel(active);
  const skin = buddy?.form ?? "classic";
  return (
    <span className={b.mark} data-place={place} data-skin={skin} aria-hidden>
      <span className={b.scale}>
        <PresenceCapsule skin={skin} name={buddy?.name ?? ""} pose={active ? "speaking" : "listening"} level={active ? level : 0} />
      </span>
    </span>
  );
}
