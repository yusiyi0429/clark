import { voiceConfig } from "./config";
import { cosyvoice } from "./cosyvoice";
import { minimax } from "./minimax";
import type { TTSProvider } from "./types";

/**
 * 这一场用哪一家。
 *
 * 只有这一个函数知道厂商列表；路由和脚本只拿 `TTSProvider`。换厂商 = 改
 * `demo/voice.json` 里的 `provider`，或者会议室现场一个 `TTS_PROVIDER=minimax`。
 */
export function ttsProvider(): TTSProvider {
  return voiceConfig().provider === "minimax" ? minimax() : cosyvoice();
}

export { voiceConfig, auditionMatrix } from "./config";
export { TTSNotConfigured } from "./types";
export type { TTSProvider, TTSStream, TTSMark, TTSVoiceOpts } from "./types";
