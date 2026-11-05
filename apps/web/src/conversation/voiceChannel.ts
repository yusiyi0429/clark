"use client";

/**
 * 对话层页头的伙伴和输入条的小麦克风是同一次听写（用户 11/03 定）：点伙伴和点麦克风效果一样，两边状态同步。
 * 听写本身在输入条里（useDictation 要输入框和它的文字），这里只是两边之间的一根线：
 * 输入条把「在不在听」和说话的响度报上来，页头的伙伴据此变大、跟着声音动；点伙伴就请输入条开始或停下。
 * 每条对话一份（ScopedConversation 里建）；响度每 80ms 一帧，只有订阅它的伙伴重画，不牵动整个对话层。
 */

import { useSyncExternalStore } from "react";

export type VoiceChannel = {
  /** 输入条：这次听写在不在听，此刻的响度（0–1）。 */
  publish(listening: boolean, level: number): void;
  /** 输入条：登记点伙伴时做什么；返回撤销登记。 */
  handle(toggle: () => void): () => void;
  /** 页头的伙伴被点了。 */
  toggle(): void;
  subscribe(notify: () => void): () => void;
  listening(): boolean;
  level(): number;
};

export function createVoiceChannel(): VoiceChannel {
  let listening = false;
  let level = 0;
  let handler: (() => void) | null = null;
  const listeners = new Set<() => void>();
  return {
    publish(nextListening, nextLevel) {
      if (nextListening === listening && nextLevel === level) return;
      listening = nextListening;
      level = nextLevel;
      listeners.forEach((notify) => notify());
    },
    handle(toggle) {
      handler = toggle;
      return () => {
        if (handler === toggle) handler = null;
      };
    },
    toggle: () => handler?.(),
    subscribe(notify) {
      listeners.add(notify);
      return () => listeners.delete(notify);
    },
    listening: () => listening,
    level: () => level,
  };
}

/** 页头的伙伴：此刻在不在听、响度多大（服务端渲染时通道刚建好，读出来就是没在听）。 */
export function useVoice(channel: VoiceChannel): { listening: boolean; level: number } {
  const listening = useSyncExternalStore(channel.subscribe, channel.listening, channel.listening);
  const level = useSyncExternalStore(channel.subscribe, channel.level, channel.level);
  return { listening, level };
}
