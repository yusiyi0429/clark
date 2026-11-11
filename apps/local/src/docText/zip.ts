// 只读的 zip 读取：从中央目录找条目，按需解压单个部件。只用 node:zlib，解压时限定输出长度，挡压缩炸弹。
import { inflateRawSync } from "node:zlib";
import { DOC_TEXT_LIMITS, DocTextError } from "./limits.js";

interface Entry { method: number; flags: number; compSize: number; size: number; localOffset: number }

const CFB_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

export class ZipReader {
  /** 部件名一律小写（OPC 部件名不分大小写），不带开头的斜杠。 */
  private readonly entries = new Map<string, Entry>();
  private unzipped = 0;

  constructor(private readonly buf: Buffer) {
    if (CFB_MAGIC.every((b, i) => buf[i] === b)) {
      throw new DocTextError("encrypted", "转不了：文件加了密码，或者其实是老版本的 Word / Excel 格式");
    }
    if (buf.length < 22 || buf.readUInt32LE(0) !== 0x04034b50) throw corrupt();
    // 中央目录结尾记录：在最后 22 + 65535 字节里从后往前找
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
      if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw corrupt();
    const count = buf.readUInt16LE(eocd + 10);
    const cdOffset = buf.readUInt32LE(eocd + 16);
    if (count === 0xffff || cdOffset === 0xffffffff) throw new DocTextError("too_large", "转不了：文件太大");
    if (count > DOC_TEXT_LIMITS.maxZipEntries) throw new DocTextError("too_large", "转不了：文件里的条目太多");
    let p = cdOffset;
    for (let n = 0; n < count; n++) {
      if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw corrupt();
      const nameLen = buf.readUInt16LE(p + 28);
      const name = buf.toString("utf8", p + 46, p + 46 + nameLen).replace(/^\/+/, "").toLowerCase();
      this.entries.set(name, {
        flags: buf.readUInt16LE(p + 8),
        method: buf.readUInt16LE(p + 10),
        compSize: buf.readUInt32LE(p + 20),
        size: buf.readUInt32LE(p + 24),
        localOffset: buf.readUInt32LE(p + 42),
      });
      p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    }
  }

  has(name: string): boolean {
    return this.entries.has(name.toLowerCase());
  }

  /** 读一个部件成 UTF-8 文字；没有这个部件回 null。 */
  readText(name: string): string | null {
    const e = this.entries.get(name.toLowerCase());
    if (!e) return null;
    if (e.flags & 1) throw new DocTextError("encrypted", "转不了：文件加了密码");
    const budget = DOC_TEXT_LIMITS.maxUnzippedBytes - this.unzipped;
    if (e.size > budget) throw tooBig();
    const lh = e.localOffset;
    if (lh + 30 > this.buf.length || this.buf.readUInt32LE(lh) !== 0x04034b50) throw corrupt();
    const start = lh + 30 + this.buf.readUInt16LE(lh + 26) + this.buf.readUInt16LE(lh + 28);
    const raw = this.buf.subarray(start, start + e.compSize);
    if (raw.length !== e.compSize) throw corrupt();
    let out: Buffer;
    if (e.method === 0) out = raw;
    else if (e.method === 8) {
      try {
        // 不信条目里写的大小，解压时直接卡输出长度
        out = inflateRawSync(raw, { maxOutputLength: Math.max(1, budget) });
      } catch (err) {
        if ((err as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") throw tooBig();
        throw corrupt();
      }
    } else throw corrupt();
    if (out.length > budget) throw tooBig();
    this.unzipped += out.length;
    // 去掉 UTF-8 BOM
    return out.toString("utf8").replace(/^﻿/, "");
  }
}

function corrupt(): DocTextError {
  return new DocTextError("corrupt", "转不了：文件坏了，或者不是 Word / Excel 文件");
}

function tooBig(): DocTextError {
  return new DocTextError("too_large", "转不了：文件解压出来太大");
}
