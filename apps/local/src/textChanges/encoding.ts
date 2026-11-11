// 文本文件的字节 ⇄ 文字。认 UTF-8（带不带 BOM）、UTF-16（带 BOM）、GBK / GB18030。
// 只有「解码再编码能逐字节还原」才算 exact（能按处恢复）；换行不动，原样留在文字里。
// 运行环境（Node 24、Bun 1.3.13 和 Bun 编出的单文件）的 TextDecoder 都认 gbk、gb18030；编码器没有，GBK 的反查表在第一次用到时现建。

export type TextEncodingName = "utf-8" | "utf-16le" | "utf-16be" | "gbk";
export interface TextEncoding { name: TextEncodingName; bom: boolean }
export interface DecodedText { text: string; encoding: TextEncoding; /** 编码回去逐字节一样 */ exact: boolean }

const BOMS: Array<[TextEncodingName, number[]]> = [
  ["utf-8", [0xef, 0xbb, 0xbf]],
  ["utf-16le", [0xff, 0xfe]],
  ["utf-16be", [0xfe, 0xff]],
];

/** 解成文字；二进制、认不出编码的回 null。 */
export function decodeText(bytes: Uint8Array): DecodedText | null {
  for (const [name, bom] of BOMS) {
    if (bom.every((b, i) => bytes[i] === b)) return finish(bytes, bytes.subarray(bom.length), { name, bom: true });
  }
  // 没有 BOM 时带 0 字节的当二进制（不猜无 BOM 的 UTF-16）
  if (bytes.subarray(0, 8192).includes(0)) return null;
  if (decode("utf-8", bytes) !== null) return finish(bytes, bytes, { name: "utf-8", bom: false });
  return finish(bytes, bytes, { name: "gbk", bom: false });
}

/** 文字编码成字节（带上原来的 BOM）；有编不进去的字回 null。 */
export function encodeText(text: string, enc: TextEncoding): Uint8Array | null {
  let body: Uint8Array | null;
  if (enc.name === "utf-8") body = new TextEncoder().encode(text);
  else if (enc.name === "utf-16le" || enc.name === "utf-16be") {
    const buf = Buffer.from(text, "utf16le");
    if (enc.name === "utf-16be") buf.swap16();
    body = buf;
  } else body = encodeGbk(text);
  if (!body) return null;
  const bom = enc.bom ? BOMS.find(([n]) => n === enc.name)![1] : [];
  const out = new Uint8Array(bom.length + body.length);
  out.set(bom);
  out.set(body, bom.length);
  return out;
}

function finish(all: Uint8Array, body: Uint8Array, encoding: TextEncoding): DecodedText | null {
  // GBK 用 gb18030 解（它是 GBK 的超集，认四字节的字）；编码回去只认一、二字节，四字节的字还原不了就只给看
  const text = decode(encoding.name === "gbk" ? "gb18030" : encoding.name, body);
  if (text === null) return null;
  const back = encodeText(text, encoding);
  return { text, encoding, exact: !!back && Buffer.compare(back, all) === 0 };
}

function decode(label: string, bytes: Uint8Array): string | null {
  try {
    return new TextDecoder(label, { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

// ---------- GBK 编码（反查表） ----------

let gbkTable: Map<number, number> | null = null;

function encodeGbk(text: string): Uint8Array | null {
  const table = (gbkTable ??= buildGbkTable());
  const out = new Uint8Array(text.length * 2);
  let n = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80) out[n++] = cp;
    else {
      const code = table.get(cp);
      if (code === undefined) return null;
      if (code > 0xff) out[n++] = code >> 8;
      out[n++] = code & 0xff;
    }
  }
  return out.subarray(0, n);
}

/** 把所有一、二字节的 GBK 码解一遍，记下「字 → 码」。同一个字有两个码的，留先出现的（和解码器的标准映射一致）。 */
function buildGbkTable(): Map<number, number> {
  const table = new Map<number, number>();
  const dec = new TextDecoder("gb18030", { fatal: true });
  const pair = new Uint8Array(2);
  const add = (bytes: Uint8Array, code: number) => {
    try {
      const s = dec.decode(bytes);
      const cp = s.codePointAt(0)!;
      if (s.length === (cp > 0xffff ? 2 : 1) && !table.has(cp)) table.set(cp, code);
    } catch {
      // 不是合法的码
    }
  };
  add(Uint8Array.of(0x80), 0x80);
  for (let lead = 0x81; lead <= 0xfe; lead++) {
    for (let trail = 0x40; trail <= 0xfe; trail++) {
      if (trail === 0x7f) continue;
      pair[0] = lead;
      pair[1] = trail;
      add(pair, (lead << 8) | trail);
    }
  }
  return table;
}
