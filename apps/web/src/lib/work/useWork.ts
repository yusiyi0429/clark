"use client";

/**
 * 新首页（/me/work）的数据：本月计划（Mission、Task、验收时间点）、云端的 worker 列表和资源摘要（GET /api/me/workers）、
 * 每个 Task 的看板（草稿、最近一次拆卡、卡的交回和交付物、下一版的号）、岗位和待确认的岗位修改、本机的连接和会话。
 * 前台时 worker 和看板 10 秒一次（有拆卡在跑时 3 秒），岗位 30 秒一次；本机会话由本机实时推，合进 worker。
 * 规划员（本机的 plan 会话和登记了还没开的拆卡）也合进 worker；规划员退出时马上重取看板，派活单接着出。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TLocalDeviceView, TWorkersResponse } from "@warmap/contracts";
import type { useHomePlan } from "@/components/member/home/useHomePlan";
import { useLocalRunner } from "@/lib/local/LocalRunnerProvider";
import { listDevices, readBoard, readWorkers } from "@/lib/board/cloud";
import { fallbackBoard, type TaskBoard } from "@/lib/board/useTaskBoard";
import type { CardItem } from "@/lib/board/cards";
import { listProposals, listRoles, type RoleListResponse, type RoleProposalView } from "@/lib/team/roles";
import { subjectOf } from "@/lib/local/kinds";
import { readSplits, type SplitRequest } from "./splits";
import { liveSessions, plannerWorkers, toWorker, type Worker } from "./workers";

export type Resources = {
  local: { online: boolean; name: string | null; used: number; cap: number };
  models: { key: "subscription" | "codex" | "gateway"; label: string; on: boolean }[];
  todayUsd: number | null;
};

export function useWork({ planHook }: { planHook: ReturnType<typeof useHomePlan> }) {
  const { plan, refresh: refreshPlan } = planHook;
  const local = useLocalRunner();
  const [boards, setBoards] = useState<Record<string, TaskBoard>>({});
  const [listed, setListed] = useState<TWorkersResponse | null>(null);
  const [roles, setRoles] = useState<RoleListResponse | null>(null);
  const [proposals, setProposals] = useState<RoleProposalView[]>([]);
  const [devices, setDevices] = useState<TLocalDeviceView[]>([]);
  const [splits, setSplits] = useState<SplitRequest[]>([]);
  const loading = useRef(false);
  const taskIds = useMemo(() => plan?.tasks.map((task) => task.taskId) ?? [], [plan]);

  const load = useCallback(async () => {
    if (!plan || loading.current) return;
    loading.current = true;
    try {
      const [entries, workers] = await Promise.all([
        Promise.all(plan.tasks.map(async (task) => {
          const data = await readBoard(task.taskId).catch(() => undefined);
          const board: TaskBoard | null = data ? { ...data, fallback: false } : fallbackBoard(plan, task.taskId);
          return [task.taskId, board] as const;
        })),
        readWorkers().catch(() => undefined),
      ]);
      setBoards(Object.fromEntries(entries.filter((entry): entry is readonly [string, TaskBoard] => !!entry[1])));
      if (workers !== undefined) setListed(workers);
      setSplits(await readSplits());
    } finally {
      loading.current = false;
    }
  }, [plan]);
  const loadRoles = useCallback(async () => {
    try { setRoles(await listRoles()); setProposals(await listProposals()); } catch { /* 留着上次的 */ }
  }, []);

  const planning = Object.values(boards).some((board) => board.plan?.status === "queued" || board.plan?.status === "running");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [taskIds.join("|")]);
  useEffect(() => {
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, planning ? 3000 : 10_000);
    return () => window.clearInterval(timer);
  }, [load, planning]);
  useEffect(() => {
    void loadRoles();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void loadRoles(); }, 30_000);
    return () => window.clearInterval(timer);
  }, [loadRoles]);
  useEffect(() => { void listDevices().then(setDevices).catch(() => undefined); }, [local.status?.cloud.linked]);

  const ready = local.phase === "ready";
  const sessions = useMemo(() => (ready ? local.sessions : []), [ready, local.sessions]);
  const deviceName = devices.find((device) => device.id === local.status?.deviceId)?.name ?? (ready ? "这台电脑" : null);
  const planKey = sessions.filter((session) => subjectOf(session).kind === "plan" && session.status !== "exited").map((session) => session.id).join("|");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [planKey]);

  // 这台电脑上挂着的权限请求：等你批准的行写「要运行 …」。
  const [asks, setAsks] = useState<Record<string, Worker["ask"]>>({});
  const askKey = sessions.filter((session) => session.pendingPermissions > 0).map((session) => `${session.id}:${session.lastSeq}`).join("|");
  useEffect(() => {
    const waiting = sessions.filter((session) => session.pendingPermissions > 0);
    if (!waiting.length) { setAsks({}); return; }
    let alive = true;
    void Promise.all(waiting.map(async (session) => {
      const request = (await local.runner.getSession(session.id).catch(() => null))?.pendingPermissions[0];
      const command = request && typeof request.input.command === "string" ? request.input.command : null;
      return [session.id, request ? { text: request.title, command } : null] as const;
    })).then((entries) => { if (alive) setAsks(Object.fromEntries(entries)); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [askKey]);

  const cards = useMemo(() => {
    const map = new Map<string, CardItem>();
    for (const board of Object.values(boards)) for (const card of board.cards) map.set(card.id, card);
    return map;
  }, [boards]);
  const tasks = useMemo(() => plan?.tasks ?? [], [plan]);
  const workers = useMemo(() => [
    ...(listed ? [...listed.running, ...listed.queued, ...listed.done] : []).map((entry) => toWorker(entry, { sessions, cards, deviceName })),
    ...plannerWorkers({ sessions, splits, tasks, deviceName }),
  ].map((worker) => ({ ...worker, ask: worker.mark === "approval" && worker.session ? asks[worker.session.id] ?? null : null })),
  [listed, sessions, splits, tasks, cards, deviceName, asks]);

  const slots = local.status?.slots ?? null;
  const resources: Resources = {
    local: {
      online: ready || (listed?.resources.devices.some((device) => device.online) ?? false),
      name: deviceName ?? listed?.resources.devices.find((device) => device.online)?.name ?? null,
      used: slots?.running ?? (ready ? liveSessions(sessions).length : listed?.resources.running ?? 0),
      cap: slots?.max ?? listed?.resources.cap ?? 3,
    },
    models: [
      { key: "subscription", label: "Claude 订阅", on: local.models.some((model) => model.source === "subscription" && model.agent === "claude-code") },
      { key: "codex", label: "Codex 订阅", on: local.models.some((model) => model.agent === "codex") },
      { key: "gateway", label: "TokenHub", on: local.models.some((model) => model.source === "gateway") },
    ],
    todayUsd: listed?.resources.cost.today.costUsd ?? null,
  };

  const refresh = useCallback(async () => { await Promise.all([load(), local.refresh(), loadRoles()]); }, [load, local, loadRoles]);
  return { plan, boards, workers, splits, resources, roles, proposals, today: plan?.today ?? null, refresh, refreshPlan, refreshRoles: loadRoles };
}

export type WorkData = ReturnType<typeof useWork>;
