"use client";

import { useEffect } from "react";
import useSWR, { useSWRConfig } from "swr";

import { liveRefresh } from "./live-data";

/**
 * Read-side data access. One thin wrapper so every page gets the same
 * loading/error shape and the same revalidation policy.
 *
 * 自动重验证全部关掉：焦点回来、网络重连、带着旧数据重新挂载，都不会悄悄重取。
 * 理由是等待状态 —— 一次静默重取藏在 200–600ms 后面，屏幕上那句「正在…」就成了假话。
 * 写操作走 `api.*`，把服务端返回的那个对象直接交给
 * `mutate(..., { revalidate: false })`（H2 的落地）。
 *
 * **这条规则原来漏掉了一整类变化**：不是他点出来的那些。深研跑完、报告读成判断、
 * 一条信号被开成议题、预研落地 —— 这些是服务端自己做完的，浏览器没有任何途径知道，
 * 于是屏幕上一直是刚才那一份，他得按 F5。补上的不是「定时去问」（那会把上面那条
 * 理由推翻），而是一条「库改过了」的通道：服务端改完说一声，收到才重问一次。
 * 号怎么来的见 `lib/live-data.ts` 与 `lib/data/revision.ts`。
 */
export function useResource<T>(key: string | null, fetcher: () => Promise<T>) {
  const { data, error, isLoading, mutate } = useSWR<T>(key, fetcher, {
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    revalidateIfStale: false,
    shouldRetryOnError: false,
  });

  useEffect(() => {
    if (!key) return;
    return liveRefresh(key, () => void mutate());
  }, [key, mutate]);

  return { data, error: error as Error | undefined, isLoading, mutate };
}

export type Resource<T> = ReturnType<typeof useResource<T>>;

/**
 * 写完之后，让所有别的屏幕重新去问一次。
 *
 * 故意不做「只失效相关的那几个 key」：这个产品里每一次写都会移动一条判断，而首屏
 * 的天数、条数、中位耗时、最近变了什么全是从判断算出来的。少列一个 key，屏幕就会
 * 在一号位刚刚改过的地方显示旧数字 —— 那是这块屏幕最不能出的一种错。
 *
 * 把缓存清成 undefined 而不是标记为 stale，是因为 `revalidateIfStale: false` 之下
 * 「有旧数据的 key」重新挂载时不会去问。
 *
 * `onScreen` 是此刻正挂在屏幕上的那几个 key（可以给 key 本身，也可以给一个判定函数）。
 * 它们照样重新去问，但**不清空**：清空会让外面的 AsyncBoundary 掉回骨架，把一号位
 * 正在看的那一栏整个重挂 —— 页签、滚动位置、展开状态全丢。他刚点完一下，屏幕不该
 * 从头长一遍。
 */
type KeySpec = string | ((key: string) => boolean);

export function useInvalidate() {
  const { mutate } = useSWRConfig();
  return (...onScreen: KeySpec[]) => {
    const kept = (key: unknown): key is string =>
      typeof key === "string" &&
      onScreen.some((k) => (typeof k === "string" ? k === key : k(key)));

    // 屏幕上的：原地重问，保留旧数据（populateCache: false = 不把 undefined 写回去）。
    if (onScreen.length > 0) {
      void mutate(kept, undefined, { revalidate: true, populateCache: false });
    }
    // 其余的：清空并重问，下次挂载时一定是新的。
    void mutate(
      (key) => typeof key === "string" && !kept(key),
      undefined,
      { revalidate: true }
    );
  };
}

/**
 * 把服务端刚刚返回的对象放进它自己那个地址的缓存里。
 *
 * 用在「写完就跳到那个对象的页面」这种地方：答案已经在手上了，落地页再去问一次
 * 只会先闪一下骨架再显示同样的内容。这不是乐观更新（H2）—— 服务端已经答了，这里
 * 存的就是它的答复；缓存里从来不会出现一个没被服务端确认过的对象。
 */
export function useSeed() {
  const { mutate } = useSWRConfig();
  return <T,>(key: string, data: T) =>
    void mutate(key, data, { revalidate: false });
}
