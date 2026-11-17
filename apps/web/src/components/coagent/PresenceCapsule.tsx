"use client";

/**
 * Co-Agent 胶囊（clark `coagent/panel.tsx`，C-07）：浮在右列顶部居中的那一颗，没有按钮，谁也不能点它。
 *
 * 两种时候出现：会议页在录音（一直在，姿势是「在听」）；新人第一次进群、Co-Agent 在群里给他讲来龙去脉时
 * （出现几秒，姿势是「在说」，强调那段话是它说的，然后凝回去）。天枢还没有会中实时对话，所以不长大、不写字。
 *
 * 三种形象（skin.ts）只换样子：
 * - 默认：蓝色液态玻璃里一道 Siri 色光，在听时跟着说话的声音起伏。
 * - 生命感：同一颗蓝色玻璃，光换成一双发光的眼睛。在听时眼睛竖着、随声音微微伸缩；在说时眯成两道、往下看
 *   （下面就是它说的那段话）。换姿势时眨一下 —— 只在状态变的那一刻动，待着不眨（「动」只表示有事在发生）。
 * - 熊猫：白色的身子、黑眼圈、两只小耳朵（耳朵探出胶囊上沿，身子和页头胶囊照旧齐平）；底下一圈蓝光，
 *   不会被当成旁边那颗浅色的页头胶囊。
 * - Miles：一颗写着伙伴名字的小胶囊，男孩从上沿探出半身（MilesCapsule），整块 70×66，名字长时胶囊跟着变宽，最宽 96。
 * - C妹：和 Miles 一样的一块，换成女生（一比一取自有授权的原图）。
 */

import { useId, type CSSProperties } from "react";
import { SiriWave } from "@/components/onboarding/SiriWave";
import { MilesCapsule } from "./MilesCapsule";
import type { MilesCapsuleSize, MilesPose, MilesShape } from "./milesRig";
import { useListeningLevel } from "./presence";
import { isFigureSkin, type CoAgentSkin } from "./skin";
import s from "@/styles/coagent-capsule.module.css";

/**
 * 待机（idle）只有本人的伙伴用：对话层页头、右下角入口没在听也没在说的时候。
 * 在想（thinking）、正在输入（typing）、做完了（done）只有页头和伙伴名片用（设计 5.2）。
 */
export type CapsulePose = MilesPose;

export function PresenceCapsule({ skin, pose, level: preview, leaving = false, name = "", milesSize, shape, still = false }: {
  skin: CoAgentSkin;
  pose: CapsulePose;
  /** 伙伴名字：只有 Miles、C妹 写在胶囊上；没起名字时写形象自己的名字。 */
  name?: string;
  /** 只有 Miles、C妹 用：胶囊哪一档（对话层页头那颗大一号，名字和对话正文一样大）。 */
  milesSize?: MilesCapsuleSize;
  /** 只有 Miles、C妹 用：circle 是 Q 版圆形头像。 */
  shape?: MilesShape;
  /** 默认那道光停着不动（新首页页头、伙伴名片里空闲时）。 */
  still?: boolean;
  /** 0–1：只有选形象时的预览传（模拟的声音）；不传就读会议录音那条麦克风流。 */
  level?: number;
  /** 正在凝回去：播完退场就会被移走。 */
  leaving?: boolean;
}) {
  const live = useListeningLevel();
  const level = preview ?? live;
  const patchId = useId();
  const status = preview === undefined ? <span className={s.sr} role="status">{`Co-Agent ${pose === "listening" ? "在录这场会" : "已在群内说明背景"}`}</span> : null;
  if (isFigureSkin(skin)) return <MilesCapsule skin={skin} name={name} pose={pose} level={level} leaving={leaving} size={milesSize} shape={shape}>{status}</MilesCapsule>;
  return (
    <div className={s.capsule} data-skin={skin} data-pose={pose} data-leaving={leaving || undefined} data-still={still || undefined}>
      {skin === "panda" ? <><span className={s.ear} data-side="left" aria-hidden /><span className={s.ear} data-side="right" aria-hidden /></> : null}
      <div className={s.glass} aria-hidden>
        {skin === "classic" ? (
          <SiriWave energy={pose === "speaking" ? 0.9 : level} className={s.wave} still={still} />
        ) : (
          // key：换姿势时重挂一次，眼睛从闭着睁开 —— 眨一下。
          <span key={pose} className={s.face} style={{ "--level": pose === "listening" ? level.toFixed(2) : 0 } as CSSProperties}>
            {(["left", "right"] as const).map((side) => (
              <span key={side} className={s.eye}>
                {skin === "panda" ? (
                  <svg className={s.patch} viewBox="0 0 30 30" focusable="false">
                    <defs>
                      <radialGradient id={`${patchId}-${side}`} cx="46%" cy="12%" r="90%">
                        <stop offset="0" stopColor="#535963" />
                        <stop offset="0.45" stopColor="#30343d" />
                        <stop offset="1" stopColor="#1b1e25" />
                      </radialGradient>
                    </defs>
                    {/* 从参考图左眼圈轮廓拟合的连续圆弧，保留鹅卵石的饱满度；右侧只镜像，不旋转眼珠。 */}
                    <path d="M18.42.14C15.78.14 13.21.81 10.92 2.06C8.64 3.31 6.58 5.15 4.88 7.25C3.17 9.35 1.86 11.56 1 13.97C.14 16.38-.35 19.18.17 21.79C.7 24.4 2.23 26.71 4.43 28.13C6.63 29.56 9.36 30.07 12.06 30.04C14.75 30 17.41 29.52 19.8 28.57C22.19 27.63 24.43 26.09 26.2 24.06C27.97 22.04 29.01 19.66 29.54 17.09C30.06 14.52 30.19 11.73 29.64 9.14C29.09 6.56 27.76 4.17 25.75 2.52C23.74.88 21.06.15 18.42.14Z" fill={`url(#${patchId}-${side})`} />
                  </svg>
                ) : null}
                <i className={s.pupil} />
              </span>
            ))}
          </span>
        )}
      </div>
      {status}
    </div>
  );
}
