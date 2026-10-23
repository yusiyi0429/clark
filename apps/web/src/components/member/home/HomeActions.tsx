"use client";

/**
 * 成员首页顶行右边的快捷卡（样稿 home-layout-v9）：方块按钮，字居中——约会议、等回复、战场进展、雷达，复盘窗口期再多一个复盘。
 * 平时 2×2；多出复盘时 2 列 × 3 行，仍在同一个正方形里；主区窄时（见 home-plan 样式）排成一排小方块，放不下就换行。
 * 等回复在右侧浮出请求列表（先开「发出的」，面板由首页挂），右上角是条数；战场进展进原来那张战场进展页（/me/progress）。
 * 雷达只在本人雷达开着时出（首页数据里 radar 不为空），有未读信号时右上角红点，进我的雷达页（/me/radar）。
 * 复盘按公司时区的今天（计划里的 today）算：本月倒数第 3 天到月底复盘本月，下月 1–7 日复盘上个月，这段时间出一格去 M2 的链接，其余时间不出。
 * 前四格右下角各一枚简笔花纹（纯装饰，读屏不读），意思同按钮；悬停、键盘聚焦时动一下，见样式。
 */
import type { ReactNode } from "react";
import { Plus } from "lucide-react";
import { buttonVariants } from "@heroui/react";
import { Button } from "ts-design/primitives";
import type { Navigate } from "./planFormat";
import s from "@/styles/home-actions.module.css";

const PROGRESS = "/me/progress";
const RADAR = "/me/radar";

/** 花纹画在 48×48 里，线宽、颜色、大小都由样式给。 */
function Motif({ children }: { children: ReactNode }) {
  return <svg className={s.motif} viewBox="0 0 48 48" aria-hidden="true" focusable="false">{children}</svg>;
}

/** 约会议：一页日历带个小钟；等回复：带省略号的气泡；战场进展：山头一面旗，一条小路往上；雷达：三道弧和一根扫描线。 */
const MOTIFS = {
  meeting: (
    <Motif>
      <g className={s.page}>
        <path d="M24 36H8a3 3 0 0 1-3-3V14a3 3 0 0 1 3-3h20a3 3 0 0 1 3 3v12" />
        <path d="M5 18h26M11 8v6M25 8v6" />
      </g>
      <circle cx="34" cy="35" r="7.5" />
      <path className={s.hands} d="M34 31v4l2.5 2" />
    </Motif>
  ),
  waiting: (
    <Motif>
      <path d="M12 12h22a6 6 0 0 1 6 6v10a6 6 0 0 1-6 6H22l-7 6v-6h-3a6 6 0 0 1-6-6V18a6 6 0 0 1 6-6z" />
      <circle className={s.dot} cx="16" cy="23" r="1.2" />
      <circle className={s.dot} cx="23" cy="23" r="1.2" />
      <circle className={s.dot} cx="30" cy="23" r="1.2" />
    </Motif>
  ),
  progress: (
    <Motif>
      <path d="M2 43Q22 24 47 38" />
      <path className={s.trail} d="M12 44C20 43 22 40 18 38S20 34 25 33.5" />
      <path d="M26 32V11" />
      <path className={s.flag} d="M26 12c3-1.5 6 1.5 10 0v7c-4 1.5-7-1.5-10 0" />
    </Motif>
  ),
  radar: (
    <Motif>
      <path d="M32 41a9 9 0 0 1 9-9M23 41a18 18 0 0 1 18-18M14 41a27 27 0 0 1 27-27" />
      <path className={s.sweep} d="M41 41 22 22" />
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
