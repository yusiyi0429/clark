"use client";

/** 会议页（/me/work/meetings/<id>）：老界面的成员会议屏幕原样挂进展示区，只换外壳。 */
import { useEffect, useMemo, useState } from "react";
import { MemberMeetingDetail } from "@/cards/MeetingCard";
import { browserApi, type Card } from "@/lib/api/client";
import { WorkspaceContext, useWorkspace } from "@/components/shell/WorkspaceContext";
import { HOME_HREF } from "@/lib/home/derive";
import h from "@/styles/home.module.css";
import m from "@/styles/meeting-view.module.css";

export function MeetingView({ id, go }: { id: string; go: (href: string) => void }) {
  const [loaded, setLoaded] = useState<{ id: string; card: Card | null } | null>(null);
  useEffect(() => {
    let alive = true;
    void browserApi.GET("/api/me/cards/meetings/{id}", { params: { path: { id } } }).then(({ data, response }) => {
      if (response.status === 401) { window.location.assign("/access"); return; }
      if (alive) setLoaded({ id, card: data ?? null });
    }, () => { if (alive) setLoaded({ id, card: null }); });
    return () => { alive = false; };
  }, [id]);
  // 会议屏幕的「返回」和取消会议后关页走 workspace.close：在新首页里就是返回上一页，没有上一页回首页。
  const workspace = useWorkspace();
  const inner = useMemo(() => ({ ...workspace, close: () => (window.history.length > 1 ? window.history.back() : go(HOME_HREF)) }), [workspace, go]);
  const card = loaded?.id === id ? loaded.card : null;
  if (!card) return <div className={h.missing} aria-busy={!loaded || loaded.id !== id || undefined}>{loaded?.id === id ? <p>没有这场会议</p> : null}</div>;
  return <WorkspaceContext.Provider value={inner}><div className={m.root}><MemberMeetingDetail card={card} /></div></WorkspaceContext.Provider>;
}
