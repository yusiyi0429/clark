"use client";

/**
 * 成员首页左上的操作区（样稿 home-layout-v4）：约会议、等回复、战场进展、M 月复盘，原「参与的战场」的位置。
 * 复盘按公司时区的今天（计划里的 today）算：本月倒数第 3 天到月底复盘本月，下月 1–7 日复盘上个月，这段时间能点，进 M2；
 * 其余时间置灰，写下次开的日子。
 */
import { Plus } from "lucide-react";
import { Button } from "ts-design/primitives";
import type { Navigate } from "./planFormat";
import s from "@/styles/home-actions.module.css";

/** 复盘的是哪个月；opensOn 是下次开的日子（「10/29」），开着时为 null。 */
export function reviewWindow(today: string): { month: number; opensOn: string | null } {
  const [year, month, day] = today.split("-").map(Number);
  if (day <= 7) return { month: month === 1 ? 12 : month - 1, opensOn: null };
  const start = new Date(Date.UTC(year, month, 0)).getUTCDate() - 2;
  return { month, opensOn: day >= start ? null : `${month}/${start}` };
}

export function HomeActions({ battlefieldHref, waitingReplies, today, m2Available, onBookMeeting, onNavigate }: {
  battlefieldHref: string | null;
  waitingReplies: number;
  /** 计划还没读到时为 null，这时不出复盘。 */
  today: string | null;
  m2Available: boolean;
  /** 工作台没有登录人时为空（测试桩），不出约会议。 */
  onBookMeeting?: () => void;
  onNavigate: Navigate;
}) {
  const review = m2Available && today ? reviewWindow(today) : null;
  return (
    <div className={s.actions} role="group" aria-label="常用操作">
      {onBookMeeting ? <Button variant="primary" size="sm" onPress={onBookMeeting}><Plus aria-hidden />约会议</Button> : null}
      <Button variant="tertiary" size="sm" className={s.pill} data-origin="/me/requests" onPress={(event) => onNavigate("/me/requests", event.target as Element)}>
        等回复{waitingReplies ? <span className={s.count}>{waitingReplies}</span> : null}
      </Button>
      {battlefieldHref ? <Button variant="tertiary" size="sm" className={s.pill} data-origin={battlefieldHref} onPress={(event) => onNavigate(battlefieldHref, event.target as Element)}>战场进展</Button> : null}
      {review ? (
        <Button variant="tertiary" size="sm" className={s.pill} isDisabled={review.opensOn !== null} onPress={() => window.location.assign("/m2/")}>
          {review.month} 月复盘{review.opensOn ? <span className={s.opens}>{review.opensOn} 开</span> : null}
        </Button>
      ) : null}
    </div>
  );
}
