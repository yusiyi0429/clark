"use client";

import { frameJson, frameText, readSse } from "./sse";

import { parseStageEvent, type StageEvent } from "@/lib/stage/events";

/**
 * 把 `/api/chat` 那条流读完。
 *
 * 两个模式共用这一个函数。手动模式只传 `onFrame`，`ui_event` 就落在地上没人接 ——
 * 这是对的：对话栏不需要知道舞台的存在。口述模式多传一个 `onEvent`，屏幕就跟着话走。
 *
 * 每帧最多推一次屏幕：模型是一个字一个字来的，一个字一次 `setState` 就是几百次整栏
 * 重渲染，而人眼一帧只看得见一次。多字节汉字跨 chunk 断开的问题在 `readSse` 里处理。
 *
 * `event: error` 会抛。它只在「一个字都还没说」的时候出现（服务端那边说了一半的失败
 * 会当正文报），所以抛出去正好落在调用方那条「什么都不落地，只留一行报错」的路上。
 */
export async function drain(
  body: ReadableStream<Uint8Array>,
  sofar: { text: string },
  onFrame: () => void,
  onEvent?: (event: StageEvent) => void,
): Promise<void> {
  let frame = 0;
  const push = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      onFrame();
    });
  };

  try {
    for await (const f of readSse(body)) {
      if (f.event === "text") {
        sofar.text += frameText(f);
        push();
        continue;
      }
      if (f.event === "error") throw new Error(frameText(f));
      if (f.event === "ui_event" && onEvent) {
        const event = parseStageEvent(frameJson(f));
        // 舞台事件不排队等 rAF：屏幕要在他听到那句话之前就已经变了。
        if (event) onEvent(event);
      }
    }
    onFrame();
  } finally {
    if (frame) cancelAnimationFrame(frame);
  }
}
