"use client";

/**
 * 伙伴形象 Miles：一颗 70×22、写着名字的小胶囊，Miles 从它平直的上沿探出半身（用户 10/31 定稿）。
 * 出现的时机、姿势和其他形象一样，由 PresenceCapsule 转过来；画和动作在 milesRig 里，这里只把它挂上、跟着姿势和声音走。
 */

import { useEffect, useId, useRef, type ReactNode } from "react";
import { mountMiles, type MilesPose, type MilesRig } from "./milesRig";
import m from "@/styles/coagent-miles.module.css";

export function MilesCapsule({ pose, level, leaving, children }: {
  pose: MilesPose;
  /** 0–1：在听时对方说话的响度。 */
  level: number;
  leaving: boolean;
  /** 读屏念的那句（PresenceCapsule 给）。 */
  children?: ReactNode;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const rig = useRef<MilesRig | null>(null);
  const idPrefix = `miles${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const poseRef = useRef(pose);
  poseRef.current = pose;

  useEffect(() => {
    if (!svg.current) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches
      || document.documentElement.dataset.reduceMotion === "true";
    const mounted = mountMiles(svg.current, {
      idPrefix,
      pose: poseRef.current,
      reduced,
      classes: { headPose: m.headPose, gaze: m.gaze, breathe: m.breathe, breath: m.breath, speakGlass: m.speakGlass },
    });
    rig.current = mounted;
    return () => { mounted.destroy(); rig.current = null; };
  }, [idPrefix]);

  useEffect(() => { rig.current?.setPose(pose); }, [pose]);
  useEffect(() => { rig.current?.setLevel(level); }, [level]);
  useEffect(() => { if (leaving) rig.current?.leave(); }, [leaving]);

  return (
    <div className={m.miles} data-skin="miles" data-pose={pose} data-leaving={leaving || undefined}>
      <svg ref={svg} className={m.unit} aria-hidden focusable="false" />
      {children}
    </div>
  );
}
