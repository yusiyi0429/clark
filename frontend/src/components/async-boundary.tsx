"use client";

import type { ReactNode } from "react";
import { ApiError, ForbiddenError } from "@/lib/data/client";
import type { Resource } from "@/lib/use-resource";

/**
 * Loading and failure, in one place, in Chinese.
 *
 * §8.3 — loading is a skeleton or a mono ellipsis, never a spinner. Failure is
 * one plain sentence plus a retry. 权限被拒（ForbiddenError）是同一个框、同一句话，
 * 但没有重试 —— 重试改变不了权限判定的结果。A blank screen, an English stack trace
 * or a stray `undefined` is not an acceptable outcome of anything here.
 */
export function AsyncBoundary<T>({
  resource,
  skeleton,
  children,
}: {
  resource: Resource<T>;
  skeleton?: ReactNode;
  children: (data: T) => ReactNode;
}) {
  const { data, error, isLoading, mutate } = resource;

  if (error) {
    const isForbidden = error instanceof ForbiddenError;
    return (
      <div className="rounded-lg border border-counter/25 bg-counter-wash px-4 py-3.5">
        {/*
         * 取数走的是 `api.`，那一层的失败全是 ApiError 并且带着一句中文（连不上、
         * 服务端出错、业务性失败，三种各说各的）—— 所以正常路径永远走上面那一支。
         * else 只剩 fetcher 那个箭头函数自己崩了，那时候原因真的不在手上：只说没取到，
         * 不猜「网络中断」。猜错方向比不说更糟：他会去看 Wi-Fi，而问题在服务端。
         */}
        <p className="text-sm leading-relaxed text-ink">
          {error instanceof ApiError ? error.message : "这一步没有取到结果。"}
        </p>
        {!isForbidden && (
          <button
            type="button"
            onClick={() => void mutate()}
            className="meta mt-2 rounded-[3px] px-1.5 py-0.5 text-counter underline underline-offset-4 transition-colors hover:bg-counter/10"
          >
            重试
          </button>
        )}
      </div>
    );
  }

  if (isLoading || data === undefined) {
    return <>{skeleton ?? <LoadingLine />}</>;
  }

  return <>{children(data)}</>;
}

export function LoadingLine({ label = "…" }: { label?: string }) {
  return (
    <p className="meta py-6 text-ink-faint" aria-live="polite">
      {label}
    </p>
  );
}
