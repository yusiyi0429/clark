"use client";

/**
 * 成员首页顶行右边的快捷卡（样稿 home-layout-v9）：方块按钮，字居中——约会议、等回复、战场进展、雷达，复盘窗口期再多一个复盘。
 * 平时 2×2；多出复盘时 2 列 × 3 行，仍在同一个正方形里；主区窄时（见 home-plan 样式）排成一排小方块，放不下就换行。
 * 等回复进请求列表的「发出的」，右上角是条数；战场进展进原来那张战场进展页（/me/progress）。
 * 雷达只在本人雷达开着时出（首页数据里 radar 不为空），有未读信号时右上角红点，进我的雷达页（/me/radar）。
 * 复盘按公司时区的今天（计划里的 today）算：本月倒数第 3 天到月底复盘本月，下月 1–7 日复盘上个月，这段时间出一格去 M2 的链接，其余时间不出。
 */
import { Plus } from "lucide-react";
import { buttonVariants } from "@heroui/react";
import { Button } from "ts-design/primitives";
import type { Navigate } from "./planFormat";
import s from "@/styles/home-actions.module.css";

const REQUESTS = "/me/requests";
const PROGRESS = "/me/progress";
const RADAR = "/me/radar";

/** 复盘窗口开着时复盘的是哪个月；没开为 null。 */
export function reviewMonth(today: string): number | null {
  const [year, month, day] = today.split("-").map(Number);
  if (day <= 7) return month === 1 ? 12 : month - 1;
  return day >= new Date(Date.UTC(year, month, 0)).getUTCDate() - 2 ? month : null;
}

export function HomeActions({ waitingReplies, radarUnread, today, m2Available, onBookMeeting, onNavigate }: {
  waitingReplies: number;
  /** 本人雷达的未读条数；雷达关着（或首页数据还没读到）时为 null，不出雷达。 */
  radarUnread: number | null;
  /** 计划还没读到时为 null，这时不出复盘。 */
  today: string | null;
  m2Available: boolean;
  /** 工作台没有登录人时为空（测试桩），不出约会议。 */
  onBookMeeting?: () => void;
  onNavigate: Navigate;
}) {
  const review = m2Available && today ? reviewMonth(today) : null;
  return (
    <div className={s.tiles} role="group" aria-label="常用操作">
      {onBookMeeting ? <Button variant="primary" className={s.tile} onPress={onBookMeeting}><Plus aria-hidden />约会议</Button> : null}
      {/* data-origin 只写路径：关闭列表时外壳按路径找回这颗按钮。 */}
      <Button variant="tertiary" className={`${s.tile} ${s.plain}`} data-origin={REQUESTS} onPress={(event) => onNavigate(`${REQUESTS}?box=sent`, event.target as Element)}>
        等回复{waitingReplies ? <span className={s.count}>{waitingReplies}</span> : null}
      </Button>
      <Button variant="tertiary" className={`${s.tile} ${s.plain}`} data-origin={PROGRESS} onPress={(event) => onNavigate(PROGRESS, event.target as Element)}>战场进展</Button>
      {radarUnread !== null ? (
        <Button variant="tertiary" className={`${s.tile} ${s.plain}`} data-origin={RADAR} onPress={(event) => onNavigate(RADAR, event.target as Element)}>
          雷达{radarUnread > 0 ? <span className={s.unread} role="img" aria-label={`${radarUnread} 条未读`} /> : null}
        </Button>
      ) : null}
      {/* M2 是另一个应用：普通链接，样子和旁边的方块一样。 */}
      {review !== null ? <a href="/m2/" className={`${buttonVariants({ variant: "tertiary" })} ${s.tile} ${s.plain}`}>{review} 月复盘</a> : null}
    </div>
  );
}
