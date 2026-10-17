"use client";

import { useRef, useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "ts-design/primitives";
import { useSeenMarks } from "@/lib/useSeenMarks";
import { EXECUTION_TOUR_KEY, ExecutionItemsTour, type TourExit } from "./ExecutionItemsTour";
import x from "./execution-tour.module.css";

/** 「开启执行事项」：没看过演示的人按钮带呼吸光和「新」，第一次点先放演示，看完再进创建页。 */
export function StartTaskButton({ onNavigate }: { onNavigate?: (href: string, origin?: Element | null) => void }) {
  const { seen, mark } = useSeenMarks();
  const fresh = seen !== null && !seen.has(EXECUTION_TOUR_KEY);
  const [touring, setTouring] = useState(false);
  const origin = useRef<Element | null>(null);
  const exit = (how: TourExit) => {
    mark(EXECUTION_TOUR_KEY);
    setTouring(false);
    if (how === "start") onNavigate?.("/me/tasks/new", origin.current);
  };
  return <>
    <span className={x.startWrap} data-fresh={fresh}>
      <Button variant="ghost" size="sm" onPress={(event) => {
        origin.current = event.target as Element;
        if (fresh) setTouring(true);
        else onNavigate?.("/me/tasks/new", event.target);
      }}><Plus size={15} aria-hidden />开启执行事项{fresh ? <span className={x.newBadge}>新</span> : null}</Button>
    </span>
    {touring ? <ExecutionItemsTour isOpen onExit={exit} /> : null}
  </>;
}
