"use client";

/**
 * 网页和本机程序的连接：整个新骨架共用一份（插件页、看板上的「开始」、卡的子会话页都读它）。
 * 没连上时每 4 秒探一次（自动重连）；连上以后每 10 秒刷一次本机的会话列表（看板上「在跑」「等你批准」靠它）。
 * 本机的实时事件只在页面里用，不写云端（第 11.3 节）。
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { TLocalFolder, TLocalModelProfile, TLocalSessionSummary, TLocalStatusResponse } from "./runner";
import { LocalRunnerError, type LocalRunner } from "./runner";
import { createHttpRunner, writeLocalToken } from "./client";
import { createMockRunner } from "./mock";
import { phaseOf, readBrowserPermission, type LocalPhase } from "./connection";
import { HANDHELD_QUERY } from "@/components/ui/useHandheld";
import { setMockAgents } from "@/lib/board/cards";
import { planCards } from "@/lib/board/cloud";

export type Pairing = { code: string; state: "waiting" | "denied" | "expired" | "failed" };

export type LocalRunnerState = {
  runner: LocalRunner;
  phase: LocalPhase;
  version: string | null;
  status: TLocalStatusResponse | null;
  models: TLocalModelProfile[];
  folders: TLocalFolder[];
  sessions: TLocalSessionSummary[];
  pairing: Pairing | null;
  /** 最近一次动作出的错（配对、选文件夹），给插件页显示。 */
  error: string | null;
  refresh: () => Promise<void>;
  pair: () => Promise<void>;
  unpair: () => Promise<void>;
  pickFolder: () => Promise<TLocalFolder | null>;
  setIncludePersonal: (value: boolean) => Promise<void>;
};

/** 测试里直接给一份连接状态。 */
export const LocalContext = createContext<LocalRunnerState | null>(null);

const PROMPT_WAIT_MS = 1200;
const RETRY_MS = 4000;
const MAX_RETRY_MS = 60_000;
const LIVE_MS = 10_000;

/** NEXT_PUBLIC_LOCAL_RUNNER=mock 用假程序；开发环境里也可以在地址上带 ?local=mock 切过去（存在本标签页）。 */
function pickRunner(): LocalRunner {
  let mock = process.env.NEXT_PUBLIC_LOCAL_RUNNER === "mock";
  if (!mock && process.env.NODE_ENV !== "production" && typeof window !== "undefined") {
    try {
      const asked = new URLSearchParams(window.location.search).get("local");
      if (asked) sessionStorage.setItem("tianshu-local-runner", asked);
      mock = sessionStorage.getItem("tianshu-local-runner") === "mock";
    } catch { /* 存不了就按环境变量 */ }
  }
  return mock ? sharedMock() : createHttpRunner();
}
let mockRunner: LocalRunner | null = null;
// 假规划员拆完时，用云端拆卡出一份派活单草稿（假装本机把 card_plan 同步上去了）。
const sharedMock = () => (mockRunner ??= createMockRunner({ onPlanned: (taskId) => void planCards(taskId).catch(() => undefined) }));

