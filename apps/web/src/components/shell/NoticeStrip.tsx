"use client";

import { PanelLeft, Settings } from "lucide-react";
import { ContextMark, type ContextMarkKind } from "@/components/ContextMark";
import { HeroButton } from "@/components/HeroButton";
import { TianshuMark } from "@/components/TianshuMark";
import { useMountedDuringViewTransition } from "@/lib/viewTransition";
import s from "@/styles/notice-strip.module.css";

/**
 * 通知栏折成的窄条（clark `notice-strip.tsx`）：主区不是首页时出现，所有宽度一致。
 * 自上而下：首页、当前工作区标记（会议 / 月度打开时）、展开通知栏（有紧急事项时带红点）、配置。
 * 悬停不展开任何东西；按钮、⌘\ 与左缘滑动才展开。
 * 底部一格：clark 放锁屏；天枢前端不调用登出接口，沿用通知栏已有的「配置」入口。
 */
export function NoticeStrip({
  current,
  currentLabel,
  urgent,
  peekOpen,
  transitioning,
  onHome,
  onTogglePeek,
  onConfig,
}: {
  current: ContextMarkKind | null;
  currentLabel?: string;
  urgent: number;
  peekOpen: boolean;
  /** 通知栏 ⇄ 窄条转场期间，窄条承接通知栏的共享名。 */
  transitioning?: boolean;
  onHome: () => void;
  onTogglePeek: () => void;
  onConfig: () => void;
}) {
  const peekLabel = peekOpen ? "收起通知栏" : urgent ? `展开通知栏，${urgent} 条需要尽快处理` : "展开通知栏";
  const morphedIn = useMountedDuringViewTransition();
  return (
    <nav
      className={s.strip}
      aria-label="通知栏，已收起"
      data-testid="notice-strip"
      data-static={morphedIn}
      style={transitioning ? { viewTransitionName: "notice-rail" } : undefined}
    >
      <HeroButton variant="ghost" size="sm" isIconOnly type="button" className={s.home} onPress={onHome} aria-label="天枢，返回首页" title="返回首页">
        <TianshuMark className={s.mark} />
      </HeroButton>
      {current ? (
        <span className={s.current} aria-current="page" role="img" aria-label={currentLabel ? `当前：${currentLabel}` : "当前工作区"} title={currentLabel}>
          <ContextMark kind={current} className={s.currentMark} />
        </span>
      ) : null}
      <HeroButton
        variant="ghost"
        size="sm"
        isIconOnly
        type="button"
        className={s.bell}
        onPress={onTogglePeek}
        aria-expanded={peekOpen}
        aria-label={peekLabel}
        title={`${peekLabel}（⌘\\ 或 Ctrl+\\）`}
      >
        <PanelLeft size={20} strokeWidth={1.7} />
        {urgent > 0 ? <i className={s.badge} aria-hidden="true" /> : null}
      </HeroButton>
      <span className={s.bottom}>
        <HeroButton variant="ghost" size="sm" isIconOnly type="button" onPress={onConfig} aria-label="配置" title="配置">
          <Settings size={16} strokeWidth={1.8} />
        </HeroButton>
      </span>
    </nav>
  );
}
