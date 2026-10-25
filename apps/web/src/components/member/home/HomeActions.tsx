"use client";

/**
 * 成员首页顶行右边的快捷卡（样稿 home-layout-v9）：方块按钮，字居中——约会议、等回复、战场进展、雷达，复盘窗口期再多一个复盘。
 * 平时 2×2；多出复盘时 2 列 × 3 行，仍在同一个正方形里；主区窄时（见 home-plan 样式）排成一排小方块，放不下就换行。
 * 等回复在右侧浮出请求列表（先开「发出的」，面板由首页挂），右上角是条数；战场进展进原来那张战场进展页（/me/progress）。
 * 雷达只在本人雷达开着时出（首页数据里 radar 不为空），有未读信号时右上角红点，进我的雷达页（/me/radar）。
 * 复盘按公司时区的今天（计划里的 today）算：本月倒数第 3 天到月底复盘本月，下月 1–7 日复盘上个月，这段时间出一格去 M2 的链接，其余时间不出。
 * 前四格右下角各一件釉色小物件（纯装饰，读屏不读），意思同按钮；悬停、键盘聚焦时动一下，见样式。
 */
import type { ReactNode } from "react";
import { Plus } from "lucide-react";
import { buttonVariants } from "@heroui/react";
import { Button } from "ts-design/primitives";
import type { Navigate } from "./planFormat";
import s from "@/styles/home-actions.module.css";

const PROGRESS = "/me/progress";
const RADAR = "/me/radar";

/** 角落小物件画在 80×80 里，自带渐变和高光；大小、位置、悬停时的动作由样式给。渐变 id 带 ha- 前缀，免得和页面上别的 svg 撞。 */
function Motif({ children }: { children: ReactNode }) {
  return <svg className={s.motif} viewBox="0 0 80 80" aria-hidden="true" focusable="false">{children}</svg>;
}

/**
 * 釉色小物件（样稿 quick-art-v1 方向 A）：柔和渐变、顶部一道高光、很淡的投影，像捏出来的瓷片。
 * 约会议：一页日历带个小钟（蓝底上用半透明白）；等回复：前后两个气泡，前面那个带省略号；
 * 战场进展：两层山坡、一条小路、山头一面旗；雷达：三道同心圆、一束扫过的光和一个光点。
 */
const MOTIFS = {
  meeting: (
    <Motif>
      <defs>
        <linearGradient id="ha-meet-page" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#fff" stopOpacity=".55" /><stop offset="1" stopColor="#fff" stopOpacity=".18" /></linearGradient>
        <linearGradient id="ha-meet-clock" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#fff" stopOpacity=".9" /><stop offset="1" stopColor="#dbe7ff" stopOpacity=".55" /></linearGradient>
      </defs>
      <g className={s.page}>
        <rect x="12" y="20" width="46" height="44" rx="10" fill="url(#ha-meet-page)" />
        <rect x="12" y="20" width="46" height="13" rx="10" fill="#fff" fillOpacity=".35" />
        <rect x="22" y="14" width="5" height="12" rx="2.5" fill="#fff" fillOpacity=".7" />
        <rect x="43" y="14" width="5" height="12" rx="2.5" fill="#fff" fillOpacity=".7" />
      </g>
      <circle cx="58" cy="58" r="16" fill="url(#ha-meet-clock)" />
      <path className={s.hands} d="M58 50v8l5 3" fill="none" stroke="#3f74ee" strokeOpacity=".55" strokeWidth="2.4" strokeLinecap="round" />
    </Motif>
  ),
  waiting: (
    <Motif>
      <defs>
        <linearGradient id="ha-wait-back" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#e7ebff" /><stop offset="1" stopColor="#c9d3f5" /></linearGradient>
        <linearGradient id="ha-wait-front" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#fff" /><stop offset="1" stopColor="#eef1f6" /></linearGradient>
        <filter id="ha-wait-shadow" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="3" stdDeviation="3" floodColor="#29334c" floodOpacity=".12" /></filter>
      </defs>
      <path d="M30 18h30a10 10 0 0 1 10 10v14a10 10 0 0 1-10 10h-4l2 9-11-9H30a10 10 0 0 1-10-10V28a10 10 0 0 1 10-10z" fill="url(#ha-wait-back)" opacity=".8" />
      <path d="M18 32h30a10 10 0 0 1 10 10v14a10 10 0 0 1-10 10H32l-11 9 2-9h-5A10 10 0 0 1 8 56V42a10 10 0 0 1 10-10z" fill="url(#ha-wait-front)" filter="url(#ha-wait-shadow)" />
      <circle className={s.dot} cx="23" cy="49" r="2.6" fill="#9aa6bb" />
      <circle className={s.dot} cx="33" cy="49" r="2.6" fill="#b3bccc" />
      <circle className={s.dot} cx="43" cy="49" r="2.6" fill="#ccd3de" />
    </Motif>
  ),
  progress: (
    <Motif>
      <defs>
        <linearGradient id="ha-hill-near" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#dfe7e1" /><stop offset="1" stopColor="#c5d3cb" /></linearGradient>
        <linearGradient id="ha-hill-far" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#eef2f6" /><stop offset="1" stopColor="#d9e0ea" /></linearGradient>
      </defs>
      <path d="M0 80C10 58 22 48 38 46c10-1 20 4 42 22v12z" fill="url(#ha-hill-far)" />
      <path d="M14 80c8-16 18-26 32-30 12-3 22 2 34 12v18z" fill="url(#ha-hill-near)" />
      <path className={s.trail} d="M26 74c6-6 12-10 20-12" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
      <path d="M47 50V28" stroke="#8a96a8" strokeWidth="2" strokeLinecap="round" />
      <path className={s.flag} d="M48 28l13 4-13 5z" fill="#d98c6b" fillOpacity=".85" />
    </Motif>
  ),
  radar: (
    <Motif>
      <defs>
        <radialGradient id="ha-radar-glow" cx="1" cy="1" r="1"><stop offset="0" stopColor="#e6edf7" /><stop offset="1" stopColor="#f6f8fb" stopOpacity="0" /></radialGradient>
        <linearGradient id="ha-radar-beam" x1="1" y1="1" x2="0" y2="0"><stop offset="0" stopColor="#7fa4d8" stopOpacity=".55" /><stop offset="1" stopColor="#7fa4d8" stopOpacity="0" /></linearGradient>
      </defs>
      <circle cx="76" cy="76" r="68" fill="url(#ha-radar-glow)" />
      <g fill="none" stroke="#b9c4d4" strokeWidth="1"><circle cx="76" cy="76" r="22" /><circle cx="76" cy="76" r="44" /><circle cx="76" cy="76" r="66" /></g>
      <path className={s.sweep} d="M76 76L22 34A68 68 0 0 1 52 12z" fill="url(#ha-radar-beam)" />
      <circle cx="40" cy="38" r="7" fill="#5f84bd" fillOpacity=".15" />
      <circle cx="40" cy="38" r="3.2" fill="#5f84bd" />
    </Motif>
  ),
};

