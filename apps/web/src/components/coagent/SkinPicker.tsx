"use client";

/**
 * 选伙伴的样子（「我 › 伙伴」）：五种形象两列排（左边三颗胶囊、右边 Miles 和 C妹），每格一颗待机姿势的胶囊，不写名字和介绍。
 * 和引导里选形象一致，不预览在听 / 在说。
 */

import { useEffect, useState } from "react";
import { PresenceCapsule } from "./PresenceCapsule";
import { COAGENT_SKINS, type CoAgentSkin } from "./skin";
import s from "@/styles/coagent-skin-picker.module.css";

/** 模拟一个人在说话：几条不同快慢的正弦叠起来，偶尔停顿。引导顶上那颗选中的胶囊也用它。 */
export function useSimulatedLevel(active: boolean) {
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
  return (
    <div className={s.options} role="radiogroup" aria-label="伙伴形象">
      {COAGENT_SKINS.map((item) => (
        <label key={item.id} className={s.option} data-selected={skin === item.id || undefined}>
          <input type="radio" name="coagent-skin" value={item.id} checked={skin === item.id} aria-label={item.label} onChange={() => setSkin(item.id)} />
          <span className={s.stage}>
            <PresenceCapsule skin={item.id} pose="idle" level={0} name={name} />
          </span>
        </label>
      ))}
    </div>
  );
}
