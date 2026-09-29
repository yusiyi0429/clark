"use client";

/**
 * Co-Agent 胶囊的形象（用户 2026-09-28 定）：默认是那道 Siri 色光；另外两种给想让它「像个同事」的人选 ——
 * 生命感（同一颗蓝色玻璃胶囊，光换成一双眼睛）和熊猫。只换样子，出现的时机和状态不变。
 *
 * 这是看的人自己的偏好，不是业务数据：只记在这台电脑的浏览器里，换设备回到默认。
 */

import { useCallback, useSyncExternalStore } from "react";

export type CoAgentSkin = "classic" | "alive" | "panda";

export const COAGENT_SKINS: { id: CoAgentSkin; label: string; hint: string }[] = [
  { id: "classic", label: "默认", hint: "一道流动的色光" },
  { id: "alive", label: "生命感", hint: "蓝色胶囊，多了一双眼睛" },
  { id: "panda", label: "熊猫", hint: "黑眼圈，两只小耳朵" },
];

const KEY = "tianshu.coagent-skin";
const CHANGED = "coagent-skin-changed";

function read(): CoAgentSkin {
  try {
    const value = window.localStorage.getItem(KEY);
    return value === "alive" || value === "panda" ? value : "classic";
  } catch {
    return "classic";
  }
}

function subscribe(notify: () => void) {
  window.addEventListener(CHANGED, notify);
  window.addEventListener("storage", notify);
  return () => {
    window.removeEventListener(CHANGED, notify);
    window.removeEventListener("storage", notify);
  };
}

export function useCoAgentSkin(): [CoAgentSkin, (skin: CoAgentSkin) => void] {
  const skin = useSyncExternalStore(subscribe, read, () => "classic" as const);
  const set = useCallback((next: CoAgentSkin) => {
    try {
      window.localStorage.setItem(KEY, next);
    } catch {
      // 存不下（隐私模式）就还是默认。
    }
    window.dispatchEvent(new Event(CHANGED));
  }, []);
  return [skin, set];
}
