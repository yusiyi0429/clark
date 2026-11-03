"use client";

/**
 * 伙伴的样子（用户 2026-09-28 定，10-29 改叫「伙伴形象」）：默认是那道 Siri 色光；另外两种给想让它「像个同事」的人选 ——
 * 生命感（同一颗蓝色玻璃胶囊，光换成一双眼睛）和熊猫。10-31 加了 Miles：一个从小胶囊上沿探出半身的 2D 男孩。
 * 只换样子，出现的时机和状态不变。
 *
 * 选的样子跟着伙伴存在服务端（components/buddy/useBuddy）。选伙伴以前只记在这台电脑的浏览器里，第一次选伙伴时默认停在那一种上。
 */

export type CoAgentSkin = "classic" | "alive" | "panda" | "miles";

/** label 只给读屏用：选的时候只看胶囊，不写名字。 */
export const COAGENT_SKINS: { id: CoAgentSkin; label: string }[] = [
  { id: "classic", label: "默认" },
  { id: "alive", label: "生命感" },
  { id: "panda", label: "熊猫" },
  { id: "miles", label: "Miles" },
];

export function readStoredSkin(): CoAgentSkin {
  try {
    const value = window.localStorage.getItem("tianshu.coagent-skin");
    return value === "alive" || value === "panda" ? value : "classic";
  } catch {
    return "classic";
  }
}
