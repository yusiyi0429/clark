"use client";

/**
 * 一个 Task 的交付物（GET /api/plan-tasks/{taskId}/deliverable）：评审中、重评中、伙伴在写版本说明时每 2 秒重取一次，
 * 做完就停。传新版本、交付、撤回、不同意、改说明之后用接口返回的那一版就地换上，再发 HOME_PLAN_CHANGED 让左边 Task 列表的状态跟着变。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { TDeliverableNotePatch, TDeliverableVersion, TTaskDeliverableResponse } from "@warmap/contracts";
import { HOME_PLAN_CHANGED } from "../useHomePlan";

const POLL_MS = 2_000;
const READ_ERROR = "交付物暂时没读到，稍后自动重试。";

/** 这一版还在等后台：评审排队、评审中（含重评），或者伙伴在写版本说明。 */
export function versionBusy(version: TDeliverableVersion): boolean {
  return version.review.status === "queued" || version.review.status === "running" || version.note?.status === "writing";
}

type Result = { ok: true } | { ok: false; message: string };

async function send(url: string, init: RequestInit): Promise<{ version?: TDeliverableVersion; message?: string; ok: boolean }> {
  const response = await fetch(url, init);
  if (response.status === 401) { window.location.assign("/access?next=%2Fme"); return { ok: false, message: "登录已过期" }; }
  const body = await response.json().catch(() => ({})) as TDeliverableVersion & { message?: string };
  return response.ok ? { ok: true, version: body } : { ok: false, message: body.message ?? "没成功，请重试" };
}

export function useTaskDeliverable(taskId: string) {
  const [data, setData] = useState<TTaskDeliverableResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const base = `/api/plan-tasks/${encodeURIComponent(taskId)}/deliverable`;
  const latest = useRef(base);
  latest.current = base;

  const load = useCallback(async () => {
    try {
      const response = await fetch(base);
      if (response.status === 401) { window.location.assign("/access?next=%2Fme"); return; }
      const body = await response.json().catch(() => null) as TTaskDeliverableResponse | null;
      if (latest.current !== base) return;
      if (response.ok && body) { setData(body); setError(null); }
      else setError(READ_ERROR);
    } catch {
      if (latest.current === base) setError(READ_ERROR);
    }
  }, [base]);

  useEffect(() => { setData(null); setError(null); void load(); }, [load]);

  const busy = data?.versions.some(versionBusy) ?? false;
  // 后台评审或版本说明自己做完时，左边 Task 列表的状态也跟着换（不等首页 20 秒一次的重取）。
  const wasBusy = useRef(false);
  useEffect(() => {
    if (wasBusy.current && !busy) window.dispatchEvent(new Event(HOME_PLAN_CHANGED));
    wasBusy.current = busy;
  }, [busy]);
  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [busy, load]);

  /** 换上接口返回的那一版（新版本放最前面），并让首页计划重取。 */
  const apply = useCallback((version: TDeliverableVersion) => {
    setData((current) => current && {
      ...current,
      versions: current.versions.some((item) => item.id === version.id)
        ? current.versions.map((item) => (item.id === version.id ? version : item))
        : [version, ...current.versions],
    });
    window.dispatchEvent(new Event(HOME_PLAN_CHANGED));
  }, []);

  const act = useCallback(async (path: string, init: RequestInit): Promise<Result> => {
    try {
      const result = await send(`${base}${path}`, init);
      if (!result.ok || !result.version) return { ok: false, message: result.message ?? "没成功，请重试" };
      apply(result.version);
      return { ok: true };
    } catch {
      return { ok: false, message: "网络不通，请重试" };
    }
  }, [apply, base]);

  const json = (method: string, body?: unknown): RequestInit =>
    ({ method, headers: body === undefined ? undefined : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

  return {
    data,
    error,
    /** 传一个新版本：files 新加的文件，links 贴的链接，statement 附的一句话或现状，keep 沿用上一版里的哪几样。 */
    createVersion: (input: { files: File[]; links: string[]; statement: string; keep: string[] }) => {
      const form = new FormData();
      for (const file of input.files) form.append("files", file);
      form.append("links", JSON.stringify(input.links));
      form.append("statement", input.statement);
      form.append("keep", JSON.stringify(input.keep));
      return act("/versions", { method: "POST", body: form });
    },
    deliver: (versionId: string) => act(`/versions/${versionId}/deliver`, json("POST")),
    withdraw: (versionId: string) => act(`/versions/${versionId}/withdraw`, json("POST")),
    retry: (versionId: string) => act(`/versions/${versionId}/review`, json("POST")),
    dissent: (versionId: string, index: number, reason: string) => act(`/versions/${versionId}/criteria/${index}/dissent`, json("POST", { reason })),
    patchNote: (versionId: string, patch: TDeliverableNotePatch) => act(`/versions/${versionId}/note`, json("PATCH", patch)),
    itemHref: (itemId: string) => `${base}/items/${itemId}`,
  };
}

export type TaskDeliverableApi = ReturnType<typeof useTaskDeliverable>;
