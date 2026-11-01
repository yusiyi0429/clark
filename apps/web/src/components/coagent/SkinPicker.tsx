"use client";

/**
 * 选伙伴时的三颗胶囊（引导第一步和个人菜单「伙伴形象」共用，外面包一层 BuddyPicker）：三种形象各一行，左边一颗活的胶囊预览。
 * 上面一个小开关看两种姿势（在听 / 在说），预览的声音是模拟的。
 */

import { useEffect, useState } from "react";
import { PresenceCapsule, type CapsulePose } from "./PresenceCapsule";
import { COAGENT_SKINS, type CoAgentSkin } from "./skin";
import s from "@/styles/coagent-skin-picker.module.css";

/** 模拟一个人在说话：几条不同快慢的正弦叠起来，偶尔停顿。 */
function useSimulatedLevel(active: boolean) {
  const [level, setLevel] = useState(0.3);
  useEffect(() => {
    if (!active || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const started = performance.now();
    const timer = window.setInterval(() => {
      const t = (performance.now() - started) / 1000;
      const voice = Math.abs(Math.sin(t * 5.1) * 0.5 + Math.sin(t * 8.3 + 1) * 0.3 + Math.sin(t * 1.7) * 0.2);
      const pause = Math.sin(t * 0.9) > 0.75 ? 0.15 : 1;
      setLevel(Math.min(1, voice * pause));
    }, 80);
    return () => window.clearInterval(timer);
  }, [active]);
  return level;
}

export function CoAgentSkinPicker({ value: skin, name, onChange: setSkin }: {
  value: CoAgentSkin;
  /** 正在起的伙伴名字：Miles 那颗胶囊上写的就是它，跟着变宽。 */
  name: string;
  onChange: (skin: CoAgentSkin) => void;
}) {
  const [pose, setPose] = useState<CapsulePose>("listening");
  const level = useSimulatedLevel(pose === "listening");
  return (
    <div className={s.picker}>
      <div className={s.poses} role="radiogroup" aria-label="预览姿势">
        {(["listening", "speaking"] as const).map((item) => (
          <label key={item} className={s.pose} data-selected={pose === item || undefined}>
            <input type="radio" name="coagent-pose" value={item} checked={pose === item} onChange={() => setPose(item)} />
            {item === "listening" ? "在听" : "在说"}
          </label>
        ))}
      </div>
      <div className={s.options} role="radiogroup" aria-label="伙伴形象">
        {COAGENT_SKINS.map((item) => (
          <label key={item.id} className={s.option} data-selected={skin === item.id || undefined}>
            <input type="radio" name="coagent-skin" value={item.id} checked={skin === item.id} onChange={() => setSkin(item.id)} />
            <span className={s.stage}>
              <PresenceCapsule skin={item.id} pose={pose} level={level} name={name} />
            </span>
            <span className={s.words}>
              <strong>{item.label}</strong>
              <small>{item.hint}</small>
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}
