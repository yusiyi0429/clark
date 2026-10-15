"use client";

import { useEffect, useRef } from "react";

/**
 * 回答末尾的选项（10/11 首演版定稿）：Agent 给出备选方案时，在回答最后附一个机器可读的块
 *
 * ```options
 * [{"label":"维持现状"},{"label":"正式采用"},{"label":"暂不决定"}]
 * ```
 *
 * 前端解析后把整块从正文里拿掉（流式中、读回历史时同一套），原文不显示；解析失败只是不显示选项。
 * 流式中还没写完的块、只写了一半的围栏行（「`」「```opt」）也先拿掉，不进 remend 与到达淡入。
 */
const FENCE = "```options";
const OPEN = /(?:^|\n)```options[ \t]*(?:\n|$)/g;
const CLOSE = /\n```[ \t]*(?:\n|$)/;
export const MAX_OPTION_LABEL = 12;

export type ParsedAnswer = { body: string; options: string[] };

function readOptions(json: string): string[] {
  try {
    const value: unknown = JSON.parse(json);
    if (!Array.isArray(value) || value.length < 2 || value.length > 4) return [];
    const labels = value.map((item) => (item && typeof item === "object" && typeof (item as { label?: unknown }).label === "string"
      ? (item as { label: string }).label.trim() : ""));
    if (labels.some((label) => !label || [...label].length > MAX_OPTION_LABEL)) return [];
    return new Set(labels).size === labels.length ? labels : [];
  } catch {
    return [];
  }
}

export function parseAnswerOptions(text: string, streaming = false): ParsedAnswer {
  let open: RegExpExecArray | null = null;
  for (const match of text.matchAll(OPEN)) open = match;
  if (!open) {
    if (!streaming) return { body: text.trimEnd(), options: [] };
    // 流式中最后一行还可能长成围栏行：先不显示这一行。
    const lineStart = text.lastIndexOf("\n") + 1;
    const tail = text.slice(lineStart);
    return { body: (tail && FENCE.startsWith(tail) ? text.slice(0, lineStart) : text).trimEnd(), options: [] };
  }
  const before = text.slice(0, open.index);
  const rest = text.slice(open.index + open[0].length);
  const close = CLOSE.exec(`\n${rest}`);
  if (!close) return { body: before.trimEnd(), options: [] };
  const json = `\n${rest}`.slice(0, close.index);
  const after = `\n${rest}`.slice(close.index + close[0].length).trim();
  return { body: (after ? `${before.trimEnd()}\n\n${after}` : before).trimEnd(), options: readOptions(json) };
}

/** 点选项填进输入框的话：由 CEO 自己补充、发送，保持「CEO 原话」授权口径。 */
export const optionPrefill = (label: string) => `选择：${label}`;

export const ANSWER_OPTION_EVENT = "answer-option-chosen";
type OptionDetail = { scope: string; text: string };

/** 点了某个选项：交给这条对话的输入框（右列或全局对话层），不发送。 */
export function chooseAnswerOption(scope: string, label: string) {
  window.dispatchEvent(new CustomEvent<OptionDetail>(ANSWER_OPTION_EVENT, { detail: { scope, text: optionPrefill(label) } }));
}

/** 输入框一侧：同一对话范围的选项点击把文字填进来（由调用方负责聚焦）。 */
export function useAnswerOptionFill(scope: string, fill: (text: string) => void) {
  const latest = useRef(fill);
  useEffect(() => { latest.current = fill; });
  useEffect(() => {
    if (typeof window === "undefined") return;
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<OptionDetail>).detail;
      if (detail?.scope === scope) latest.current(detail.text);
    };
    window.addEventListener(ANSWER_OPTION_EVENT, listener);
    return () => window.removeEventListener(ANSWER_OPTION_EVENT, listener);
  }, [scope]);
}
