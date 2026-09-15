/**
 * 一条流，几类事件。
 *
 * 原来 `/api/chat` 回的是**裸文本字节**：上游 DeepSeek 的 SSE 在服务端被拆开，只把
 * `delta.content` 拼起来往下吐。那样最省事，但口述模式要在同一条流里往下带另一样东西
 * —— 屏幕该变成什么（`ui_event`）。裸字节里没有地方放它。
 *
 * 所以升级成真正的 SSE，事件命名：
 *
 *   event: text       data: "他要听的那句话的下一小段"
 *   event: ui_event   data: {"type":"SHOW_EVIDENCE","evidenceId":"e1"}
 *   event: step       data: "正在去外面查证"
 *   event: error      data: "这段没说完就断了：…"
 *
 * 这不是另一条通道：同一个 POST、同一个 `fetch`、同一个 `res.body`，只是帧里多了一行
 * `event:`。多出来的事件谁不认谁就看不见 —— 口述模式不认 `step`，手动模式不认 `ui_event`，
 * 两个模式共用这一条流，是「双模式同源」在传输层的样子。
 *
 * `step` 是**纯提示，落在地上没有后果**：它只喂对话栏等待时那行扫光小字（`chat-pane.tsx`），
 * 一个字都不进落库的那段回应。所以接不接由消费方自己定，漏掉一帧也不会让这一轮少点东西。
 *
 * `data` 一律是 JSON。理由是文本里真的会出现换行（他要的分段），而 SSE 用空行分帧 ——
 * 裸文本一带换行，帧就断在句子中间。JSON 把换行变成 `\n` 两个字符，这个问题就不存在了。
 */

export type SseFrame = { event: string; data: string };

/** 服务端：编一帧。`data` 已经是 JSON 字符串。 */
export const encodeSse = (event: string, data: unknown): string =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/**
 * 客户端：把字节流读成一帧一帧。
 *
 * `TextDecoder({stream:true})` 是必须的 —— 中文一个字三字节，chunk 边界会切在字中间，
 * 不带 `stream` 就会吐出问号。这一条在裸文本那一版里已经踩过了。
 */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split("\n\n");
      // 最后一截可能是半帧，留着等下一个 chunk。
      buf = parts.pop() ?? "";
      for (const raw of parts) {
        const frame = decodeFrame(raw);
        if (frame) yield frame;
      }
    }
    buf += decoder.decode();
    const tail = decodeFrame(buf);
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}

function decodeFrame(raw: string): SseFrame | null {
  let event = "message";
  const data: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    // `:` 开头是注释（心跳），忽略。
  }
  if (!data.length) return null;
  return { event, data: data.join("\n") };
}

/** `data` 是 JSON 字符串时取出那个字符串；不是就当它本来就是文本。 */
export function frameText(frame: SseFrame): string {
  try {
    const v = JSON.parse(frame.data);
    return typeof v === "string" ? v : frame.data;
  } catch {
    return frame.data;
  }
}

/** `data` 是 JSON 对象时取出来；坏帧返回 `null`，不抛 —— 一帧坏掉不该让整场停住。 */
export function frameJson(frame: SseFrame): unknown {
  try {
    return JSON.parse(frame.data);
  } catch {
    return null;
  }
}
