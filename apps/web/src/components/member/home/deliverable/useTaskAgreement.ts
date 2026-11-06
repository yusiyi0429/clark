"use client";

/**
 * 一个 Task 的约定与对表（契约 agreements.ts）：约定一打开就读（GET …/agreement），补和改存 11 月的补充（PUT，整份覆盖）；
 * 对表点了才取（GET …/check），对表开着时约定存好了就再对一次。「请 X 看」是 POST …/check/notify：推了或今天已推过都记成「今天已请」，
 * 飞书没接（FEISHU_NOT_CONFIGURED）时这颗键置灰。结论、提示的句子都用服务端给的，这里不拼。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { TCheckNotifyResponse, TPutTaskAgreementRequest, TTaskAgreementResponse, TTaskCheckResponse } from "@warmap/contracts";

type Reply<T> = { ok: true; body: T } | { ok: false; status: number; code: string | null; message: string };

async function call<T>(url: string, init?: RequestInit): Promise<Reply<T>> {
  const response = await fetch(url, init);
  if (response.status === 401) {
    window.location.assign(`/access?next=${encodeURIComponent(`${window.location.pathname}${window.location.search}`)}`);
    return { ok: false, status: 401, code: "UNAUTHENTICATED", message: "登录已过期" };
  }
  const body = await response.json().catch(() => ({})) as T & { code?: string; message?: string };
  return response.ok ? { ok: true, body } : { ok: false, status: response.status, code: body.code ?? null, message: body.message ?? "没成功，请重试" };
}

const json = (method: string, body: unknown): RequestInit => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export function useTaskAgreement(taskId: string) {
  const [agreement, setAgreement] = useState<TTaskAgreementResponse | null>(null);
  const [check, setCheck] = useState<TTaskCheckResponse | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  /** 这次打开以后请过的条目（序号）；服务端的 notifiedToday 另算。 */
  const [asked, setAsked] = useState<number[]>([]);
  const [feishuOff, setFeishuOff] = useState(false);
  const base = `/api/plan-tasks/${encodeURIComponent(taskId)}`;
  const latest = useRef(base);
  latest.current = base;
  const checkOpen = useRef(false);

  const load = useCallback(async () => {
    try {
      const reply = await call<TTaskAgreementResponse>(`${base}/agreement`);
      if (latest.current === base && reply.ok) setAgreement(reply.body);
    } catch {
      // 读不到约定时面板照旧（没有约定行）。
    }
  }, [base]);

  useEffect(() => {
    setAgreement(null); setCheck(null); setCheckError(null); setAsked([]); setFeishuOff(false);
    checkOpen.current = false;
    void load();
  }, [load]);

  const runCheck = useCallback(async () => {
    setChecking(true);
    try {
      const reply = await call<TTaskCheckResponse>(`${base}/check`);
      if (latest.current !== base) return;
      if (reply.ok) { setCheck(reply.body); setCheckError(null); checkOpen.current = true; }
      else setCheckError(reply.message);
    } catch {
      if (latest.current === base) setCheckError("网络不通，请重试");
    } finally {
      if (latest.current === base) setChecking(false);
    }
  }, [base]);

  /** 存 11 月的补充：成功换上返回的约定；约定其实来自本体（409 AGREEMENT_FROM_WORLD）时重读一次。返回出错的那句话，成功为 null。 */
  const save = useCallback(async (body: TPutTaskAgreementRequest): Promise<string | null> => {
    try {
      const reply = await call<TTaskAgreementResponse>(`${base}/agreement`, json("PUT", body));
      if (!reply.ok) {
        if (reply.code === "AGREEMENT_FROM_WORLD") void load();
        return reply.message;
      }
      setAgreement(reply.body);
      if (checkOpen.current) void runCheck();
      return null;
    } catch {
      return "网络不通，请重试";
    }
  }, [base, load, runCheck]);

  /** 请认可人看第 index 条：推了或今天已推过都算请过；飞书没接时这颗键置灰；这一条已经不是「要 X 确认」时重新对一次。 */
  const notify = useCallback(async (index: number, personId: string): Promise<string | null> => {
    try {
      const reply = await call<TCheckNotifyResponse>(`${base}/check/notify`, json("POST", { index, personId }));
      if (reply.ok) { setAsked((current) => [...current, index]); return null; }
      if (reply.code === "FEISHU_NOT_CONFIGURED") { setFeishuOff(true); return null; }
      if (reply.code === "NOT_AWAITING_ACCEPTOR" || reply.code === "NOT_ACCEPTOR") void runCheck();
      return reply.message;
    } catch {
      return "网络不通，请重试";
    }
  }, [base, runCheck]);

  return { agreement, check, checking, checkError, asked, feishuOff, runCheck, save, notify };
}

export type TaskAgreementApi = ReturnType<typeof useTaskAgreement>;
