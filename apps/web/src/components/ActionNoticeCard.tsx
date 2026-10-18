"use client";

/**
 * 一组能在卡上办完的通知（clark `dri/surface.tsx` 的「推动」那一组）：玻璃页头 + 一条条「标题行 + 卡上的处理」。
 * 办完的那一条原位写一行回执，1.3 秒后淡出（notice-actions.module.css 的 settle），再交给调用方从列表里拿掉。
 * CEO 的「需要你确认」和成员的执行事项提醒都用它；材质、标题行、圆点沿用通知栏那一份（notifications.module.css）。
 */

import { useEffect, useState } from "react";
import { Card as HeroCard } from "@heroui/react";
import { Check, ChevronRight } from "lucide-react";
import { ContextMark, type ContextMarkKind } from "./ContextMark";
import { HeroButton } from "./HeroButton";
import { NoticeActions, type NoticeButton, type NoticeReason } from "./NoticeActions";
import a from "@/styles/notice-actions.module.css";
import n from "@/styles/notifications.module.css";

export interface ActionNotice {
  id: string;
  title: string;
  /** 标题下面一行灰字：一两句话把事情说全，不必点进去。 */
  detail: string;
  tone?: "red" | "amber" | "neutral";
  /** 点标题行打开详情；没有详情页的就只是文字。 */
  onOpen?: (from: Element | null) => void;
  buttons: NoticeButton[];
  reason?: NoticeReason;
}

/** 回执停多久：和 settle 动画同长。 */
const RECEIPT_MS = 1300;

export function ActionNoticeCard({
  id,
  title,
  subtitle,
  mark,
  notices,
  onSettled,
}: {
  /** 通知栏里这一组的标识（data-notice，FLIP 动画按它对位置）。 */
  id: string;
  title: string;
  subtitle?: string;
  mark: ContextMarkKind;
  notices: ActionNotice[];
  /** 这一条办完、回执也淡出了：调用方从列表里拿掉（或重新拉取）。 */
  onSettled: (noticeId: string) => void;
}) {
  const [receipts, setReceipts] = useState<Record<string, string>>({});

  useEffect(() => {
    const ids = Object.keys(receipts);
    if (!ids.length) return;
    const timer = window.setTimeout(() => {
      ids.forEach((noticeId) => onSettled(noticeId));
      setReceipts((current) => Object.fromEntries(Object.entries(current).filter(([noticeId]) => !ids.includes(noticeId))));
    }, RECEIPT_MS);
    return () => window.clearTimeout(timer);
  }, [receipts, onSettled]);

  if (!notices.length) return null;
  const open = notices.filter((notice) => !(notice.id in receipts)).length;

  return (
    <HeroCard<"section"> render={(props) => <section {...props} />} className={n.card} data-notice={id} aria-label={title}>
      <HeroCard.Header<"header"> render={(props) => <header {...props} />} className={n.glassHeader}>
        <ContextMark kind={mark} className={n.glyph} />
        <span className={n.identity}>
          <strong>
            {title}
            <b className={n.count} aria-label={`${open} 项待处理`}>
              {open}
            </b>
          </strong>
          {subtitle ? <small>{subtitle}</small> : null}
        </span>
      </HeroCard.Header>
      <div className={n.tray}>
        {notices.map((notice) =>
          notice.id in receipts ? (
            <div key={notice.id} className={a.receipt} role="status">
              <Check size={15} aria-hidden="true" />
              <span>{receipts[notice.id] || "已处理"}</span>
            </div>
          ) : (
            <div key={notice.id} className={a.push}>
              <div className={a.openRow}>
                {notice.onOpen ? (
                  <HeroButton
                    variant="ghost"
                    size="sm"
                    data-ts-layout="true"
                    type="button"
                    className={n.item}
                    data-tone={notice.tone ?? "neutral"}
                    aria-label={`查看详情：${notice.title}`}
                    onPress={(event) => notice.onOpen?.((event.target as Element).closest("[data-notice]"))}
                  >
                    <span className={n.mark} aria-hidden="true" />
                    <span className={n.itemText}>
                      <span>{notice.title}</span>
                      {notice.detail ? <small>{notice.detail}</small> : null}
                    </span>
                    <ChevronRight size={15} aria-hidden="true" />
                  </HeroButton>
                ) : (
                  <div className={n.item} data-tone={notice.tone ?? "neutral"}>
                    <span className={n.mark} aria-hidden="true" />
                    <span className={n.itemText}>
                      <span>{notice.title}</span>
                      {notice.detail ? <small>{notice.detail}</small> : null}
                    </span>
                  </div>
                )}
              </div>
              <NoticeActions
                title={notice.title}
                buttons={notice.buttons}
                reason={notice.reason}
                onSettled={(text) => setReceipts((current) => ({ ...current, [notice.id]: text ?? "" }))}
              />
            </div>
          ),
        )}
      </div>
    </HeroCard>
  );
}
