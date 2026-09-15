"use client";

import { useSyncExternalStore } from "react";

import { readMode, subscribeMode, type Mode } from "./mode";

/**
 * 现在是哪个模式。
 *
 * 和 `useSessionSeed` 同一个套路：真值在 DOM 上，React 只是订阅它。`getSnapshot` 每次
 * 渲染都会跑，所以它只许返回原语 —— 返回对象会让 React 认为每帧都变了。
 *
 * 服务端那一帧固定是 `"manual"`，客户端第一帧可能就是 `"oral"`。这两帧不一致是故意的：
 * 属性在 `MODE_PREPAINT` 里已经改完，DOM 不会闪；这里只是让需要换组件的地方跟上。
 * 所以用它的组件不能在服务端渲染时依赖它的结果去决定 DOM 结构 —— 舞台整体是懒挂载的，
 * 正好落在客户端。
 */
export function useMode(): Mode {
  return useSyncExternalStore(subscribeMode, readMode, server);
}

const server = (): Mode => "manual";