/** 复盘窗口开着时复盘的是哪个月；没开为 null。 */
export function reviewMonth(today: string): number | null {
  const [year, month, day] = today.split("-").map(Number);
  if (day <= 7) return month === 1 ? 12 : month - 1;
  return day >= new Date(Date.UTC(year, month, 0)).getUTCDate() - 2 ? month : null;
}

export function HomeActions({ waitingReplies, radarUnread, today, m2Available, onBookMeeting, onOpenRequests, onNavigate }: {
  waitingReplies: number;
  /** 本人雷达的未读条数；雷达关着（或首页数据还没读到）时为 null，不出雷达。 */
  radarUnread: number | null;
  /** 计划还没读到时为 null，这时不出复盘。 */
  today: string | null;
  m2Available: boolean;
  /** 工作台没有登录人时为空（测试桩），不出约会议。 */
  onBookMeeting?: () => void;
  /** 打开等回复面板；from 是按下的这颗键（进详情时从它展开）。 */
  onOpenRequests: (from: Element) => void;
  onNavigate: Navigate;
}) {
  const review = m2Available && today ? reviewMonth(today) : null;
  return (
    <div className={s.tiles} role="group" aria-label="常用操作">
      {onBookMeeting ? <Button variant="primary" className={s.tile} onPress={onBookMeeting}>{MOTIFS.meeting}<Plus aria-hidden />约会议</Button> : null}
      <Button variant="tertiary" className={`${s.tile} ${s.plain}`} onPress={(event) => onOpenRequests(event.target as Element)}>
        {MOTIFS.waiting}等回复{waitingReplies ? <span className={s.count}>{waitingReplies}</span> : null}
      </Button>
      <Button variant="tertiary" className={`${s.tile} ${s.plain}`} data-origin={PROGRESS} onPress={(event) => onNavigate(PROGRESS, event.target as Element)}>{MOTIFS.progress}战场进展</Button>
      {radarUnread !== null ? (
        <Button variant="tertiary" className={`${s.tile} ${s.plain}`} data-origin={RADAR} onPress={(event) => onNavigate(RADAR, event.target as Element)}>
          {MOTIFS.radar}雷达{radarUnread > 0 ? <span className={s.unread} role="img" aria-label={`${radarUnread} 条未读`} /> : null}
        </Button>
      ) : null}
      {/* M2 是另一个应用：普通链接，样子和旁边的方块一样。 */}
      {review !== null ? <a href="/m2/" className={`${buttonVariants({ variant: "tertiary" })} ${s.tile} ${s.plain}`}>{review} 月复盘</a> : null}
    </div>
  );
}
