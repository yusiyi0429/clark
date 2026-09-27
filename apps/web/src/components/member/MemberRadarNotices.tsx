"use client";

import { ChevronRight } from "lucide-react";
import { ContextMark } from "@/components/ContextMark";
import { HeroButton } from "@/components/HeroButton";
import { personalSignalHref, type MemberRadarBrief, type PersonalSignalBrief } from "@/components/radar/personalRadar";
import n from "@/styles/notifications.module.css";

type Navigate = (href: string, origin?: Element | null) => void;

export function noteworthySignals(radar: MemberRadarBrief | null): PersonalSignalBrief[] {
  return radar?.highlights.filter((signal) => !signal.state.read && !signal.state.dismissed && signal.relevance === 5) ?? [];
}

/** 首页摘要里非常相关且未读的信号，打开阅读页时标记已读并退出通知栏。 */
export function MemberRadarNotices({ signals, currentHref, onNavigate, onRead }: { signals: PersonalSignalBrief[]; currentHref?: string; onNavigate: Navigate; onRead: (id: string) => Promise<boolean> }) {
  if (!signals.length) return null;
  return <section className={n.card} data-slot="card" data-notice="radar" aria-label="雷达 · 值得注意">
    <header className={n.glassHeader}>
      <ContextMark kind="signal" className={n.glyph} />
      <span className={n.identity}><strong>雷达 · 值得注意<b className={n.count} aria-label={`${signals.length} 条信号`}>{signals.length}</b></strong></span>
    </header>
    <div className={n.tray}>
      {signals.map((signal) => {
        const href = personalSignalHref(signal.id);
        return <HeroButton key={signal.id} variant="ghost" size="sm" type="button" className={n.item}
          data-origin={href} data-tone="neutral" aria-current={currentHref === href ? "true" : undefined}
          aria-label={`阅读：${signal.source.title}`} onPress={(event) => {
            const origin = (event.target as Element).closest("[data-notice]");
            void onRead(signal.id).then((canNavigate) => { if (canNavigate) onNavigate(href, origin); });
          }}>
          <span className={n.mark} aria-hidden="true" />
          <span className={n.itemText}><span>{signal.source.title}</span><small>{signal.source.label}</small></span>
          <ChevronRight size={15} aria-hidden="true" />
        </HeroButton>;
      })}
    </div>
  </section>;
}
