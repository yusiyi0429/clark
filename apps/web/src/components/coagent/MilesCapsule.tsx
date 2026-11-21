"use client";

/**
 * 伙伴形象 Miles：一颗 22 高、写着伙伴名字的小胶囊（最窄 70，名字长时变宽，最宽 96），Miles 从它平直的上沿探出半身（用户 10/31 定稿）。
 * C妹（用户 11/04 让接入）也是这样一块：一比一取自有授权的原图，和 Miles 同一套动作、同样大小，只换画。
 * 对话层页头那颗大一号（size: header）：28 高，名字和对话正文一样大（用户 11/03 定）。
 * 出现的时机、姿势和其他形象一样，由 PresenceCapsule 转过来；画和动作在 milesRig 里，这里只把它挂上、跟着姿势和声音走。
 * Q 版圆形头像（shape: circle，11/17 设计 5.1）：没有胶囊，圆里是整颗头（画的 head 取景框），大小由放它的地方定。
 */

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { CMEI_ART, CMEI_SVG } from "./cmeiArt";
import { MILES_ART, MILES_SVG } from "./milesArt";
import { milesBoxHeight, milesCapsuleWidth, mountMiles, type MilesCapsuleSize, type MilesFigure, type MilesPose, type MilesRig, type MilesShape } from "./milesRig";
import type { FigureSkin } from "./skin";
import m from "@/styles/coagent-miles.module.css";

/** 每种形象的画、摆位和没起名字时胶囊上的字。 */
const FIGURES: Record<FigureSkin, MilesFigure> = {
  miles: { art: MILES_ART, svg: MILES_SVG, name: "Miles" },
  // 胶囊名牌上写 Mia（11/04 用户定）；选形象时读屏仍念「C妹」。
  cmei: { art: CMEI_ART, svg: CMEI_SVG, name: "Mia" },
};

export function MilesCapsule({ skin, name, pose, level, leaving, size = "small", shape = "capsule", still = false, children }: {
  /** 挂哪一种形象。 */
  skin: FigureSkin;
  /** 伙伴名字，写在胶囊上；空着时写形象自己的名字（Miles 写「Miles」，C妹 写「Mia」）。 */
  name: string;
  pose: MilesPose;
  /** 0–1：在听时对方说话的响度。 */
  level: number;
  leaving: boolean;
  /** 胶囊哪一档（页头那颗大一号）。 */
  size?: MilesCapsuleSize;
  /** circle：Q 版圆形头像。 */
  shape?: MilesShape;
  /** 一下都不动（门牌）：按「减少动态效果」挂，不出场、不眨眼。 */
  still?: boolean;
  /** 读屏念的那句（PresenceCapsule 给）。 */
  children?: ReactNode;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const rig = useRef<MilesRig | null>(null);
  const idPrefix = `${skin}${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const poseRef = useRef(pose);
  poseRef.current = pose;
  const nameRef = useRef(name);
  nameRef.current = name;
  const [width, setWidth] = useState(() => milesCapsuleWidth(0, size));

  useEffect(() => {
    if (!svg.current) return;
    const reduced = still || window.matchMedia("(prefers-reduced-motion: reduce)").matches
      || document.documentElement.dataset.reduceMotion === "true";
    const mounted = mountMiles(svg.current, {
      figure: FIGURES[skin],
      idPrefix,
      name: nameRef.current,
      pose: poseRef.current,
      reduced,
      size,
      shape,
      classes: { headPose: m.headPose, gaze: m.gaze, breathe: m.breathe, speakGlass: m.speakGlass },
    });
    rig.current = mounted;
    return () => { mounted.destroy(); rig.current = null; };
  }, [idPrefix, skin, size, shape, still]);

  useEffect(() => { if (rig.current) setWidth(rig.current.setName(name)); }, [name]);
  useEffect(() => { rig.current?.setPose(pose); }, [pose]);
  useEffect(() => { rig.current?.setLevel(level); }, [level]);
  useEffect(() => { if (leaving) rig.current?.leave(); }, [leaving]);

  const circle = shape === "circle";
  return (
    <div className={m.miles} style={circle ? undefined : { width, height: milesBoxHeight(size, FIGURES[skin].art) }} data-skin={skin} data-pose={pose} data-leaving={leaving || undefined} data-shape={circle ? "circle" : undefined} data-still={still || undefined}>
      <svg ref={svg} className={m.unit} viewBox={circle ? FIGURES[skin].art.head : undefined} aria-hidden focusable="false" />
      {children}
    </div>
  );
}
