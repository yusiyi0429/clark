"use client";

/**
 * 伙伴的样子（用户 2026-09-28 定，10-29 改叫「伙伴形象」）：默认是那道 Siri 色光；另外两种给想让它「像个同事」的人选 ——
 * 生命感（同一颗蓝色玻璃胶囊，光换成一双眼睛）和熊猫。10-31 加了 Miles：一个从小胶囊上沿探出半身的 2D 男孩。
 * 只换样子，出现的时机和状态不变。
 *
 * 选的样子跟着伙伴存在服务端（components/buddy/useBuddy）。选伙伴以前只记在这台电脑的浏览器里，第一次选伙伴时默认停在那一种上。
 */

export type CoAgentSkin = "classic" | "alive" | "panda" | "miles";

export const COAGENT_SKINS: { id: CoAgentSkin; label: string; hint: string }[] = [
  { id: "classic", label: "默认", hint: "一道流动的色光" },
  { id: "alive", label: "生命感", hint: "蓝色胶囊，多了一双眼睛" },
  { id: "panda", label: "熊猫", hint: "黑眼圈，两只小耳朵" },
  { id: "miles", label: "Miles", hint: "戴棒球帽的男孩，从胶囊里探出来" },
];

export function readStoredSkin(): CoAgentSkin {
  try {
    const value = window.localStorage.getItem("tianshu.coagent-skin");
    return value === "alive" || value === "panda" ? value : "classic";
  } catch {
    return "classic";
  }
}
