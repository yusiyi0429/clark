/**
 * `/api/speak` 那条流的分帧。
 *
 * 音频是二进制，字幕的句边界是文字，两样东西要在**同一条 HTTP 响应**里按顺序下来 ——
 * 顺序是关键：句边界必须落在它那一句的音频前面，字幕才对得上嘴。分成两个请求就没有顺序了。
 *
 * 所以给字节流加一层很薄的帧头，五个字节：
 *
 *   [1 字节 kind][4 字节 长度，大端][负载]
 *
 * 没用 SSE：SSE 是文本协议，音频要 base64，体积涨三分之一，而这条流是要抢一秒半那个指标的。
 * 也没用 WebSocket —— 单向的东西不值得多一种协议（这一点和 `/api/stage` 那条线的理由一样）。
 */

export const FRAME_AUDIO = 0;
export const FRAME_MARK = 1;
/** 出错了。前端要把这句话写到字幕上去，不许静默地没声音。 */
export const FRAME_ERROR = 2;

export const HEADER_BYTES = 5;

export function encodeFrame(kind: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(HEADER_BYTES + payload.byteLength);
  out[0] = kind;
  const n = payload.byteLength;
  out[1] = (n >>> 24) & 0xff;
  out[2] = (n >>> 16) & 0xff;
  out[3] = (n >>> 8) & 0xff;
  out[4] = n & 0xff;
  out.set(payload, HEADER_BYTES);
  return out;
}

export const encodeTextFrame = (kind: number, text: string): Uint8Array =>
  encodeFrame(kind, new TextEncoder().encode(text));

/**
 * 前端那一头：字节进来，帧出去。
 *
 * chunk 边界和帧边界没有任何关系 —— 一个音频帧会被切成三个 chunk，三个小帧也会挤在一个
 * chunk 里。所以必须自己攒。这里不用 `Blob`/`DataView` 之外的任何东西，零依赖。
 */
export class FrameReader {
  /*
   * 写成 `Uint8Array<ArrayBufferLike>` 而不是让它自己推：`new Uint8Array(0)` 推出来的是
   * `Uint8Array<ArrayBuffer>`（窄一档），而 `fetch` 那条流给过来的 chunk 是 `ArrayBufferLike`
   * —— 可能落在 SharedArrayBuffer 上。两者赋值不过去。
   */
  private buf: Uint8Array<ArrayBufferLike> = new Uint8Array(0);

  push(chunk: Uint8Array): { kind: number; payload: Uint8Array }[] {
    this.buf = concat(this.buf, chunk);
    const out: { kind: number; payload: Uint8Array }[] = [];
    for (;;) {
      if (this.buf.byteLength < HEADER_BYTES) break;
      const len =
        (this.buf[1] << 24) | (this.buf[2] << 16) | (this.buf[3] << 8) | this.buf[4];
      if (this.buf.byteLength < HEADER_BYTES + len) break;
      out.push({
        kind: this.buf[0],
        payload: this.buf.slice(HEADER_BYTES, HEADER_BYTES + len),
      });
      this.buf = this.buf.slice(HEADER_BYTES + len);
    }
    return out;
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (!a.byteLength) return b;
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}
