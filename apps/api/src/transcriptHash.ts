import { createHash } from "node:crypto";

/**
 * 逐字稿来源的摘要值与来源字段（天枢采集和 Chat 校验用同一算法）：
 * - 摘要值只统一换行（CRLF / CR → LF），不去空白、不改说话人和正文，再对 UTF-8 算 SHA-256（hex）；
 * - 飞书妙记算的是 /artifacts 的 data.transcript 原文（与 lark-cli minutes +detail --transcript 写出的逐字相同）。
 */
export function normalizeTranscriptText(raw: string): string {
  return raw.replace(/\r\n?/g, "\n");
}

export function transcriptContentHash(text: string): string {
  return createHash("sha256").update(normalizeTranscriptText(text), "utf8").digest("hex");
}

/** 读取完成时刻：上海时间、精确到秒、带 +08:00。 */
export function capturedAtOf(at: Date): string {
  return new Date(at.getTime() + 8 * 3_600_000).toISOString().replace(/\.\d{3}Z$/, "+08:00");
}

/** 没有飞书妙记的会（手动上传、录音转写）：来源地址是天枢会议页的逐字稿。 */
export function meetingTranscriptUrl(publicOrigin: string, meetingId: string): string {
  return `${publicOrigin.replace(/\/+$/, "")}/meetings/${meetingId}#transcript`;
}
