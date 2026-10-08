"use client";

import { useCallback, useEffect, useState } from "react";
import { browserApi } from "@/lib/api/client";

/** 同一页面里多个地方要读（更新卡片、执行事项按钮），只请求一次；读失败下次挂载再试。 */
let loading: Promise<string[]> | null = null;
let cachedKeys: string[] | null = null;
const listeners = new Set<(keys: string[]) => void>();
function remember(keys: string[]) {
  cachedKeys = keys;
  listeners.forEach((listener) => listener(keys));
  return keys;
}

function load(): Promise<string[]> {
  loading ??= browserApi.GET("/api/me/seen-marks").then(({ data }) => {
    if (!data) throw new Error("seen marks unavailable");
    return remember([...new Set([...(cachedKeys ?? []), ...data.keys])]);
  }).catch((error: unknown) => {
    loading = null;
    throw error;
  });
  return loading;
}

/**
 * 我看过的更新说明与演示（服务端按人记）。读不到时 `seen` 为 null：调用方不弹，
 * 以免接口出错时每次进来都被强制打断。
 */
export function useSeenMarks() {
  const [seen, setSeen] = useState<ReadonlySet<string> | null>(null);
  useEffect(() => {
    let live = true;
    const changed = (keys: string[]) => { if (live) setSeen(new Set(keys)); };
    listeners.add(changed);
    load().then((keys) => { if (live) setSeen(new Set(keys)); }, () => undefined);
    return () => { live = false; listeners.delete(changed); };
  }, []);
  const mark = useCallback((key: string) => {
    remember([...new Set([...(cachedKeys ?? []), key])]);
    loading = loading?.then((keys) => keys.includes(key) ? keys : [...keys, key]) ?? null;
    void browserApi.POST("/api/me/seen-marks/{key}", { params: { path: { key } } });
  }, []);
  return { seen, mark };
}
