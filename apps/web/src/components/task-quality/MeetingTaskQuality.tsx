"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { TaskQualityWorkbench } from "./TaskQualityWorkbench";
import { readTaskQualityEnabled } from "./taskQualityStatus";

export function MeetingTaskQuality({ meetingId, revision }: { meetingId: string; revision: number | null }) {
  const [open, setOpen] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const path = usePathname();
  useEffect(() => {
    let alive = true;
    void readTaskQualityEnabled().then(value => { if (alive) setEnabled(value); });
    return () => { alive = false; };
  }, []);
  if (!enabled || revision === null) return null;
  return <details onToggle={e => setOpen(e.currentTarget.open)}>
    <summary>核对会议结论与任务缺口</summary>
    {open && <TaskQualityWorkbench key={revision} viewerRole={path.startsWith("/me") ? "member" : "ceo"} meetingId={meetingId} />}
  </details>;
}
