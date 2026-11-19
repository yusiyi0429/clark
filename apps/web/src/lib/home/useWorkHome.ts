"use client";

/**
 * 新首页的数据（B 的契约 workHome.ts）。GET /api/me/work-home 有就用它；B 的实现没上（404）时由现有数据照同一个形状拼（derive.ts）。
 * live：云端的新首页接口在不在。后台任务、项目对话的验收行、自动分发、项目对话、自动开工、项目的增改都跟着它走两条路之一。
 * 会话、看板、worker 这几份照旧读（项目对话里的派活单、选项框、开工要用），云端接口在时只用来补本机的实时部分。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { TWorkHomeResponse } from "@warmap/contracts";
import { useHomePlan } from "@/components/member/home/useHomePlan";
import { useMemberHome } from "@/components/member/useMemberHome";
import { readWorkHome } from "@/lib/board/cloud";
import { companyMonth } from "@/lib/companyTime";
import { useLocalRunner } from "@/lib/local/LocalRunnerProvider";
import { useMergeIssues } from "@/lib/work/merge";
import { useWork } from "@/lib/work/useWork";
import { withLocalAttention } from "./attention";
import { deriveWorkHome } from "./derive";
import type { WorkHomeData } from "./types";

const POLL_MS = 5000;
/** 接口还没有（404）时隔一会再问一次：B 的实现上线以后，开着的页面不用刷新也能切过去。 */
const RECHECK_MS = 60_000;

/** 云端首页还没问到（第一次还没回、或一直出错）时的首页：项目、等你、本月都空，不拿 Mission 拼。 */
function emptyWorkHome(): WorkHomeData {
  return { period: companyMonth(new Date()), projects: [], archivedCount: 0, month: { missions: [] }, other: { subSessions: [], items: [] }, waiting: [] };
}

export function useWorkHome() {
  const planHook = useHomePlan();
  const [remote, setRemote] = useState<TWorkHomeResponse | null>(null);
  // 项目上挂着的之前月份没了结的 Task 也读看板（派活单、卡、认领开工都要用）。
  const treeTaskIds = useMemo(() => remote?.projects.flatMap((project) => project.goals.map((goal) => goal.taskId)) ?? [], [remote]);
  const projectIds = useMemo(() => remote?.projects.map((project) => project.projectId) ?? [], [remote]);
  const work = useWork({ planHook, extraTaskIds: treeTaskIds, projectIds });
  const member = useMemberHome();
  const merges = useMergeIssues();
  const local = useLocalRunner();
  const deviceId = local.status?.deviceId ?? null;
  /** null：还没问过；false：接口还没有（404）。 */
  const [live, setLive] = useState<boolean | null>(null);

  const loadRemote = useCallback(async () => {
    const data = await readWorkHome().catch(() => undefined);
    if (data === undefined) return;
    setLive(data !== null);
    setRemote(data);
  }, []);
  useEffect(() => {
    if (live === null) void loadRemote();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void loadRemote(); }, live === false ? RECHECK_MS : POLL_MS);
    return () => window.clearInterval(timer);
  }, [loadRemote, live]);

  const notices = useMemo(() => ({ notifications: member.notifications, rounds: member.rounds, unreadThreads: member.unreadThreads, unreadMissionGroups: member.unreadMissionGroups }),
    [member.notifications, member.rounds, member.unreadThreads, member.unreadMissionGroups]);
  const derived = useMemo(() => deriveWorkHome({ plan: work.plan, workers: work.workers, boards: work.boards, proposals: work.proposals, merges, notices, deviceId, sessions: local.sessions }),
    [work.plan, work.workers, work.boards, work.proposals, merges, notices, deviceId, local.sessions]);
  // 云端的等你照契约（设计 9.6：群消息、会后分给你不进）。批准、提问以这台电脑上的会话为准（第 54 条，attention.ts）。
  const here = local.phase === "ready" ? local.sessions : null;
  // 拼出来的只给确认 404 的时候用（live === false）；还没问到时用空的，不先画一份按 Mission 拼的再换。
  const data = useMemo<WorkHomeData>(() => withLocalAttention(remote ?? (live === false ? derived : emptyWorkHome()), here ?? []), [remote, live, derived, here]);

  const refresh = useCallback(async () => { await Promise.all([work.refresh(), member.refresh(), loadRemote()]); }, [work, member, loadRemote]);
  // 计划（Mission / Task，来自本体）读不到：树和首页写「本体读取失败」加「重试」，不画成空树（5.4.2、5.4.4）。
  const planFailed = !work.plan && !!planHook.error;
  // known：云端接口在不在已经知道了（问到过一次）。还不知道（第一次还没回、或一直出错）时不当成「没上」：管线等着、不开假对话，也不走不认领的老开工路。
  return { data, live: live === true, known: live !== null, ready: live !== null && (live || !!work.plan), planFailed, retryPlan: planHook.refresh, work, member, deviceId, refresh };
}

export type WorkHomeApi = ReturnType<typeof useWorkHome>;
