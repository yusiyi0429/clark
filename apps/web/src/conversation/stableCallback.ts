"use client";

import { useCallback, useRef } from "react";

/**
 * 身份不变、调用时总是走最新一版的回调：传给 memo 过的子组件（输入条）时，父组件每帧重画也不会让它跟着重画。
 * 只用于事件回调（点击、发送），不要在渲染里调用它。
 * 最新一版在渲染时记下（不等 effect）：提交之后、effect 之前的那一下点击也拿到新的闭包（如刚结束一轮就发下一句）。
 */
export function useStableCallback<Args extends unknown[], Result>(callback: (...args: Args) => Result): (...args: Args) => Result {
  const latest = useRef(callback);
  latest.current = callback;
  return useCallback((...args: Args) => latest.current(...args), []);
}
