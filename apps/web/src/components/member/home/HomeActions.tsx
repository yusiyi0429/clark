"use client";

/**
 * 成员首页顶行右边的快捷卡（样稿 home-layout-v9）：方块按钮，字居中——约会议、等回复、战场进展、雷达。
 * 2×2；主区窄时（见 home-plan 样式）排成一排小方块，放不下就换行。去 M2（复盘与拆解）的入口在通知栏（M2EntryNotice）。
 * 等回复在右侧浮出请求列表（先开「发出的」，面板由首页挂），右上角是条数；战场进展进原来那张战场进展页（/me/progress）。
 * 雷达只在本人雷达开着时出（首页数据里 radar 不为空），有未读信号时右上角红点，进我的雷达页（/me/radar）。
 * 四格右下角各一件釉色小物件（纯装饰，读屏不读），意思同按钮；悬停、键盘聚焦时动一下，见样式。
 */
import type { ReactNode } from "react";
import { Plus } from "lucide-react";
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
 * 战场进展、雷达照等回复的配法：后面一件淡紫蓝、前面一件白瓷带投影——战场进展是前后两座山丘，山头一面旗；雷达是前后两个圆盘，前面那个带两圈色环、一束扫过的光和一个光点。
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
        <linearGradient id="ha-prog-back" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#e7ebff" /><stop offset="1" stopColor="#c9d3f5" /></linearGradient>
        <linearGradient id="ha-prog-front" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#fff" /><stop offset="1" stopColor="#eef1f6" /></linearGradient>
        <filter id="ha-prog-shadow" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="3" stdDeviation="3" floodColor="#29334c" floodOpacity=".12" /></filter>
      </defs>
      <path d="M28 66c0-15 11-26 24-26s24 11 24 26a4 4 0 0 1-4 4H32a4 4 0 0 1-4-4z" fill="url(#ha-prog-back)" opacity=".8" />
      <rect x="31" y="14" width="4" height="36" rx="2" fill="#9aa6bb" />
      <path className={s.flag} d="M35 15h17c2.2 0 3 2.8 1.2 4L49 22.5l4.2 3.5c1.8 1.2 1 4-1.2 4H35z" fill="url(#ha-prog-back)" filter="url(#ha-prog-shadow)" />
      <path d="M6 72c0-16 12-28 27-28s27 12 27 28a4 4 0 0 1-4 4H10a4 4 0 0 1-4-4z" fill="url(#ha-prog-front)" filter="url(#ha-prog-shadow)" />
    </Motif>
  ),
  radar: (
    <Motif>
      <defs>
        <linearGradient id="ha-radar-back" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#e7ebff" /><stop offset="1" stopColor="#c9d3f5" /></linearGradient>
        <linearGradient id="ha-radar-front" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#fff" /><stop offset="1" stopColor="#eef1f6" /></linearGradient>
        <linearGradient id="ha-radar-beam" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stopColor="#c9d3f5" /><stop offset="1" stopColor="#e7ebff" stopOpacity=".3" /></linearGradient>
        <filter id="ha-radar-shadow" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="3" stdDeviation="3" floodColor="#29334c" floodOpacity=".12" /></filter>
      </defs>
      <circle cx="50" cy="32" r="20" fill="url(#ha-radar-back)" opacity=".8" />
      <circle cx="36" cy="48" r="28" fill="url(#ha-radar-front)" filter="url(#ha-radar-shadow)" />
      <circle cx="36" cy="48" r="19" fill="#eef1f6" />
      <circle cx="36" cy="48" r="10" fill="#e7ebff" />
      <path className={s.sweep} d="M36 48V20a28 28 0 0 1 24.2 14z" fill="url(#ha-radar-beam)" />
      <circle cx="47" cy="34" r="3" fill="#9aa6bb" />
    </Motif>
  ),
};

export function HomeActions({ waitingReplies, radarUnread, onBookMeeting, onOpenRequests, onNavigate }: {
  waitingReplies: number;
  /** 本人雷达的未读条数；雷达关着（或首页数据还没读到）时为 null，不出雷达。 */
  radarUnread: number | null;
  /** 工作台没有登录人时为空（测试桩），不出约会议。 */
  onBookMeeting?: () => void;
  /** 打开等回复面板；from 是按下的这颗键（进详情时从它展开）。 */
  onOpenRequests: (from: Element) => void;
  onNavigate: Navigate;
}) {
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
    </div>
  );
}
