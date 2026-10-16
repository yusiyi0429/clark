"use client";

import { useEffect, useRef, useState } from "react";
import { prefersReducedMotion } from "@/lib/motion";
import { afterResize, resizing } from "./resizeGate";

/**
 * 平滑出字：网络一次送来 10–60 个字（每 110–170ms 一批），界面按字匀速放出来，不一跳一跳。
 * - 速度自适应：每帧放出「积压 ÷ 追赶时间」个字，积压多就快、少就慢，有一个最低速度，尾巴不会爬；
 * - 正文结束（不再流式）：追赶时间缩短、最低速度提高，剩下的尽快补齐；
 * - 切口不落在 Markdown 记号中间（`**`、行首的 `#` / `-` / `1.` / `>`）、不切开代理对，免得一帧里块类型来回变；
 * - 系统要求减少动态效果、或没有 rAF（服务端渲染、测试）时直接显示全文。
 * - 对话层放大 / 收起的过渡里（resizeGate）只累积、不渲染：放出的进度照常往前走，过渡结束一次补齐。
 */

/** 流式中：追赶时间（ms）与最低速度（字/秒）。 */
const STREAM_CATCH_UP_MS = 280;
const STREAM_MIN_RATE = 45;
/** 正文已结束：尽快补齐。 */
const FINISH_CATCH_UP_MS = 110;
const FINISH_MIN_RATE = 600;
/** 新挂上的流式节点里已有这么多字以内就从头放，多了（中途打开对话层）直接显示已有的部分。 */
export const SMOOTH_FROM_START_MAX = 80;

/** 一帧放出多少：返回新的已放出长度（小数，累计用）。 */
export function smoothStep(shown: number, target: number, dtMs: number, finishing: boolean): number {
  const backlog = target - shown;
  if (backlog <= 0) return target;
  const rate = Math.max(finishing ? FINISH_MIN_RATE : STREAM_MIN_RATE, (backlog * 1000) / (finishing ? FINISH_CATCH_UP_MS : STREAM_CATCH_UP_MS));
  return Math.min(target, shown + (rate * dtMs) / 1000);
}

const LINE_MARKER = /^[ \t]*(?:(?:#{1,6}|[-*+]|\d{1,3}[.)]|>)[ \t]+)*(?:#{1,6}|[-*+]|\d{1,3}[.)]?|>|\|)?/;
const INLINE_MARKER = /[*_~`[\\]/;

/** 把切口挪到不会让结构来回变的地方（只往后挪）：行首记号整段放出并带上第一个字；不停在行内记号上；不切开代理对。 */
export function snapCut(text: string, cut: number): number {
  let at = Math.max(0, Math.min(text.length, Math.floor(cut)));
  if (at === 0 || at >= text.length) return at;
  const lineStart = text.lastIndexOf("\n", at - 1) + 1;
  const marker = LINE_MARKER.exec(text.slice(lineStart))?.[0].length ?? 0;
  if (marker && at < lineStart + marker + 1) at = Math.min(text.length, lineStart + marker + 1);
  while (at < text.length && INLINE_MARKER.test(text[at - 1])) at++;
  const code = text.charCodeAt(at - 1);
  if (at < text.length && code >= 0xd800 && code <= 0xdbff) at++;
  return at;
}

/** 正在流式的文字按字放出；`streaming` 为假时尽快补齐。`enabled` 为假直接返回全文。 */
export function useSmoothText(text: string, enabled: boolean, streaming: boolean): string {
  const [animate] = useState(() => enabled && typeof requestAnimationFrame === "function" && !prefersReducedMotion());
  const shown = useRef(animate && text.length > SMOOTH_FROM_START_MAX ? text.length : 0);
  const [, setTick] = useState(0);
  /** 过渡结束时补的那一次重画（同一个函数，排多少帧都只补一次）。 */
  const [bump] = useState(() => () => setTick((value) => value + 1));
  const target = useRef(text.length);
  target.current = text.length;
  const finishing = useRef(!streaming);
  finishing.current = !streaming;
  const lastFrame = useRef(0);
  const active = animate && enabled;

  useEffect(() => {
    if (!active || shown.current >= target.current) return;
    let frame = requestAnimationFrame(function tick(now) {
      const dt = lastFrame.current ? Math.min(64, Math.max(0, now - lastFrame.current)) : 16;
      lastFrame.current = now;
      const next = smoothStep(shown.current, target.current, dt, finishing.current);
      if (Math.floor(next) !== Math.floor(shown.current)) {
        if (resizing()) afterResize(bump);
        else bump();
      }
      shown.current = next;
      if (next < target.current) frame = requestAnimationFrame(tick);
      else lastFrame.current = 0;
    });
    return () => {
      cancelAnimationFrame(frame);
      lastFrame.current = 0;
    };
  }, [active, text, bump]);

  if (!active) return text;
  if (shown.current > text.length) shown.current = text.length;
  return text.slice(0, snapCut(text, shown.current));
}

/**
 * 把正文切成顶层块（块之间空一行）：只有最后一块还在长，前面的块文字不再变、可以不重新解析。
 * 只在安全的地方切：不在代码块里；下一块从行首开始，且不是列表项、引用、表格、缩进续行（这些可能和上一块连成一个结构）。
 * 有脚注或链接定义（跨块引用）时不切。切出来的块各自解析，画出来与整段解析的结构一致。
 */
export function splitStableBlocks(text: string): string[] {
  if (/^\[[^\]\n]+\]:/m.test(text)) return [text];
  const lines = text.split("\n");
  const blocks: string[] = [];
  let current: string[] = [];
  let fence: string | null = null;
  let blank = false;
  for (const line of lines) {
    const fenceMark = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence === null && !fenceMark && blank && line.trim() && current.length
      && !/^(?:[ \t]|[-*+][ \t]|\d{1,9}[.)][ \t]|>|\|)/.test(line) && !/^[-*+]$|^\d{1,9}[.)]$/.test(line.trim())) {
      blocks.push(current.join("\n"));
      current = [];
    }
    if (fence === null && fenceMark && blank && current.length) {
      blocks.push(current.join("\n"));
      current = [];
    }
    current.push(line);
    if (fenceMark) {
      if (fence === null) fence = fenceMark[0].repeat(3);
      else if (fenceMark.startsWith(fence)) fence = null;
    }
    blank = fence === null && !line.trim();
  }
  blocks.push(current.join("\n"));
  return blocks;
}
