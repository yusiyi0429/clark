"use client";

import { ChevronRight } from "lucide-react";
import { HeroButton } from "@/components/HeroButton";
import type { MemberRadarBrief } from "@/components/radar/personalRadar";
import r from "@/styles/radar.module.css";
import s from "./member-home-widgets.module.css";

type Navigate = (href: string, origin?: Element | null) => void;

/** 成员首页的雷达入口；具体信号在雷达页阅读。 */
export function MemberRadarWidget({ radar, onNavigate }: { radar: MemberRadarBrief; onNavigate: Navigate }) {
  const status = radar.lastRun?.status === "running" || radar.lastRun?.status === "queued"
    ? "正在扫描"
    : radar.unreadCount > 0 ? `${radar.unreadCount} 条未读` : "看看外面的变化";

  return <HeroButton variant="ghost" size="sm" type="button" className={`${r.radar} ${s.radarCard}`}
    data-origin="/me/radar" aria-label={`雷达信号，${status}`} onPress={(event) => onNavigate("/me/radar", event.target as Element)}>
    <h2>雷达信号</h2>
    <small className={s.radarStatus}>{status}</small>
    <div className={`${r.stage} ${s.scanStage}`} aria-hidden="true">
      <div className={r.scope}>
        <span className={r.crosshair} />
        <span className={r.sweep} />
        <div><i className={r.echo} /><i className={r.echo} /><i className={r.echo} /></div>
        <span className={r.center} />
      </div>
    </div>
    <ChevronRight className={r.launch} size={16} aria-hidden="true" />
  </HeroButton>;
}
