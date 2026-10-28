"use client";

/**
 * 通知栏最上面的「N 月任务卡」（10/28 起）：本月任务卡已载入本体，签发看本体里全员 Mission 的生命周期——
 * 右侧「已成立 / 总数」，下面一行各状态的张数，底边细条是已成立的比例。全部成立或本体读不到时不显示。
 * 不再显示从个人复盘起算的 72 小时倒计时（任务卡页的 RoundClock 仍用 useMonthlyCycle）。
 */
import { useEffect, useState, type CSSProperties } from "react";
import { Card as HeroCard } from "@heroui/react";
import type { TMissionCardStatus } from "@warmap/contracts";
import { ContextMark } from "@/components/ContextMark";
import { browserApi } from "@/lib/api/client";
import n from "@/styles/notifications.module.css";
import c from "./cycle-countdown.module.css";

const REFRESH_MS = 5 * 60_000;

function useMissionCardStatus(): TMissionCardStatus | null {
  const [status, setStatus] = useState<TMissionCardStatus | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => void browserApi.GET("/api/mission-cards/world-status")
      .then(({ data }) => { if (live && data) setStatus(data.status); }, () => undefined);
    load();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") load(); }, REFRESH_MS);
    return () => { live = false; window.clearInterval(timer); };
  }, []);
  return status;
}

export function CycleCountdown() {
  const status = useMissionCardStatus();
  if (!status || !status.total || status.settled >= status.total) return null;
  const month = Number(status.period.slice(5));
  const title = `${month} 月任务卡`;
  const detail = status.groups.map((group) => `${group.label} ${group.count}`).join(" · ");
  return <HeroCard<"section"> render={(props) => <section {...props} />} className={n.card} data-notice="cycle" aria-label={`${title}：已成立 ${status.settled} / ${status.total}，${detail}`}>
    <HeroCard.Header<"header"> render={(props) => <header {...props} />} className={`${n.glassHeader} ${c.header}`}>
      <ContextMark kind="mission" className={n.glyph} />
      <span className={n.identity}>
        <strong>{title}</strong>
        <small>{detail}</small>
      </span>
      <span className={c.figure} data-tone="running">{status.settled}/{status.total} 已成立</span>
      <span className={c.track} aria-hidden><span style={{ "--share": status.settled / status.total } as CSSProperties} /></span>
    </HeroCard.Header>
  </HeroCard>;
}
