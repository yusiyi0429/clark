"use client";

import { createContext, useContext } from "react";

/**
 * 开会状态（设计 4.1、4.2）：首页外壳给左栏名片、页头的形象和状态胶囊。
 * listening：开着会在录音；clock：在录时的走秒「12:34」，不在录为 null；href：正在录的那场会的会议页。
 */
export type HomeMeetingState = { listening: boolean; clock: string | null; href: string | null };

export const HomeMeetingContext = createContext<HomeMeetingState>({ listening: false, clock: null, href: null });

export function useHomeMeetingState(): HomeMeetingState {
  return useContext(HomeMeetingContext);
}
