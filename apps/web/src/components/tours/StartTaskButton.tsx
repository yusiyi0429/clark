"use client";

import { useRef, useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "ts-design/primitives";
import { useSeenMarks } from "@/lib/useSeenMarks";
import { EXECUTION_TOUR_KEY, ExecutionItemsTour, type TourExit } from "./ExecutionItemsTour";
import x from "./execution-tour.module.css";

/** 新建页地址：从某个 Task 里点的，带上它的 Mission 和 Task，新建页预先选好。 */
function startTaskHref(missionId?: string, taskId?: string): string {
  if (!missionId) return "/me/tasks/new";
  return `/me/tasks/new?${new URLSearchParams({ missionId, ...(taskId ? { taskId } : {}) })}`;
}

/**
 * 「开启执行事项」：没看过演示的人按钮带呼吸光和「新」，第一次点先放演示，看完再进创建页。
 * 放在某个 Task 的「我的事项」那一行时传 missionId、taskId，建出来的事项就挂在这个 Task 下。
 */
export function StartTaskButton({ onNavigate, missionId, taskId }: { onNavigate?: (href: string, origin?: Element | null) => void; missionId?: string; taskId?: string }) {
  const { seen, mark } = useSeenMarks();
  const href = startTaskHref(missionId, taskId);
  const fresh = seen !== null && !seen.has(EXECUTION_TOUR_KEY);
  const [touring, setTouring] = useState(false);
  const origin = useRef<Element | null>(null);
  const exit = (how: TourExit) => {
    mark(EXECUTION_TOUR_KEY);
    setTouring(false);
    if (how === "start") onNavigate?.(href, origin.current);
  };
  return <>
    <span className={x.startWrap} data-fresh={fresh}>
      <Button variant="ghost" size="sm" onPress={(event) => {
        origin.current = event.target as Element;
        if (fresh) setTouring(true);
        else onNavigate?.(href, event.target);
      }}><Plus size={15} aria-hidden />开启执行事项{fresh ? <span className={x.newBadge}>新</span> : null}</Button>
    </span>
    {touring ? <ExecutionItemsTour isOpen onExit={exit} /> : null}
  </>;
}