export function LocalRunnerProvider({ children, runner: given }: { children: ReactNode; runner?: LocalRunner }) {
  const [runner] = useState<LocalRunner>(() => given ?? pickRunner());
  useEffect(() => { setMockAgents(runner.kind === "mock" && !given); return () => setMockAgents(false); }, [runner, given]);
  const [phase, setPhase] = useState<LocalPhase>("checking");
  const [version, setVersion] = useState<string | null>(null);
  const [status, setStatus] = useState<TLocalStatusResponse | null>(null);
  const [models, setModels] = useState<TLocalModelProfile[]>([]);
  const [folders, setFolders] = useState<TLocalFolder[]>([]);
  const [sessions, setSessions] = useState<TLocalSessionSummary[]>([]);
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const alive = useRef(true);
  const inFlight = useRef<Promise<void> | null>(null);

  const loadPaired = useCallback(async () => {
    const [nextStatus, nextModels, nextFolders, nextSessions] = await Promise.all([runner.status(), runner.listModels(), runner.listFolders(), runner.listSessions()]);
    if (!alive.current) return;
    setStatus(nextStatus);
    setModels(nextModels);
    setFolders(nextFolders);
    setSessions(nextSessions);
  }, [runner]);

  const refresh = useCallback(() => {
    if (inFlight.current) return inFlight.current;
    inFlight.current = (async () => {
      let settled = false;
      const health = runner.health().then((value) => { settled = true; return value; }, (cause: unknown) => { settled = true; throw cause; });
      // 浏览器在问授权时 fetch 会一直挂着：等一会儿还没回来，就按授权状态先亮「等授权」。
      const early = window.setTimeout(() => {
        if (!settled) void readBrowserPermission().then((permission) => { if (!settled && alive.current) setPhase(phaseOf({ health: "waiting", permission })); });
      }, PROMPT_WAIT_MS);
      try {
        const result = await health;
        if (!alive.current) return;
        setVersion(result.version);
        const next = phaseOf({ health: "ok", tokenValid: result.tokenValid, permission: "granted" });
        if (next === "ready") await loadPaired();
        else { setStatus(null); setSessions([]); }
        setPhase(next);
      } catch {
        if (!alive.current) return;
        setPhase(phaseOf({ health: "failed", permission: await readBrowserPermission() }));
        setStatus(null);
        setSessions([]);
      } finally {
        window.clearTimeout(early);
        inFlight.current = null;
      }
    })();
    return inFlight.current;
  }, [runner, loadPaired]);

  // 手机和触屏上不连本机（第 13 节：手机只看）：不探，免得一直报连不上。
  const [handheld] = useState(() => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(HANDHELD_QUERY).matches);
  useEffect(() => {
    alive.current = true;
    if (handheld && !given) setPhase("offline");
    else void refresh();
    return () => { alive.current = false; };
  }, [refresh, handheld, given]);

  // 没连上就隔一阵再探（本机程序刚装好、刚在站点设置里改回允许），连着没连上就越隔越久（最长 1 分钟）；
  // 连上了每 10 秒刷一次会话列表。回到前台、切回窗口立刻探一次。
  const misses = useRef(0);
  useEffect(() => {
    if (handheld && !given) return;
    if (phase === "offline" || phase === "blocked") misses.current++;
    else misses.current = 0;
    const delay = phase === "ready" ? LIVE_MS : phase === "offline" || phase === "blocked" ? Math.min(MAX_RETRY_MS, RETRY_MS * 2 ** Math.max(0, misses.current - 1)) : RETRY_MS;
    const timer = window.setTimeout(() => { if (document.visibilityState === "visible") void refresh().then(() => setTick((n) => n + 1)); else setTick((n) => n + 1); }, delay);
    const resume = () => { if (document.visibilityState === "visible") { misses.current = 0; void refresh(); } };
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("focus", resume);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("focus", resume);
    };
  }, [phase, tick, refresh, handheld, given]);

  const pair = useCallback(async () => {
    setError(null);
    try {
      const started = await runner.startPairing("天枢网页");
      setPairing({ code: started.code, state: "waiting" });
      const until = Date.parse(started.expiresAt) || Date.now() + 120_000;
      while (alive.current && Date.now() < until) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const answer = await runner.pairingStatus(started.pairingId);
        if (answer.status === "approved" && answer.token) {
          if (runner.kind === "http") writeLocalToken(answer.token);
          setPairing(null);
          await refresh();
          return;
        }
        if (answer.status !== "pending") { setPairing({ code: started.code, state: answer.status === "denied" ? "denied" : "expired" }); return; }
      }
      setPairing({ code: started.code, state: "expired" });
    } catch (cause) {
      setPairing(null);
      setError(cause instanceof LocalRunnerError ? cause.message : "配对没成功，请重试");
    }
  }, [runner, refresh]);

  const unpair = useCallback(async () => {
    try { await runner.unpair(); } catch { /* 口令已失效也照样清掉 */ }
    if (runner.kind === "http") writeLocalToken(null);
    await refresh();
  }, [runner, refresh]);

  const pickFolder = useCallback(async () => {
    setError(null);
    try {
      const folder = await runner.pickFolder();
      setFolders(await runner.listFolders());
      return folder;
    } catch (cause) {
      setError(cause instanceof LocalRunnerError ? cause.message : "没选上，请重试");
      return null;
    }
  }, [runner]);

  const setIncludePersonal = useCallback(async (value: boolean) => {
    await runner.patchSettings({ includePersonalConfigByDefault: value });
    await refresh();
  }, [runner, refresh]);

  const value = useMemo<LocalRunnerState>(() => ({ runner, phase, version, status, models, folders, sessions, pairing, error, refresh, pair, unpair, pickFolder, setIncludePersonal }),
    [runner, phase, version, status, models, folders, sessions, pairing, error, refresh, pair, unpair, pickFolder, setIncludePersonal]);
  return <LocalContext.Provider value={value}>{children}</LocalContext.Provider>;
}

export function useLocalRunner(): LocalRunnerState {
  const value = useContext(LocalContext);
  if (!value) throw new Error("useLocalRunner 要放在 LocalRunnerProvider 里");
  return value;
}

/** 这张卡（或专题）在本机上最近的那个执行会话（同卡的验收员不算）。 */
export function latestSessionFor(sessions: TLocalSessionSummary[], subject: { cardId?: string; topicId?: string }): TLocalSessionSummary | null {
  return sessions.find((session) => (subject.cardId ? session.subject.kind === "card" && session.subject.cardId === subject.cardId
    : session.subject.kind === "topic" && session.subject.topicId === subject.topicId)) ?? null;
}
