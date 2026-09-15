"use client";

import type { CSSProperties } from "react";

import { toneOf } from "@/lib/data/agenda";

/**
 * 一场会的颜色，写成可以挂在任何元素上的一个变量。
 *
 * 这一句是四个色档唯一的取用口：别处一律写 `var(--meet)`，于是「这一场是什么颜色」只在
 * 这里决定一次。档位由 `toneOf` 按**时间序**给（不是哈希，理由写在那边）—— 议题栏、
 * 日程板、会后那一栏三处因此永远给同一场会同一个颜色，而颜色在这里承担的正是
 * 「这几件是同一场」。
 */
export const meetStyle = (seq: number): CSSProperties =>
  ({ "--meet": `var(--meet-${toneOf(seq)})` }) as CSSProperties;
