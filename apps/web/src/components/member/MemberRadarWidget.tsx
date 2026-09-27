"use client";

import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { HeroButton } from "@/components/HeroButton";
import { browserApi } from "@/lib/api/client";
import {
  RADAR_COPY,
  failureReason,
  goToAccess,
  personalSignalHref,
  radarBriefStatus,
  scanActive,
  signalWhen,
  type MemberRadarBrief,
} from "@/components/radar/personalRadar";
import s from "./member-home-widgets.module.css";

type Navigate = (href: string, origin?: Element | null) => void;

/**
 * 首页的雷达小组件（开着雷达时才有，放进 03 留的整行宽插槽）：标题旁写最近一次扫描的状态，
 * 最多 3 条最相关的（标题、来源、时间、一句理由），「全部」进我的雷达。
 * 扫描失败、第一次还没扫完、扫完没有结果，三种情况各写各的。
 */
export function MemberRadarWidget({ radar, onNavigate, onRefresh }: { radar: MemberRadarBrief; onNavigate: Navigate; onRefresh: () => void }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const run = radar.lastRun;
  const failed = run?.status === "failed";
  const now = Date.now();

  async function retry() {
    setBusy(true);
    setNote(null);
    try {
      const { error, response } = await browserApi.POST("/api/me/radar/scan");
      if (response.status === 401) return goToAccess();
      if (response.status === 202) return onRefresh();
      // 409／429（正在扫、今天收满、10 分钟冷却）原样写服务端的话。
      setNote((error as { message?: string } | undefined)?.message ?? "没能开始扫描，请稍后再试。");
    } catch {
      setNote("网络连接失败，请再试一次。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className={s.heading}>
        <h2>雷达</h2>
        <HeroButton variant="ghost" className={s.allLink} aria-label="查看全部雷达信号" data-origin="/me/radar" onPress={(event) => onNavigate("/me/radar", event.target as Element)}>
          全部
          <ChevronRight size={16} aria-hidden />
        </HeroButton>
      </div>
      <p className={s.radarStatus} data-tone={failed ? "error" : undefined}>
        {radarBriefStatus(radar, now)}
      </p>
      {failed && run ? (
        <div className={s.radarFailure} role="alert">
          <p>{failureReason(run)}</p>
          <HeroButton variant="ghost" size="sm" className={s.retry} aria-label="重试雷达扫描" isDisabled={busy} onPress={() => void retry()}>
            重试
          </HeroButton>
        </div>
      ) : null}
      {note ? <p className={s.radarNote}>{note}</p> : null}
      {radar.highlights.length ? (
        <ul className={s.highlights} aria-label="雷达最近的信号">
          {radar.highlights.map((signal) => {
            const href = personalSignalHref(signal.id);
            return (
              <li key={signal.id}>
                <HeroButton
                  variant="ghost"
                  className={s.signal}
                  data-origin={href}
                  aria-label={`阅读：${signal.source.title}${signal.state.read ? "" : "（未读）"}`}
                  onPress={(event) => onNavigate(href, event.target as Element)}
                >
                  <span className={s.signalMeta}>
                    {signal.state.read ? null : <i className={s.unread} aria-hidden />}
                    <span>
                      {signal.source.label} · {signalWhen(signal, now)}
                    </span>
                  </span>
                  <span className={s.signalTitle}>{signal.source.title}</span>
                  <span className={s.signalReason}>{signal.reason}</span>
                </HeroButton>
              </li>
            );
          })}
        </ul>
      ) : failed ? null : (
        <p className={s.empty}>{!run || scanActive(run) ? RADAR_COPY.firstScan : RADAR_COPY.empty}</p>
      )}
    </>
  );
}
