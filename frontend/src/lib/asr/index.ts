import { paraformer } from "./paraformer";
import type { ASRProvider } from "./types";

/**
 * 这一场用哪一家听。
 *
 * 现在只有一家。这个函数照样要存在 —— 它是那条「换厂商只改一个地方」的线：路由和前端
 * 只拿 `ASRProvider`，`paraformer` 这个名字不出现在任何别的文件里。播报层已经证明了这条
 * 线是有用的（第二家 MiniMax 接进来没有动过路由）。
 */
export function asrProvider(): ASRProvider {
  return paraformer();
}

export { listenConfig, clientListenConfig } from "./config";
export { ASRNotConfigured } from "./types";
export type { ASRProvider, ASRStream, ASRResult, ASROpts } from "./types";
export type { ListenConfig, ClientListenConfig } from "./config";
