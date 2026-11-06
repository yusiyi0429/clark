"use client";

/**
 * 新首页的数据（第 7 节草案的形状）。B 的 GET /api/me/work-home 到之前由现有数据拼（derive.ts）：
 * 本月计划、worker（云端列表合本机实时会话）、通知、岗位建议、合不回的卡。换成 B 的接口时只换这里的来源，组件不动。
 * 后台任务（GET /api/me/background 草案）同样在这里按展示区的范围取。
 */
import { useCallback, useMemo } from "react";
import { useHomePlan } from "@/components/member/home/useHomePlan";
import { useMemberHome } from "@/components/member/useMemberHome";
import { useHandheld } from "@/components/ui/useHandheld";
import { useLocalRunner } from "@/lib/local/LocalRunnerProvider";
import { useMergeIssues } from "@/lib/work/merge";
import { useWork } from "@/lib/work/useWork";
import { backgroundItems, deriveWorkHome } from "./derive";
import type { BackgroundItem, BackgroundScope } from "./types";

type MockChild = BackgroundItem & { taskId: string | null; cardId: string | null; topicId: string | null };

export function useWorkHome() {
  const planHook = useHomePlan();
  const work = useWork({ planHook });
  const member = useMemberHome();
  const merges = useMergeIssues();
  const local = useLocalRunner();
  const handheld = useHandheld();
  const data = useMemo(() => deriveWorkHome({
    plan: work.plan, workers: work.workers, boards: work.boards, proposals: work.proposals, merges,
    notices: { notifications: member.notifications, rounds: member.rounds, unreadThreads: member.unreadThreads, unreadMissionGroups: member.unreadMissionGroups },
  }), [work.plan, work.workers, work.boards, work.proposals, merges, member.notifications, member.rounds, member.unreadThreads, member.unreadMissionGroups]);

  // 子会话里 Claude Code 开的子 agent、后台命令：本机程序还没报（D 在做）。用假本机程序时照它的卡会话补两种各一条，好看出样子。
  const mockChildren = useMemo<MockChild[]>(() => {
    if (local.runner.kind !== "mock") return [];
    return local.sessions.flatMap((session): MockChild[] => {
      const cardId = session.subject.kind === "card" ? session.subject.cardId ?? null : null;
      if (!cardId) return [];
      const taskId = work.workers.find((worker) => worker.cardId === cardId)?.taskId ?? null;
      const live = session.status === "running" || session.status === "starting" || session.status === "waiting_permission";
      const ended = session.status === "exited" || session.status === "failed";
      if (!live && !ended) return [];
      return [
        { id: `cmd:${session.id}`, kind: "command", title: "pnpm test", state: live ? "running" : "done", startedAt: session.createdAt, finishedAt: live ? null : session.updatedAt, stoppable: false, taskId, cardId, topicId: null },
        ...(ended ? [{ id: `sub:${session.id}`, kind: "subagent" as const, title: "读相关代码", state: "done" as const, startedAt: session.createdAt, finishedAt: session.updatedAt, stoppable: false, taskId, cardId, topicId: null }] : []),
      ];
    });
  }, [local.runner.kind, local.sessions, work.workers]);

  const canStop = local.phase === "ready" && !handheld;
  const background = useCallback((scope: BackgroundScope) => backgroundItems({ workers: work.workers, scope, canStop, mockChildren }), [work.workers, canStop, mockChildren]);
  const refresh = useCallback(async () => { await Promise.all([work.refresh(), member.refresh()]); }, [work, member]);
  return { data, work, member, background, refresh };
}

export type WorkHomeApi = ReturnType<typeof useWorkHome>;
